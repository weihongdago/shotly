/**
 * Shotly E2E 共享测试台
 *
 * 把三件事收在一处，避免每个 spec 各写一遍：
 *   1. 起一个静态服务器（同时托管 test-pages/ 和 poc-d3/fixtures/）
 *   2. 装起 Shotly 扩展并拿到 extension ID
 *   3. 走 popup → bg → content → offscreen → blob URL 全链路，并把
 *      捕获结果做**像素级**分析
 *
 * ⚠️ 分析用的是像素，不是 byteSize。
 *    几何算错时 drawImage 会静默失败，画出一张纯白图 —— 而纯白图的
 *    PNG 仍然有 100KB+，任何只看数字的断言都会通过。
 *    （2026-10-26 实际踩中过：E2E 绿了，产物是空白图。）
 */

import { chromium, type BrowserContext, type Page } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const SHOTLY_BUILT = resolve(process.cwd(), '.output', 'chrome-mv3');
export const TEST_PAGE_DIR = resolve(process.cwd(), 'e2e', 'test-pages');
export const POC_FIXTURE_DIR = resolve(process.cwd(), 'poc-d3', 'fixtures');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

export interface StaticServer {
  origin: string;
  /** URL of a file in test-pages/ */
  page(name: string): string;
  /** URL of a file in shotly/poc-d3/fixtures/ */
  fixture(name: string): string;
  close(): Promise<void>;
}

export async function startStaticServer(): Promise<StaticServer> {
  const http = await import('node:http');
  const server = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    let file: string;
    let root: string;
    if (url.startsWith('/fixtures/')) {
      file = url.slice('/fixtures/'.length);
      root = POC_FIXTURE_DIR;
    } else {
      file = url === '/' ? 'long-page.html' : url.slice(1);
      root = TEST_PAGE_DIR;
    }
    const path = join(root, file);
    if (!path.startsWith(root) || !existsSync(path) || !statSync(path).isFile()) {
      res.statusCode = 404;
      res.end(`Not found: ${file}`);
      return;
    }
    const dot = file.lastIndexOf('.');
    const ext = dot >= 0 ? file.slice(dot).toLowerCase() : '';
    res.setHeader('Content-Type', MIME[ext] ?? 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.end(readFileSync(path));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const port = (server.address() as any).port as number;
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    page: (name) => `${origin}/${name}`,
    fixture: (name) => `${origin}/fixtures/${name}`,
    // ⚠️ `server.close()` alone HANGS: Chrome keeps the HTTP keep-alive
    // socket open for minutes and `close()` waits for in-flight
    // connections to drain — the afterAll hook then times out and the
    // whole test is reported as failed even though the capture worked.
    // `closeAllConnections()` (Node 18.2+) force-drops them first.
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

export interface ShotlyHarness {
  context: BrowserContext;
  extensionId: string;
  server: StaticServer;
  /** Everything the service worker and popup logged. */
  logs: string[];
  close(): Promise<void>;
}

export interface HarnessOptions {
  deviceScaleFactor?: number;
  viewport?: { width: number; height: number };
  /** Give Chrome longer to boot the extension (slow machines). */
  bootWaitMs?: number;
  /**
   * Called with the BrowserContext **before the service worker has a
   * chance to boot** (i.e. right after launch, before the boot wait).
   *
   * Use this to install network interceptors that must catch requests made
   * during extension startup — e.g. an analytics SDK that pings on install.
   * Installing the interceptor later would miss exactly those requests.
   */
  onContext?: (ctx: BrowserContext) => Promise<void> | void;
  /**
   * Install from a **directory other than the default unpacked build**.
   *
   * Why: CWS receives `shotly-0.1.0-chrome.zip`, not `.output/chrome-mv3/`.
   * Those are byte-identical in content, but the zip path is what the
   * reviewer actually unzips — so the packaged artifact deserves its own
   * smoke test (e.g. a stray file that `wxt zip` includes but `wxt build`
   * doesn't, or a locale folder that gets dropped when packaging).
   */
  extensionPath?: string;
  /**
   * Run Chromium in **new headless** mode (no visible window).
   *
   * Why this exists: CI has no display, so the old `headless: false` path
   * could never run there. The naive fix — Playwright's `headless: true` —
   * uses the *old* headless shell, which **cannot load extensions**
   * (verified: serviceWorkers = 0, extension never boots).
   *
   * The fix is Chromium's `--headless=new` flag, which is the real
   * headless Chrome and **does** support extensions
   * (verified: serviceWorkers = 1, SW boots normally).
   *
   * We pass `headless: false` to Playwright and add the flag ourselves —
   * that's how you get the new headless mode rather than the old shell.
   *
   * Defaults to on when `CI` is set (no display server there).
   */
  headless?: boolean;
}

export async function launchShotly(opts: HarnessOptions = {}): Promise<ShotlyHarness> {
  const logs: string[] = [];
  const userDataDir = join(
    (await import('node:os')).tmpdir(),
    `shotly-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(userDataDir, { recursive: true });

  const server = await startStaticServer();

  const dpr = opts.deviceScaleFactor ?? 1;
  const extensionPath = opts.extensionPath ?? SHOTLY_BUILT;
  // CI 没有显示器 → 自动切到 Chromium 的 --headless=new。
  // 本地默认还是 headful（要看真实窗口行为）。
  const useHeadless = opts.headless ?? !!process.env.CI;

  const context = await chromium.launchPersistentContext(userDataDir, {
    // 必须用 Playwright 自带 Chromium（Chrome for Testing）：Chrome stable
    // 拒绝 --disable-extensions-except / --load-extension，扩展加载不到。
    //
    // headless: 传 false，但自己加 --headless=new ——
    // Playwright 的 headless:true 用的是**旧** headless shell，加载不了扩展。
    // Chromium 的 --headless=new 才是真 headless Chrome，支持扩展（CI 必需）。
    headless: false,
    args: [
      ...(useHeadless ? ['--headless=new'] : []),
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--enable-extensions',
      '--disable-features=ExtensionsToolbarMenu',
      // ⚠️ 必须显式设置窗口的 device scale factor。
      //
      // Playwright 的 `deviceScaleFactor` 只是**渲染层**的模拟（CDP
      // emulation），窗口 widget 的 scale factor 仍然是 1。而
      // `chrome.tabs.captureVisibleTab` 抓的是 widget 的光栅 —— 所以只设
      // deviceScaleFactor 时抓回来的位图依然是 1×（实测：2560 CSS 宽的
      // 页面只抓回 1280px 宽的位图）。
      //
      // 真实 Retina 机器上 Chrome 的 widget scale 就是 2，抓回来自然是
      // 2× 位图。`--force-device-scale-factor=2` 让测试环境与真实机器
      // 一致，于是“高 DPR 输出 2 倍宽度”这条断言才有意义。
      // 见 test-infra/probe-dpr-capture.mjs 的实测数据。
      ...(dpr > 1 ? [`--force-device-scale-factor=${dpr}`] : []),
    ],
    viewport: opts.viewport ?? { width: 1280, height: 800 },
    deviceScaleFactor: dpr,
  });

  context.on('console', (msg) => logs.push(`[ctx] ${msg.type()}: ${msg.text()}`));

  // ⚠️ 必须在 SW 启动**之前**装好拦截器 ——
  //    扩展装上就会立刻执行顶层代码（埋点 SDK 典型行为），
  //    晚装一步就漏掉了最该抓的那批请求。
  await opts.onContext?.(context);

  // 拦截 SW console。去重键是 **service worker 的 URL**（同一个扩展里
  // 同一个 SW 实例的 URL 是唯一的）——用对象身份去重会把同一个 worker
  // 的两个 JS wrapper 当成两个 worker，导致每条日志打印两遍。
  const wiredSwUrls = new Set<string>();
  const wireSw = (sw: {
    url: () => string;
    on: (e: string, cb: (m: { type: () => string; text: () => string }) => void) => void;
  }) => {
    const url = sw.url();
    if (wiredSwUrls.has(url)) return;
    wiredSwUrls.add(url);
    sw.on('console', (msg) => logs.push(`[SW] ${msg.type()}: ${msg.text()}`));
  };
  context.on('serviceworker', (sw) => {
    wireSw(sw as unknown as Parameters<typeof wireSw>[0]);
    logs.push(`[SW] attached: ${sw.url()}`);
  });

  // 给 SW 启动 + Chrome 写 Preferences 的时间（headless=false on macOS）
  await new Promise((r) => setTimeout(r, opts.bootWaitMs ?? 8_000));

  let extensionId = '';
  for (let i = 0; i < 15 && !extensionId; i++) {
    for (const sw of context.serviceWorkers()) {
      const m = sw.url().match(/^chrome-extension:\/\/([a-z]{32})/);
      if (m) {
        extensionId = m[1];
        break;
      }
    }
    if (!extensionId) await new Promise((r) => setTimeout(r, 1_000));
  }
  if (!extensionId) throw new Error('extension ID 提取失败');
  logs.push(`[harness] extensionId = ${extensionId}`);

  return {
    context,
    extensionId,
    server,
    logs,
    close: async () => {
      await server.close();
      await closeContextSafely(context);
    },
  };
}

export async function closeContextSafely(
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
    /**
     * ⚠️ 这里原来写的是 `logs.warn(...)` —— 但 `logs` 是 `launchShotly()`
     *    里的**局部** string[]，本函数拿不到。
     *
     *    后果：这个 catch 块自己会抛 ReferenceError，
     *    把真正的错误（close 超时）盖掉，而且底下的
     *    「forcing browser close」补救根本执行不到 ——
     *    浏览器不会被强制关闭，进程可能挂住。
     *
     *    套件搬进 shotly 仓库后 `pnpm compile` 覆盖到 e2e/，
     *    类型检查把这个抓出来了（TS2304: Cannot find name 'logs'）。
     */
    console.warn(`[harness] ${(err as Error).message} — forcing browser close`);
    try {
      await ctx.browser()?.close();
    } catch {
      /* already gone */
    }
  }
}

// ─── Capture flow ────────────────────────────────────────────────────────────

export type CaptureOutcome =
  | {
      status: 'done';
      result: CaptureResult;
      analysis: CaptureAnalysis;
      /** Binarised band signatures, computed while the popup is still open. */
      signatures: Record<string, BandSignature>;
    }
  | { status: 'error'; error: string | null };

export interface BandSignature {
  signature: string;
  inkRatio: number;
}

export interface CaptureResult {
  byteSize: number;
  width: number;
  height: number;
  blobUrl: string;
}

export interface RunCaptureOptions {
  /** URL of the page that should be captured. */
  targetUrl: string;
  /** Give up after this long. Long pages need a lot. */
  timeoutMs?: number;
  /** Runs after the target page is ready, right before the capture starts. */
  beforeCapture?: (targetPage: Page) => Promise<void>;
  /** Band height used by the pixel analyser. */
  bandHeight?: number;
  /**
   * Colours to count in the captured PNG (e.g. ['#2DD4BF']).
   *
   * Used to prove that a *specific* element made it into the image —
   * the placeholder block's mint border, the same-origin iframe's badge
   * colour — instead of just "the image is not blank".
   */
  colors?: string[];
  /**
   * Bands whose binarised signature is needed.
   *
   * ⚠️ These MUST be computed while the popup page is still open: the blob
   * URL is revoked when the popup unmounts, so it cannot be fetched later
   * from another page.
   */
  signatures?: { label: string; y0: number; h: number }[];
}

export async function runCapture(
  harness: ShotlyHarness,
  opts: RunCaptureOptions,
): Promise<CaptureOutcome> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const { context, extensionId } = harness;

  const targetPage = await context.newPage();
  await targetPage.goto(opts.targetUrl);
  await targetPage.waitForLoadState('domcontentloaded');

  // content script 走 `run_at: document_idle`，不一定在 goto 返回时就绪；
  // 不等就会偶发地 "port 连不上"。
  await targetPage.waitForSelector('html[data-shotly-content="ready"]', { timeout: 15_000 });

  await opts.beforeCapture?.(targetPage);

  const popupPage = await context.newPage();
  popupPage.on('console', (msg) => harness.logs.push(`[POPUP] ${msg.type()}: ${msg.text()}`));
  popupPage.on('pageerror', (err) => harness.logs.push(`[POPUP] pageerror: ${err.message}`));

  const pattern = `${new URL(opts.targetUrl).origin}/*`;
  await popupPage.goto(
    `chrome-extension://${extensionId}/popup.html?testUrlPattern=${encodeURIComponent(pattern)}`,
  );
  await popupPage.waitForLoadState('domcontentloaded');
  await popupPage.waitForFunction(() => !!(window as unknown as { __shotlyTest?: unknown }).__shotlyTest);

  await popupPage.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__shotlyTest.capture();
  });

  const status = await waitForStatus(popupPage, timeoutMs);
  if (status !== 'done') {
    const error = await popupPage.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (window as any).__shotlyTest?.getError?.() ?? null;
    });
    await popupPage.close().catch(() => {});
    await targetPage.close().catch(() => {});
    return { status: 'error', error };
  }

  const result = await popupPage.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    return w.__shotlyTest?.getResult?.() ?? null;
  }) as CaptureResult | null;

  if (!result) {
    await popupPage.close().catch(() => {});
    await targetPage.close().catch(() => {});
    throw new Error('popup 报告 done 但没有 result');
  }

  const analysis = await analyzeCapture(popupPage, {
    bandHeight: opts.bandHeight ?? 400,
    colors: opts.colors ?? [],
  });

  const signatures: Record<string, BandSignature> = {};
  for (const band of opts.signatures ?? []) {
    const sig = await bandSignature(popupPage, band.y0, band.h);
    if (sig) signatures[band.label] = sig;
  }

  await popupPage.close().catch(() => {});
  await targetPage.close().catch(() => {});
  return { status: 'done', result, analysis, signatures };
}

export async function waitForStatus(popupPage: Page, timeoutMs: number): Promise<string> {
  const start = Date.now();
  let last = 'unknown';
  while (Date.now() - start < timeoutMs) {
    last = await popupPage.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (window as any).__shotlyTest?.getStatus?.() ?? 'unknown';
    });
    if (last === 'done' || last === 'error') return last;
    await popupPage.waitForTimeout(400);
  }
  return last;
}

// ─── Pixel analysis ──────────────────────────────────────────────────────────

export interface CaptureAnalysis {
  width: number;
  height: number;
  byteSize: number;
  /** Distinct colours found in the sampled pixels. */
  uniqueColors: number;
  /** Share of sampled pixels that are not near-white. */
  nonWhiteRatio: number;
  /** Per-band non-white ratio — catches "one slice never got drawn". */
  bands: number[];
  bandHeight: number;
  /** Pixel counts for specific colours (hex, e.g. '#2DD4BF'). */
  colorHits: Record<string, number>;
}

/**
 * Analyse the captured PNG **by pixel**.
 *
 * The image is decoded band by band with `createImageBitmap(blob, sx, sy, sw, sh)`
 * so a 1280 × 30,000 capture never has to exist as one full-size canvas.
 * The PNG header is parsed directly for the dimensions — decoding the whole
 * bitmap just to learn its size would defeat the purpose.
 */
export async function analyzeCapture(
  popupPage: Page,
  opts: { bandHeight?: number; colors?: string[] } = {},
): Promise<CaptureAnalysis> {
  const bandHeight = opts.bandHeight ?? 400;
  const colors = opts.colors ?? [];
  return (await popupPage.evaluate(
    async ({ bandHeight: bh, colors: wantColors }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const w = window as any;
      const url = w.__shotlyTest?.getResult?.()?.blobUrl as string | undefined;
      if (!url) return null;

      const blob = await (await fetch(url)).blob();
      const head = new Uint8Array(await blob.slice(0, 24).arrayBuffer());
      // PNG IHDR: width at byte 16..19, height at 20..23 (big endian).
      const dv = new DataView(head.buffer);
      const width = dv.getUint32(16);
      const height = dv.getUint32(20);

      const hexToRgb = (hex: string): [number, number, number] => {
        const h = hex.replace('#', '');
        return [
          parseInt(h.slice(0, 2), 16),
          parseInt(h.slice(2, 4), 16),
          parseInt(h.slice(4, 6), 16),
        ];
      };
      const targets = wantColors.map((c) => ({
        // Normalise the key to upper case so a lookup of '#DAFBE1' finds a
        // colour that was requested as '#dafbe1'. A missing key silently
        // reads as 0 hits, which looks exactly like "the colour is not in
        // the picture" — a very expensive way to be wrong.
        hex: c.toUpperCase(),
        rgb: hexToRgb(c),
      }));
      const colorHits: Record<string, number> = {};
      for (const t of targets) colorHits[t.hex] = 0;

      const colorSet = new Set<number>();
      let nonWhite = 0;
      let total = 0;
      const bands: number[] = [];

      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return null;

      const bandCount = Math.ceil(height / bh);
      for (let b = 0; b < bandCount; b++) {
        const y0 = b * bh;
        const h = Math.min(bh, height - y0);
        if (h <= 0) break;

        // Decode ONLY this band — no full-size canvas anywhere.
        const bmp = await createImageBitmap(blob, 0, y0, width, h);
        canvas.width = bmp.width;
        canvas.height = bmp.height;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(bmp, 0, 0);
        bmp.close();
        const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);

        let bandNonWhite = 0;
        let bandTotal = 0;
        for (let i = 0; i < data.length; i += 4 * 7) {
          bandTotal += 1;
          const r = data[i];
          const g = data[i + 1];
          const bl = data[i + 2];
          if (!(r > 245 && g > 245 && bl > 245)) {
            bandNonWhite += 1;
            nonWhite += 1;
          }
          total += 1;
          colorSet.add(((r >> 3) << 10) | ((g >> 3) << 5) | (bl >> 3));
          for (const t of targets) {
            if (
              Math.abs(r - t.rgb[0]) <= 6 &&
              Math.abs(g - t.rgb[1]) <= 6 &&
              Math.abs(bl - t.rgb[2]) <= 6
            ) {
              colorHits[t.hex] += 1;
            }
          }
        }
        bands.push(bandTotal > 0 ? bandNonWhite / bandTotal : 0);
      }

      return {
        width,
        height,
        byteSize: blob.size,
        uniqueColors: colorSet.size,
        nonWhiteRatio: total > 0 ? nonWhite / total : 0,
        bands,
        bandHeight: bh,
        colorHits,
      };
    },
    { bandHeight, colors },
  )) as CaptureAnalysis;
}

/**
 * Binarised signature of one horizontal band of the captured PNG.
 *
 * Two bands that render the same text in the same font produce the same
 * signature; two bands that differ only in their font do not. Used by the
 * web-font scenario to prove the webfont (and not the fallback) was painted.
 */
export async function bandSignature(
  popupPage: Page,
  y0: number,
  h: number,
): Promise<BandSignature | null> {
  return (await popupPage.evaluate(
    async ({ y0: top, h: height }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const w = window as any;
      const url = w.__shotlyTest?.getResult?.()?.blobUrl as string | undefined;
      if (!url) return null;
      const blob = await (await fetch(url)).blob();
      // PNG IHDR: width at byte 16..19 (big endian). Reading the header
      // avoids decoding the whole image just to learn its size.
      const head = new Uint8Array(await blob.slice(0, 24).arrayBuffer());
      const imgWidth = new DataView(head.buffer).getUint32(16);
      const bmp = await createImageBitmap(blob, 0, top, imgWidth, height);
      const canvas = document.createElement('canvas');
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return null;
      ctx.drawImage(bmp, 0, 0);
      bmp.close();
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      let out = '';
      let ink = 0;
      let n = 0;
      for (let i = 0; i < data.length; i += 4 * 5) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const dark = r < 160 && g < 160 && b < 160;
        if (dark) ink += 1;
        n += 1;
        out += dark ? '1' : '0';
      }
      return { signature: out, inkRatio: n > 0 ? ink / n : 0 };
    },
    { y0, h },
  )) as BandSignature | null;
}

/** Fraction of positions where two band signatures disagree. */
export function signatureDistance(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let diff = 0;
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) diff += 1;
  return diff / n;
}
