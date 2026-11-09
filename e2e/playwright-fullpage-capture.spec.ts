/**
 * Shotly 全流程截图 E2E（D+2 wiring 验证 / 自驱测试）
 *
 * 目标：跑通 popup → bg → content → offscreen → blob URL 全链路，
 *      并断言 popup 显示的尺寸/大小是真实数字。
 *
 * 测试模式（通过 popup URL 参数驱动）：
 *   - chrome-extension://<id>/popup.html?testTabId=<N>&testAuto=1
 *   - testTabId：覆盖 active-tab lookup，注入要截图的目标 tab
 *   - testAuto=1：popup 挂载后自动调用 captureFull()
 *
 * 为什么不点 toolbar icon：Playwright 无法稳定触发 toolbar 弹出 popup。
 */

import { test, expect, chromium, type BrowserContext, type ConsoleMessage } from '@playwright/test';
import { mkdtempSync, existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CHROMIUM_LAUNCH, assertBuildIsFresh } from './helpers/shotly-harness';

const SHOTLY_BUILT = resolve(process.cwd(), '.output', 'chrome-mv3');
const TEST_PAGE_DIR = resolve(process.cwd(), 'e2e', 'test-pages');
const TEST_PAGE_FILE = 'long-page.html';

interface ConsoleSink {
  push: (line: string) => void;
  dump: () => string;
}
function makeConsoleSink(label: string): ConsoleSink {
  const lines: string[] = [];
  return {
    push(line) {
      lines.push(`[${label}] ${line}`);
      // Tee to test stdout in real-time
      // eslint-disable-next-line no-console
      console.log(line);
    },
    dump() {
      return lines.join('\n');
    },
  };
}

async function startStaticServer(): Promise<{ url: string; close: () => Promise<void> }> {
  // Node 18+ ships with http; no deps needed.
  const http = await import('node:http');
  const server = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    const file = url === '/' || url === `/${TEST_PAGE_FILE}` ? TEST_PAGE_FILE : url.slice(1);
    const path = join(TEST_PAGE_DIR, file);
    if (!existsSync(path)) {
      res.statusCode = 404;
      res.end(`Not found: ${file}`);
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(readFileSync(path, 'utf-8'));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const port = (server.address() as any).port as number;
  return {
    url: `http://127.0.0.1:${port}/${TEST_PAGE_FILE}`,
    // ⚠️ `server.close()` alone HANGS: Chrome keeps the HTTP keep-alive
    // socket open for minutes, and `close()` waits for in-flight
    // connections to drain. The afterAll hook then times out and the
    // whole test is reported as failed even though the capture worked.
    // `closeAllConnections()` (Node 18.2+) force-drops them first.
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

function readExtensionIdFromPrefs(userDataDir: string): string | null {
  // Chrome writes the 32-char extension ID into multiple places:
  //   extensions.settings.<id>.path           ← 80% of the time
  //   extensions.commands.<key>.extension     ← also includes id when commands registered
  //   extensions.alerts.initialized            ← not the id but still references
  // We scan all 32-char keys under extensions.* and verify the path matches.
  const defaultDir = join(userDataDir, 'Default');
  const candidates = [join(defaultDir, 'Preferences'), join(userDataDir, 'Preferences')];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const prefs = JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const findIds = (obj: any, into: Set<string>): void => {
        if (!obj || typeof obj !== 'object') return;
        for (const [k, v] of Object.entries(obj)) {
          if (typeof k === 'string' && /^[a-z]{32}$/.test(k)) into.add(k);
          if (v && typeof v === 'object') findIds(v, into);
        }
      };
      const ids = new Set<string>();
      findIds(prefs, ids);
      // Heuristic: any 32-char key whose command / settings points to chrome-mv3
      const settings = (prefs.extensions as Record<string, unknown> | undefined)?.settings as
        | Record<string, { path?: string }>
        | undefined;
      if (settings) {
        for (const [id, ext] of Object.entries(settings)) {
          const extPath = (ext.path || '').replace(/\\/g, '/');
          if (
            extPath.endsWith('shotly/.output/chrome-mv3') ||
            extPath.includes('chrome-mv3')
          ) {
            return id;
          }
        }
      }
      // Fallback: pick the first 32-char id we found
      if (ids.size > 0) return Array.from(ids)[0];
    } catch {
      // keep trying
    }
  }
  return null;
}

test.describe('Shotly 全流程截图 E2E', () => {
  let context: BrowserContext;
  let extensionId: string;
  let staticServer: { url: string; close: () => Promise<void> };
  let userDataDir: string;
  const swLogs: ConsoleSink = makeConsoleSink('SW');
  const popupLogs: ConsoleSink = makeConsoleSink('POPUP');

  test.beforeAll(async () => {
    // ⚠️ 硬失败而不是 test.skip —— 「没 build 就静默跳过」会让门禁变绿，
    //    而它其实什么都没测。构建产物比源码旧也是同理（测的是旧代码）。
    assertBuildIsFresh(SHOTLY_BUILT);
    userDataDir = mkdtempSync(join(tmpdir(), 'shotly-e2e-'));
    mkdirSync(userDataDir, { recursive: true });

    staticServer = await startStaticServer();
    // eslint-disable-next-line no-console
    console.log(`[shotly-e2e] static server: ${staticServer.url}`);

    context = await chromium.launchPersistentContext(userDataDir, {
      // 必须用 Playwright 自带 Chromium（Chrome for Testing）：Chrome stable
      // 拒绝 --disable-extensions-except / --load-extension，扩展加载不到。
      // Chromium 二进制路径由 Playwright 自动管理。
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

    // 给 SW 启动 + Chrome 写 Preferences 的时间（headless=false on macOS）
    await new Promise((r) => setTimeout(r, 8_000));

    // 扩展 ID 提取：从 SW 的 URL 取（chrome-extension://<32位id>/background.js）
    // —— 这是最可靠的来源。Preferences 文件的写入时机不确定，
    // 在不同机器/负载下可能永远读不到（2026-10-25 修复）。
    for (let i = 0; i < 15 && !extensionId; i++) {
      for (const sw of context.serviceWorkers()) {
        const m = sw.url().match(/^chrome-extension:\/\/([a-z]{32})/);
        if (m) { extensionId = m[1]; break; }
      }
      if (!extensionId) await new Promise((r) => setTimeout(r, 1_000));
    }
    if (!extensionId) {
      // 备选：Preferences
      extensionId = readExtensionIdFromPrefs(userDataDir) || '';
      if (extensionId) console.log('[shotly-e2e] extensionId 来自 Preferences');
    }
    if (!extensionId) {
      // 最后兜底：直接 ls extension 目录看 Chrome 是否至少加载了
      try {
        const dirEntries = readFileSync(join(userDataDir, 'Default', 'Preferences'), 'utf-8');
        console.log(`[shotly-e2e] Preferences ext keys: ${dirEntries.match(/"[a-z]{32}"/g)?.slice(0, 5)}`);
      } catch {}
    }
    expect(extensionId, 'extension ID 提取失败').toMatch(/^[a-z]{32}$/);
    // eslint-disable-next-line no-console
    console.log(`[shotly-e2e] extensionId = ${extensionId}`);

    // 拦截 SW console（后面 test 里 SW 可能进进出出，都抳到 swLogs）
    //
    // ⚠️ 不能用 WeakSet<object> 去重（2026-10-26 修复）：
    // `context.on('serviceworker', ...)` 回调拿到的 worker 对象，和
    // `context.serviceWorkers()` 遍历出来的 worker 对象，可能是**同一个
    // worker 的两个不同 JS wrapper**。WeakSet 按对象身份去重，对它们
    // 判为两个不同的对象 → 每个 worker 挂了两个 console 监听器 →
    // 每条日志被打印两遍。
    //
    // 正确的去重键是 **service worker 的 URL**（对同一个扩展而言，
    // 同一个 SW 实例的 URL 是唯一的）。
    const swConsoleWiredUrls = new Set<string>();
    const wireSwConsole = (sw: { on: (e: string, cb: (m: { type: () => string; text: () => string }) => void) => void; url: () => string }) => {
      const url = sw.url();
      if (swConsoleWiredUrls.has(url)) return;
      swConsoleWiredUrls.add(url);
      sw.on('console', (msg: { type: () => string; text: () => string }) => {
        swLogs.push(`[${msg.type()}] ${msg.text()}`);
      });
    };
    context.on('serviceworker', (sw) => {
      wireSwConsole(sw as unknown as Parameters<typeof wireSwConsole>[0]);
      swLogs.push(`SW attached: ${sw.url()}`);
    });
    for (const sw of context.serviceWorkers()) {
      wireSwConsole(sw as unknown as Parameters<typeof wireSwConsole>[0]);
    }
  });

  test.afterAll('tear down', async () => {
    /**
     * ⚠️ Playwright 1.61 改了 hook 的签名。
     *
     * 旧式 `afterAll(hook, timeout)` 还能跑，但 **timeout 会被静默忽略** ——
     * 实测：传 50ms 超时、hook 跑 800ms，照样绿。
     * 新签名是 `afterAll(title, hook)`，hook 自己的超时用 `test.setTimeout()` 设。
     *
     * 不改的后果：类型检查直接报错（`pnpm compile` 挂 → CI 挂），
     * 而且就算跑了，超时也是形同虚设。
     */
    test.setTimeout(60_000);
    await staticServer?.close();
    await closeContextSafely(context);
    // 保留日志到文件供事后 inspect
    const logPath = resolve(process.cwd(), 'reports', 'e2e-logs.txt');
    mkdirSync(resolve(process.cwd(), 'reports'), { recursive: true });
    writeFileSync(logPath, `=== SW CONSOLE ===\n${swLogs.dump()}\n\n=== POPUP CONSOLE ===\n${popupLogs.dump()}\n`);
  });

  test('popup 点击 → bg → content → offscreen → blob URL 全链路', async () => {
    test.setTimeout(180_000);
    expect(extensionId, 'extension ID 缺失').toBeTruthy();

    // 1) 打开测试页（常规页面，要被截图的 target）
    const targetPage = await context.newPage();
    await targetPage.goto(staticServer.url);
    await targetPage.waitForLoadState('domcontentloaded');
    const targetTabId = await targetPage.evaluate(() => {
      // 通过 CDP 已经没接口直接拿 tabId；用 title 二次确认
      return document.title;
    });
    // eslint-disable-next-line no-console
    console.log(`[shotly-e2e] target page title: ${targetTabId}`);

    // 等 content script 真的注入完再往下走。
    // content script 走的是 `run_at: document_idle`，不一定在 goto 返回时
    // 就绪；不等就会偶发地 “port 连不上”。
    await targetPage.waitForSelector('html[data-shotly-content="ready"]', {
      timeout: 15_000,
    });
    // eslint-disable-next-line no-console
    console.log('[shotly-e2e] content script ready marker detected');

    // 2) 打开 popup 作为常规 tab，注入 testUrlPattern
    // popup 内部用 chrome.tabs.query({url: testUrlPattern}) 找目标 tab。
    // capture 由测试手动触发（不依靠 testAuto），避免任何重载/重挂载副作用。
    const popupUrl = `chrome-extension://${extensionId}/popup.html?testUrlPattern=${encodeURIComponent(
      staticServer.url.replace(/\/[^/]*$/, '/*'),
    )}`;
    // eslint-disable-next-line no-console
    console.log(`[shotly-e2e] popup url: ${popupUrl}`);

    const popupPage = await context.newPage();
    popupPage.on('console', (msg: ConsoleMessage) => popupLogs.push(`[${msg.type()}] ${msg.text()}`));
    popupPage.on('pageerror', (err) => popupLogs.push(`[pageerror] ${err.message}`));
    await popupPage.goto(popupUrl);
    await popupPage.waitForLoadState('domcontentloaded');

    // 等 Vue 挂载并暴露 __shotlyTest
    await popupPage.waitForFunction(() => !!(window as unknown as { __shotlyTest?: unknown }).__shotlyTest);

    // 手动触发截图（避免 testAuto + 多重挂载造成双重启动）
    await popupPage.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__shotlyTest.capture();
    });

    // 3) 等待 popup 状态变为 done（最坏 90s）
    const status = await waitForStatus(popupPage, 'done', 90_000);
    expect(status, `popup 未在 90s 内达到 done，实际状态=${status}`).toBe('done');

    // 4) 读取 result，断言 byteSize/width/height 是真实数字
    const result = await popupPage.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const w = window as any;
      return w.__shotlyTest?.getResult?.() ?? null;
    });
    // eslint-disable-next-line no-console
    console.log('[shotly-e2e] popup result:', result);

    expect(result, 'popup result 为 null').not.toBeNull();
    expect(typeof result.byteSize, `byteSize 类型错: ${typeof result.byteSize} = ${result.byteSize}`).toBe('number');
    expect(Number.isFinite(result.byteSize), `byteSize 不是有限数: ${result.byteSize}`).toBe(true);
    expect(result.byteSize, `byteSize 太小: ${result.byteSize}`).toBeGreaterThan(5_000);
    expect(typeof result.width, `width 类型错: ${typeof result.width} = ${result.width}`).toBe('number');
    expect(Number.isFinite(result.width), `width 不是有限数: ${result.width}`).toBe(true);
    expect(result.width, `width 应为正数: ${result.width}`).toBeGreaterThan(0);
    expect(typeof result.height, `height 类型错: ${typeof result.height} = ${result.height}`).toBe('number');
    expect(Number.isFinite(result.height), `height 不是有限数: ${result.height}`).toBe(true);
    expect(result.height, `height 应 > 一屏（800px）: ${result.height}`).toBeGreaterThan(800);
    expect(typeof result.blobUrl, `blobUrl 类型错`).toBe('string');
    expect(result.blobUrl, 'blobUrl 不应为空').toMatch(/^blob:/);

    // 5) 把真实捕获的 PNG 落盘
    //
    // 商店素材必须来自真实 Chrome 运行结果，所以这里把 popup 里的
    // blob URL 拉回 Node 侧写成真 PNG，而不是 mockup。
    // 同时它也是最有价值的断言物：如果 stitch 的几何算错了
    // （例如 crop 偏移是 NaN），画出来的就是一张空白图——
    // 肉眼一看就知道，而 byteSize 这类数字断言发现不了。
    const capturedDataUrl = await popupPage.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const w = window as any;
      const url = w.__shotlyTest?.getResult?.()?.blobUrl as string | undefined;
      if (!url) return null;
      const res = await fetch(url);
      const blob = await res.blob();
      return await new Promise<string>((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result));
        fr.onerror = () => reject(new Error('FileReader failed'));
        fr.readAsDataURL(blob);
      });
    });
    expect(capturedDataUrl, '未能从 blob URL 读回捕获内容').not.toBeNull();
    const shotDir = resolve(process.cwd(), 'reports', 'screenshots');
    mkdirSync(shotDir, { recursive: true });
    writeFileSync(
      join(shotDir, 'e2e-capture.png'),
      Buffer.from(String(capturedDataUrl).split(',')[1] ?? '', 'base64'),
    );
    // eslint-disable-next-line no-console
    console.log(`[shotly-e2e] capture written to reports/screenshots/e2e-capture.png`);

    // 6) 内容断言：捕获图不能是空白/纯色。
    //
    // ⚠️ 这一条比 byteSize 断言重要得多：stitch 的几何算错时
    // （crop 偏移是 NaN）`drawImage` 会静默失败，画出一张纯白图——
    // 而纯白图的 PNG 仍然有 100KB+，任何只看数字的断言都会通过。
    // 2026-10-26 实际踩中过这个坑：E2E 绿了，产物是空白图。
    const contentStats = await popupPage.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const w = window as any;
      const url = w.__shotlyTest?.getResult?.()?.blobUrl as string | undefined;
      if (!url) return null;
      const bitmap = await createImageBitmap(await (await fetch(url)).blob());
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return null;
      ctx.drawImage(bitmap, 0, 0);
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const colors = new Set<number>();
      let nonWhite = 0;
      let total = 0;
      // 抽样：每隔 31 个像素取一个，避免全量扫描拖慢测试。
      for (let i = 0; i < data.length; i += 4 * 31) {
        total += 1;
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        if (!(r > 245 && g > 245 && b > 245)) nonWhite += 1;
        colors.add(((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3));
      }

      // 逐横向带统计：用来抓「中间某一段没画上」这种局部缺失。
      // 全图 nonWhiteRatio 高不代表每一段都有内容 —— 一段空白会被
      // 其他有内容的段稀释掉。
      const bandHeight = 400;
      const bandCount = Math.ceil(canvas.height / bandHeight);
      const bands: number[] = [];
      for (let b = 0; b < bandCount; b += 1) {
        const y0 = b * bandHeight;
        const h = Math.min(bandHeight, canvas.height - y0);
        if (h <= 0) break;
        const band = ctx.getImageData(0, y0, canvas.width, h).data;
        let bandNonWhite = 0;
        let bandTotal = 0;
        for (let i = 0; i < band.length; i += 4 * 31) {
          bandTotal += 1;
          const r = band[i];
          const g = band[i + 1];
          const b = band[i + 2];
          if (!(r > 245 && g > 245 && b > 245)) bandNonWhite += 1;
        }
        bands.push(bandTotal > 0 ? bandNonWhite / bandTotal : 0);
      }

      return {
        width: bitmap.width,
        height: bitmap.height,
        uniqueColors: colors.size,
        nonWhiteRatio: total > 0 ? nonWhite / total : 0,
        bands,
      };
    });
    // eslint-disable-next-line no-console
    console.log('[shotly-e2e] capture content stats:', contentStats);
    expect(contentStats, '未能分析捕获图内容').not.toBeNull();
    expect(
      contentStats!.uniqueColors,
      `捕获图几乎是纯色（uniqueColors=${contentStats!.uniqueColors}）——stitch 可能没画上任何东西`,
    ).toBeGreaterThan(3);
    expect(
      contentStats!.nonWhiteRatio,
      `捕获图几乎全白（nonWhiteRatio=${contentStats!.nonWhiteRatio.toFixed(4)}）——stitch 很可能画了空白图`,
    ).toBeGreaterThan(0.005);

    // 7) 逐段断言：每一段横向带都必须有内容。
    //    这一条专治「中间漏了一段 slice」——全图比例高也照样漏。
    const emptyBands = contentStats!.bands
      .map((ratio, index) => ({ index, ratio }))
      .filter((b) => b.ratio < 0.005);
    expect(
      emptyBands,
      `以下横向带几乎是空白的（可能有一整段 slice 没拼上）: ${JSON.stringify(emptyBands)}`,
    ).toEqual([]);

    // 6) 截图存档
    await popupPage.screenshot({ path: 'reports/screenshots/e2e-popup-done.png', fullPage: true });
    await targetPage.screenshot({ path: 'reports/screenshots/e2e-target-page.png', fullPage: true });

    await popupPage.close();
    await targetPage.close();
  });
});

/**
 * Close the persistent context without letting a hang kill the test.
 *
 * In headed mode with an extension loaded, `context.close()` occasionally
 * never resolves (the MV3 service worker keeps the browser process
 * alive). We race it against a short timeout and fall back to closing
 * the browser process, so a teardown hiccup can never turn a passing
 * capture into a failing test.
 */
async function closeContextSafely(
  ctx: BrowserContext | undefined,
  timeoutMs = 15_000,
): Promise<void> {
  if (!ctx) return;
  try {
    await Promise.race([
      ctx.close(),
      new Promise<void>((_, reject) =>
        setTimeout(
          () => reject(new Error(`context.close() timed out after ${timeoutMs}ms`)),
          timeoutMs,
        ),
      ),
    ]);
  } catch (err) {
    console.warn(`[shotly-e2e] ${(err as Error).message} — forcing browser close`);
    try {
      await ctx.browser()?.close();
    } catch {
      /* already gone */
    }
  }
}

async function getTabIdViaTitle(): Promise<void> {
  // No-op — popup 查询 tab via chrome.tabs.query({url: pattern}) instead.
  // CDP targetId is NOT Chrome tabId, so we cannot pass it through.
  return;
}
void getTabIdViaTitle;

async function waitForStatus(
  popupPage: import('@playwright/test').Page,
  expected: string,
  timeoutMs: number,
): Promise<string> {
  const start = Date.now();
  let last = 'unknown';
  while (Date.now() - start < timeoutMs) {
    last = await popupPage.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (window as any).__shotlyTest?.getStatus?.() ?? 'unknown';
    });
    if (last === expected) return last;
    if (last === 'error') {
      const err = await popupPage.evaluate(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (window as any).__shotlyTest?.getError?.() ?? null;
      });
      throw new Error(`popup 进入 error 状态：${err}`);
    }
    await popupPage.waitForTimeout(500);
  }
  return last;
}