import { test, expect, type Page } from '@playwright/test';
import {
  launchShotly,
  closeContextSafely,
  startStaticServer,
  waitForStatus,
  type ShotlyHarness,
  type StaticServer,
} from './helpers/shotly-harness';

/**
 * 历史库「重新下载」—— 真实浏览器验证。
 *
 * ## 背景
 *
 * D+4 深夜发现：`getHistoryBlob()` 存在、有单测，但**UI 从来没调用过**。
 * 历史库面板只有一个「删除」按钮 —— 你能存 50 张全页截图，然后一张也
 * 拿不回来。而公开站点首页写着 "re-download yesterday's shot"。
 *
 * 单测只能验「接线还在」（静态检查）。这里验**真的能用**：
 *   1. 截图 → 存进历史库 → 历史列表出现这一条
 *   2. 点「下载」→ 真的产出一个文件
 *   3. 那个文件是**有内容的**（不是 0 字节 / 不是空白图）
 *
 * 第 3 条是关键 —— 只断言「下载事件触发了」会漏掉「下下来是空的」
 * 这种假绿。字节数 + PNG 头都要对。
 */

const TIMEOUT = 120_000;

/** Wait until the history list shows at least one row. */
async function waitForHistoryRow(popupPage: Page, timeoutMs = 30_000): Promise<void> {
  await popupPage.waitForSelector('.history-list .history-item', { timeout: timeoutMs });
}

/**
 * Read the history store directly from the popup page.
 *
 * The popup runs on the extension origin, so `indexedDB` there is the
 * extension's own store — the same one the UI reads.
 */
async function readHistoryCount(popupPage: Page): Promise<number> {
  return popupPage.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('shotly', 1);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const count = await new Promise<number>((resolve, reject) => {
      const tx = db.transaction('history', 'readonly');
      const req = tx.objectStore('history').count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return count;
  });
}

test.describe('历史库 · 重新下载', () => {
  let harness: ShotlyHarness | null = null;
  let server: StaticServer | null = null;

  test.afterEach(async () => {
    if (harness) await closeContextSafely(harness.context);
    if (server) await server.close();
    harness = null;
    server = null;
  });

  test('存进历史库的截图能重新下载，且下下来的是真图', async () => {
    server = await startStaticServer();
    harness = await launchShotly();

    const { context, extensionId } = harness;

    // ── 1. 截一张图并存进历史库 ──────────────────────────────────────────
    const targetPage = await context.newPage();
    await targetPage.goto(server.origin);
    await targetPage.waitForLoadState('domcontentloaded');
    await targetPage.waitForSelector('html[data-shotly-content="ready"]', { timeout: 15_000 });

    const popupPage = await context.newPage();
    popupPage.on('pageerror', (err) => {
      harness?.logs.push(`[POPUP] pageerror: ${err.message}`);
    });

    const pattern = `${server.origin}/*`;
    await popupPage.goto(
      `chrome-extension://${extensionId}/popup.html?testUrlPattern=${encodeURIComponent(pattern)}`,
    );
    await popupPage.waitForLoadState('domcontentloaded');
    await popupPage.waitForFunction(() => !!(window as unknown as { __shotlyTest?: unknown }).__shotlyTest);

    await popupPage.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__shotlyTest.capture();
    });

    const status = await waitForStatus(popupPage, TIMEOUT);
    expect(status, `截图没成功：${JSON.stringify(harness.logs.slice(-5))}`).toBe('done');

    // 点「存历史」（dl-btn.secondary 那一颗）
    await popupPage.click('[data-shotly-action="save-history"]');

    // 打开历史库面板（用 data-shotly-action 钩子，不依赖 class 名）
    await popupPage.click('[data-shotly-action="history"]');
    await waitForHistoryRow(popupPage);
    expect(await readHistoryCount(popupPage), '历史库里应该有 1 条').toBe(1);

    // ── 2. 点历史条目的「下载」 ─────────────────────────────────────────
    const downloadPromise = popupPage.waitForEvent('download', { timeout: 30_000 });

    // 历史条目上的第一个按钮就是下载（第二个是删除）
    await popupPage.click('[data-shotly-action="history-download"]');

    const download = await downloadPromise;
    expect(download.suggestedFilename(), '下载文件名应该带标题和时间戳').toMatch(
      /^shotly-.+-\d{8}-\d{6}\.png$/,
    );

    // ── 3. 文件真的有内容（不是 0 字节 / 不是空白图）────────────────────
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);

    expect(bytes.length, '下载下来的文件是空的').toBeGreaterThan(1000);
    // PNG magic number
    expect(
      bytes.subarray(0, 8).toString('hex'),
      '下载下来的不是 PNG',
    ).toBe('89504e470d0a1a0a');

    // 高度要对得上（IHDR 宽高在第 16-24 字节）
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    expect(width, '图片宽度不对').toBeGreaterThan(100);
    expect(height, '图片高度不对').toBeGreaterThan(100);

    // ── 4. 重新下载完，历史条目还在（下载不该删掉它）────────────────────
    expect(await readHistoryCount(popupPage), '下载后历史条目应该还在').toBe(1);

    await popupPage.close().catch(() => {});
    await targetPage.close().catch(() => {});
  });
});
