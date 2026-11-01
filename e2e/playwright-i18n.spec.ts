import { test, expect, chromium, type BrowserContext } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CHROMIUM_LAUNCH } from './helpers/shotly-harness';

/**
 * Shotly 界面语言一致性（v1.0 i18n 回归）
 *
 * 背景（D+4 实测发现）：
 *   Chrome Web Store 的 listing 是英文，但 popup 界面此前写死中文，
 *   且 manifest 没有 `default_locale`。两个后果：
 *     1. 英文用户读得懂商店页，却看不懂装上之后的按钮；
 *     2. 商店把扩展认定为 English，后台单独提交的「中文（简体）」
 *        listing 永远不会展示给中文用户。
 *
 * 本 spec 锁死两件事：
 *   - 界面跟随浏览器语言（en-US → 英文，zh-CN → 中文）
 *   - manifest 声明 `default_locale` + `_locales/` 齐全，商店侧才认多语言
 *
 * 真实浏览器跑真实 popup，不 mock。
 */

const SHOTLY_BUILT = resolve(process.cwd(), '.output', 'chrome-mv3');

/**
 * 起一个本地 HTTP 服务给 content script 跑。
 *
 * content script 不注入 data: URL（manifest 的 `<all_urls>` 不含 data:），
 * 所以要验证页面上的浮层，必须有一个真的 http 页面。
 */
async function startStaticServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const http = await import('node:http');
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>i18n</title></head>
    <body><h1>Shotly i18n probe</h1><div style="height:3000px"></div></body></html>`;
  const server = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(html);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const port = (server.address() as any).port as number;
  return {
    url: `http://127.0.0.1:${port}/probe.html`,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

/** 启动一个带扩展的持久化上下文，指定浏览器语言。 */
async function launch(locale: string): Promise<{ context: BrowserContext; extensionId: string }> {
  const context = await chromium.launchPersistentContext('', {
    headless: CHROMIUM_LAUNCH.playwrightHeadless,
    viewport: { width: 1280, height: 800 },
    locale,
    args: [
      // CI 没有 X server —— 必须用 --headless=new（本地默认 headful）。
      ...CHROMIUM_LAUNCH.envArgs,
      `--disable-extensions-except=${SHOTLY_BUILT}`,
      `--load-extension=${SHOTLY_BUILT}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--enable-extensions',
    ],
  });
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 20_000 }));
  return { context, extensionId: new URL(sw.url()).host };
}

/** 读出 popup 里的关键文案。 */
async function readPopupTexts(page: import('@playwright/test').Page) {
  await page.waitForSelector('.popup', { timeout: 20_000 });
  // 给 i18n override 的读取留出时间（storage.local.get 是异步的）。
  await page.waitForTimeout(500);
  return page.evaluate(() => ({
    cards: [...document.querySelectorAll('.card-label')].map((e) => e.textContent?.trim() ?? ''),
    footer: document.querySelector('.footer')?.textContent?.trim() ?? '',
    langToggle: document.querySelector('.icon-btn.lang')?.textContent?.trim() ?? '',
  }));
}

test.describe('Shotly 界面语言一致性', () => {
  test.beforeAll(() => {
    test.skip(!existsSync(SHOTLY_BUILT), `shotly 未 build：缺少 ${SHOTLY_BUILT}`);
  });

  test('manifest 声明 default_locale，且 _locales/ 齐备', async () => {
    const manifest = JSON.parse(
      readFileSync(resolve(SHOTLY_BUILT, 'manifest.json'), 'utf8'),
    ) as { default_locale?: string; name?: string; description?: string };

    // 商店靠 default_locale 判断扩展语言；缺了它，中文 listing 不会被展示。
    expect(manifest.default_locale).toBe('en');

    // 有 default_locale 就必须有 _locales/en，否则 Chrome 启动直接报错。
    const en = resolve(SHOTLY_BUILT, '_locales', 'en', 'messages.json');
    const zh = resolve(SHOTLY_BUILT, '_locales', 'zh_CN', 'messages.json');
    expect(existsSync(en), '_locales/en/messages.json 缺失').toBe(true);
    expect(existsSync(zh), '_locales/zh_CN/messages.json 缺失').toBe(true);

    // 两份都必须有 extensionName / extensionDescription，否则覆盖不生效。
    for (const file of [en, zh]) {
      const messages = JSON.parse(readFileSync(file, 'utf8')) as Record<string, { message: string }>;
      expect(messages.extensionName?.message, `${file} 缺 extensionName`).toBeTruthy();
      expect(messages.extensionDescription?.message, `${file} 缺 extensionDescription`).toBeTruthy();
    }
  });

  test('英文浏览器 → 英文界面', async () => {
    const { context, extensionId } = await launch('en-US');
    try {
      const page = await context.newPage();
      await page.goto(`chrome-extension://${extensionId}/popup.html`);
      const texts = await readPopupTexts(page);
      expect(texts.cards).toEqual(['Full page', 'Region', 'History', 'Shortcuts']);
      // ⚠️ 断言的是**真实承诺**，不是「Upgrade Pro」——
      //    那个 Pro 版从来没实现过，是吹的（shotly 仓库 597f020 改掉了）。
      //    这里跟着改成真实文案。
      expect(texts.footer).toContain('Free & open source');
      // 切换按钮显示目标语言（当前是英文 → 显示「中」）
      expect(texts.langToggle).toBe('中');
    } finally {
      await context.close();
    }
  });

  test('中文浏览器 → 中文界面', async () => {
    const { context, extensionId } = await launch('zh-CN');
    try {
      const page = await context.newPage();
      await page.goto(`chrome-extension://${extensionId}/popup.html`);
      const texts = await readPopupTexts(page);
      expect(texts.cards).toEqual(['整页截图', '区域截图', '历史库', '快捷键']);
      // 同上：真实承诺，不是没实现的 Pro 版。
      expect(texts.footer).toContain('免费开源');
      expect(texts.langToggle).toBe('EN');
    } finally {
      await context.close();
    }
  });

  test('用户可手动切换语言并持久化', async () => {
    const { context, extensionId } = await launch('en-US');
    try {
      const page = await context.newPage();
      await page.goto(`chrome-extension://${extensionId}/popup.html`);
      await readPopupTexts(page);

      // 点一下 → 变中文
      await page.click('.icon-btn.lang');
      await page.waitForTimeout(300);
      const afterToggle = await readPopupTexts(page);
      expect(afterToggle.cards[0]).toBe('整页截图');

      // 重开 popup → 仍然是中文（override 落在 chrome.storage.local）
      const reopened = await context.newPage();
      await reopened.goto(`chrome-extension://${extensionId}/popup.html`);
      const persisted = await readPopupTexts(reopened);
      expect(persisted.cards[0]).toBe('整页截图');
    } finally {
      await context.close();
    }
  });

  test('区域框选浮层跟随语言（画在页面上，不是 popup）', async () => {
    // 浮层由 content script 绘制在网页里，不走 popup 的 Vue 渲染，
    // 是一条独立的文案路径 —— 之前就是在这里漏掉了本地化。
    //
    // 注意：content script 不跑在 data: URL 上（manifest 只匹配 http/https），
    // 所以这里必须起一个真的本地 HTTP 服务。
    const server = await startStaticServer();
    const { context, extensionId } = await launch('en-US');
    try {
      const target = await context.newPage();
      await target.goto(server.url);
      await target.waitForLoadState('domcontentloaded');
      await target.waitForSelector('html[data-shotly-content="ready"]', { timeout: 15_000 });

      const popup = await context.newPage();
      await popup.goto(
        `chrome-extension://${extensionId}/popup.html?testUrlPattern=${encodeURIComponent(
          server.url.replace(/\/[^/]*$/, '/*'),
        )}`,
      );
      await readPopupTexts(popup);

      await popup.evaluate(() => {
        document
          .querySelector<HTMLButtonElement>('button[data-shotly-action="region"]')
          ?.click();
      });

      await target.waitForSelector('[data-shotly-region-overlay="1"]', { timeout: 20_000 });
      const hint = await target.evaluate(() => {
        const overlay = document.querySelector('[data-shotly-region-overlay="1"]');
        return overlay?.textContent?.trim() ?? '';
      });
      expect(hint, '英文浏览器下浮层提示不应是中文').toContain('Drag to select a region');
      expect(hint).not.toMatch(/[一-龥]/);
    } finally {
      await context.close();
      await server.close();
    }
  });
});
