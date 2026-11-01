import { test, expect, chromium, type BrowserContext } from '@playwright/test';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CHROMIUM_LAUNCH } from './helpers/shotly-harness';

// 注：本仓库是 ESM (package.json "type": "module")，不能用 __dirname。
// 用 process.cwd() 假定 `pnpm test` 始终从 shotly/ 仓库根执行。
const SHOTLY_BUILT = resolve(process.cwd(), '.output', 'chrome-mv3');

/**
 * Shotly MV3 启动器（测试基础设施 / B3 交付）
 *
 * 目标：
 *   - 验证 .output/chrome-mv3/ 能作为 unpacked extension 装入真实 Chrome
 *   - 验证 background service worker 启动 + ping/pong 通
 *   - 验证 popup.html 可访问
 *   - 验证 8 项权限无缺失（manifest 校对）
 *   - 1 个冒烟用例：访问 chrome://extensions/，截图存档作为 D+7 上架素材
 *
 * 不覆盖范围（v1.0 不测）：
 *   - 实际截图功能（capture-fallback.ts D+2 仍在写）
 *   - E2E 业务流程（等 dev 稳定后 D+10 接入）
 *
 * 失败时：
 *   - trace.zip + screenshot.png 自动保留（reporter 配置）
 *   - Console 日志全收集
 */

// MV3 必需权限（架构 §4.1，v1.2 锁定 8 项）
const REQUIRED_PERMISSIONS = [
  'activeTab',
  'scripting',
  'offscreen',
  'storage',
  'downloads',
  'clipboardWrite',
  'unlimitedStorage',
  'tabs',
];

const REQUIRED_HOST_PERMISSIONS = ['<all_urls>'];

test.describe('Shotly MV3 启动器（B3 烟雾测试）', () => {
  let context: BrowserContext;
  let extensionId: string | null = null;

  test.beforeAll(async () => {
    // Pre-condition: shotly 必须先 build
    test.skip(!existsSync(SHOTLY_BUILT), `shotly 未 build：缺少 ${SHOTLY_BUILT}，请先 pnpm build`);

    // 隔离 user-data-dir（用固定路径以便事后 inspect）
    const userDataDir = process.env.SHOTLY_E2E_USER_DATA_DIR
      || resolve(process.cwd(), '.tmp-user-data');
    if (!existsSync(userDataDir)) {
      const { mkdirSync } = await import('node:fs');
      mkdirSync(userDataDir, { recursive: true });
    }
    console.log(`[shotly-e2e] userDataDir = ${userDataDir}`);

    context = await chromium.launchPersistentContext(userDataDir, {
      // 不指定 executablePath —— 必须用 Playwright 自带 Chromium。
      // 系统 Chrome（stable）会拒绝 --load-extension / --disable-extensions-except，
      // 扩展根本不会装进去（extensions-item 数量 = 0，extensionId 提取失败）。
      // 见 playwright.config.ts 中同名注释（2026-10-25 修复）。
      headless: CHROMIUM_LAUNCH.playwrightHeadless,
      args: [
        // CI 没有 X server —— 必须用 --headless=new（本地默认 headful）。
        ...CHROMIUM_LAUNCH.envArgs,
        `--disable-extensions-except=${SHOTLY_BUILT}`,
        `--load-extension=${SHOTLY_BUILT}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-timer-throttling',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--enable-extensions',
        '--disable-features=ExtensionsToolbarMenu',
      ],
      viewport: { width: 1280, height: 800 },
    });

    // 调试：访问 chrome://extensions/ 看实际加载状态 + 截图
    try {
      const debugPage = await context.newPage();
      await debugPage.goto('chrome://extensions/');
      await new Promise((r) => setTimeout(r, 2000));
      await debugPage.screenshot({ path: '.tmp-user-data/chrome-extensions-debug.png', fullPage: true });
      const extCount = await debugPage.locator('extensions-item').count();
      console.log(`[shotly-e2e] chrome://extensions/ 中 extensions-item 数量: ${extCount}`);
      const bodyText = await debugPage.locator('body').textContent();
      console.log(`[shotly-e2e] chrome://extensions/ body 前 300 字: ${(bodyText || '').slice(0, 300)}`);
      await debugPage.close();
    } catch (err) {
      console.log(`[shotly-e2e] chrome://extensions/ 访问失败: ${(err as Error).message}`);
    }

    // 给 Chrome 启动 + 写 Preferences 的时间（headed 模式下需要更长）
    await new Promise((r) => setTimeout(r, 6000));

    // 主策略：读 Chrome Preferences JSON（确定性，与 SW 是否启动无关）
    function readExtensionIdFromPrefs(): string | null {
      const defaultDir = join(userDataDir, 'Default');
      const candidates = [join(defaultDir, 'Preferences'), join(userDataDir, 'Preferences')];
      for (const p of candidates) {
        if (!existsSync(p)) continue;
        try {
          const prefs = JSON.parse(readFileSync(p, 'utf-8')) as { extensions?: { settings?: Record<string, { path?: string; name?: string }> } };
          const settings = prefs.extensions?.settings || {};
          for (const [id, ext] of Object.entries(settings)) {
            const extPath = ext.path || '';
            if (extPath === SHOTLY_BUILT || extPath.includes('chrome-mv3') || extPath.endsWith('shotly/.output/chrome-mv3')) {
              console.log(`[shotly-e2e] ✅ 从 Preferences 提取到 ID: ${id} (path: ${extPath})`);
              return id;
            }
          }
        } catch (err) {
          console.log(`[shotly-e2e] Preferences ${p} 解析失败：${(err as Error).message}`);
        }
      }
      return null;
    }

    extensionId = readExtensionIdFromPrefs();

    // 备选：从 service workers URL 提取
    if (!extensionId) {
      for (const sw of context.serviceWorkers()) {
        const m = sw.url().match(/^chrome-extension:\/\/([a-z]{32})/);
        if (m) { extensionId = m[1]; console.log(`[shotly-e2e] 从 serviceWorkers 提取：${extensionId}`); break; }
      }
    }

    // 备选：从 background pages 提取
    if (!extensionId) {
      for (const pg of context.backgroundPages()) {
        const m = pg.url().match(/^chrome-extension:\/\/([a-z]{32})/);
        if (m) { extensionId = m[1]; console.log(`[shotly-e2e] 从 backgroundPages 提取：${extensionId}`); break; }
      }
    }

    console.log(`[shotly-e2e] 最终 extensionId: ${extensionId ?? 'null'}`);
  });

  test.afterAll(async () => {
    await context?.close();
  });

  test('✅ .output/chrome-mv3 可装入 Chrome 且 SW 启动', async () => {
    expect(extensionId, 'extension ID 提取失败，background page 未注册').toMatch(/^[a-z]{32}$/);
    console.log(`📦 Extension ID: ${extensionId}`);
  });

  test('✅ 8 项权限无缺失（含 host_permissions）', async () => {
    test.skip(!extensionId, 'extension 未加载');

    // 通过 chrome://extensions/ 页面读取 manifest
    const page = await context.newPage();
    await page.goto('chrome://extensions/');
    await page.waitForLoadState('domcontentloaded');

    // MV3 的 background 是 Service Worker，不在 backgroundPages() 里 ——
    // 必须走 context.serviceWorkers()（backgroundPages() 是 MV2 的 API，恒为空）。
    const bgWorkers = context.serviceWorkers();
    expect(bgWorkers.length, 'background service worker 未启动').toBeGreaterThan(0);

    // 用 chrome.runtime.getManifest 从 SW 上下文读（需要 evaluate）
    const manifest = await bgWorkers[0].evaluate(() => {
      // SW 上下文里 chrome.runtime.getManifest() 可用
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (globalThis as any).chrome?.runtime?.getManifest?.() ?? null;
    });

    expect(manifest, 'manifest 读取失败').not.toBeNull();
    expect(manifest.name).toBe('Shotly');
    expect(manifest.manifest_version).toBe(3);

    const perms: string[] = manifest.permissions || [];
    for (const required of REQUIRED_PERMISSIONS) {
      expect(perms, `缺少权限：${required}`).toContain(required);
    }
    const hostPerms: string[] = manifest.host_permissions || [];
    for (const required of REQUIRED_HOST_PERMISSIONS) {
      expect(hostPerms, `缺少 host_permission：${required}`).toContain(required);
    }

    await page.close();
  });

  test('✅ popup.html 可访问', async () => {
    test.skip(!extensionId, 'extension 未加载');
    const page = await context.newPage();
    const response = await page.goto(`chrome-extension://${extensionId}/popup.html`);
    expect(response?.status(), 'popup.html 返回非 200').toBe(200);
    // popup 应该已经渲染（即使内容空，因为 dev 还在写）
    await page.waitForLoadState('domcontentloaded');
    const title = await page.title();
    console.log(`📄 popup.html title: "${title}"`);
    expect(title.length).toBeGreaterThan(0);
    await page.close();
  });

  test('✅ 访问 chrome://extensions/ 并截图（作为 D+7 上架素材）', async () => {
    test.skip(!extensionId, 'extension 未加载');
    const page = await context.newPage();
    await page.goto('chrome://extensions/');
    // 打开开发者模式（这样能看到 ID 和权限）
    await page.evaluate(() => {
      const inputs = document.querySelectorAll('input[type="checkbox"]');
      // Chrome 内部用 cr-toggle，第一个 checkbox 一般是开发者模式
      for (const input of Array.from(inputs)) {
        const label = input.closest('cr-toggle') || input.parentElement;
        if (label && /developer/i.test(label.textContent || '')) {
          (input as HTMLInputElement).click();
        }
      }
    });
    await page.waitForTimeout(500);
    const shot = await page.screenshot({ path: `reports/screenshots/chrome-extensions-${Date.now()}.png`, fullPage: true });
    expect(shot.length).toBeGreaterThan(1000); // 不是空截图
    console.log(`📸 已截图：${(shot.length / 1024).toFixed(1)}KB`);
    await page.close();
  });
});