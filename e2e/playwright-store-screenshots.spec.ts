/**
 * Shotly 商店素材生成（真实 Chrome 运行结果）
 *
 * 产出 4 张 Chrome Web Store 截图（1280×800），全部来自**真实浏览器运行**：
 *   1. `01-full-page-capture.png`  — Shotly 抓出来的整页长图（真实产物）
 *   2. `02-region-selection.png`   — 真实网页上的区域框选浮层
 *   3. `03-capture-progress.png`   — popup 采集中的真实进度条
 *   4. `04-result-and-formats.png` — popup 完成态：真实预览图 + PNG/JPG/PDF
 *
 * ⚠️ 商店素材必须来自真实 Chrome 运行结果，不使用 mockup 代替。
 *    1/2 号是直接截真实页面/真实产物；3/4 号是把**真实截取的 popup 像素**
 *    摆进一张 1280×800 的版式里 —— 画面里的每一个产品像素都是实拍的，
 *    版式里只有文字说明，没有伪造的 UI。
 */

import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import { mkdtempSync, existsSync, mkdirSync, writeFileSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CHROMIUM_LAUNCH } from './helpers/shotly-harness';

const SHOTLY_REPO = resolve(process.cwd());
const SHOTLY_BUILT = resolve(SHOTLY_REPO, '.output', 'chrome-mv3');
const TEST_PAGE_DIR = resolve(process.cwd(), 'e2e', 'test-pages');
/**
 * Store assets live in the **shotly repo** (the public one), not in this
 * workspace repo: that way `shotly/utils/__tests__/store-listing-consistency.test.ts`
 * can guard the listing against the real manifest in CI, and the assets
 * that get submitted to CWS are versioned next to the code they describe.
 */
const OUT_DIR = resolve(process.cwd(), 'store-assets', 'screenshots');
/** Raw intermediates stay in the test reports dir — only the final store
 *  images belong in store-assets. */
const RAW_DIR = resolve(process.cwd(), 'reports', 'store-raw');
const ARTICLE_FILE = 'article.html';

const STORE_W = 1280;
const STORE_H = 800;

interface StaticServer {
  url: string;
  close: () => Promise<void>;
}

async function startStaticServer(): Promise<StaticServer> {
  const http = await import('node:http');
  const server = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    const file = url === '/' || url === `/${ARTICLE_FILE}` ? ARTICLE_FILE : url.slice(1);
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
    url: `http://127.0.0.1:${port}/${ARTICLE_FILE}`,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

async function closeContextSafely(context: BrowserContext): Promise<void> {
  if (!context) return;
  try {
    await Promise.race([
      context.close(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('context.close() timeout')), 15_000)),
    ]);
  } catch {
    try {
      await context.browser()?.close();
    } catch {
      /* nothing else we can do */
    }
  }
}

/**
 * Build a 1280×800 store image out of real PNG bytes + plain text.
 * Every product pixel in here comes from a real Chrome run.
 */
async function composeStoreImage(
  context: BrowserContext,
  opts: {
    file: string;
    headline: string;
    sub: string;
    /** data: URLs of the real images to place. */
    images: { src: string; label?: string; fit?: 'contain' | 'cover' }[];
    layout: 'hero' | 'split' | 'fit' | 'single';
  },
): Promise<void> {
  const page = await context.newPage();
  await page.setViewportSize({ width: STORE_W, height: STORE_H });

  const panels =
    opts.layout === 'hero'
      ? `<div class="hero-img"><img src="${opts.images[0].src}" /></div>`
      : opts.layout === 'fit'
        ? `<div class="hero-img fit"><img src="${opts.images[0].src}" /></div>`
        : opts.layout === 'single'
          ? `<div class="single"><img src="${opts.images[0].src}" /></div>`
          : `<div class="split">${opts.images
              .map(
                (im) =>
                  `<div class="panel"><div class="panel-img"><img src="${im.src}" style="object-fit:${im.fit ?? 'contain'}" /></div>${im.label ? `<div class="cap">${im.label}</div>` : ''}</div>`,
              )
              .join('')}</div>`;

  await page.setContent(
    `<!doctype html><html><head><meta charset="utf-8"><style>
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body {
        width: ${STORE_W}px; height: ${STORE_H}px; overflow: hidden;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        background: linear-gradient(135deg, #0F172A 0%, #134E4A 58%, #0D9488 100%);
        color: #fff; display: flex; flex-direction: column;
        padding: 44px 52px 40px;
      }
      h1 { font-size: 33px; letter-spacing: -0.02em; font-weight: 800; flex: 0 0 auto; }
      p.sub { font-size: 15.5px; color: rgba(255,255,255,0.76); margin-top: 9px; flex: 0 0 auto; }
      /* Hero: show the real capture at natural width, clipped, with a fade
         at the bottom so it reads as "this page keeps going". Scaling the
         whole tall image to fit would make it unreadable. */
      .hero-img {
        flex: 1 1 auto; min-height: 0; margin-top: 24px; border-radius: 12px;
        overflow: hidden; background: #fff; position: relative;
        box-shadow: 0 22px 60px rgba(0,0,0,0.4);
      }
      .hero-img img { display: block; width: 100%; }
      /* "fit" layout: the source is already a full 1280x800 viewport shot,
         so show all of it rather than cropping. */
      .hero-img.fit { display: flex; align-items: center; justify-content: center; }
      .hero-img.fit img { width: auto; max-width: 100%; max-height: 100%; object-fit: contain; }
      .hero-img.fit::after { display: none; }
      .hero-img::after {
        content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: 130px;
        background: linear-gradient(to bottom, rgba(255,255,255,0), #fff 88%);
        pointer-events: none;
      }
      .split {
        flex: 1 1 auto; min-height: 0; margin-top: 24px;
        display: flex; gap: 24px; align-items: stretch;
      }
      .panel {
        flex: 1 1 0; min-width: 0; background: rgba(255,255,255,0.07);
        border: 1px solid rgba(255,255,255,0.18); border-radius: 12px;
        padding: 14px; display: flex; flex-direction: column; gap: 9px;
      }
      .panel-img {
        flex: 1 1 auto; min-height: 0; border-radius: 7px; overflow: hidden;
        background: #fff; display: flex; justify-content: center; align-items: flex-start;
      }
      .panel-img img { max-width: 100%; max-height: 100%; object-position: top center; }
      .cap { flex: 0 0 auto; font-size: 12.5px; color: rgba(255,255,255,0.72); text-align: center; }
      /* Single: one real UI shot, centred and large on the gradient. */
      .single {
        flex: 1 1 auto; min-height: 0; margin-top: 24px;
        display: flex; align-items: center; justify-content: center;
      }
      .single img {
        max-height: 100%; max-width: 100%; border-radius: 12px; display: block;
        box-shadow: 0 26px 70px rgba(0,0,0,0.5);
      }
    </style></head><body>
      <h1>${opts.headline}</h1>
      <p class="sub">${opts.sub}</p>
      ${panels}
    </body></html>`,
  );
  /**
   * ⚠️ 截图前必须等「资源真正可用」，不能用固定时长赌。
   *
   * 这里的图都是**大 PNG**：`_raw-capture.png` 是 1280×3521 的整页长图，
   * `object-fit: cover` 会把它缩到面板里。Chrome 对大图是**渐进解码**的 ——
   * 解码和缩放流水进行，截图那一刻可能只解了一部分，
   * 于是缩放出来的像素和「全部解完」时差 ±1。
   *
   * 后果：04 每次重新生成都差 409 个通道（±1），
   * `git status` 永远有一张图是脏的 —— 素材没法版本化，
   * 提交给 Chrome Web Store 的是哪一版说不清。
   *
   * `img.decode()` 的语义正好是「完全解码可用」，比 waitForTimeout 准。
   * 字体同理：`document.fonts.ready`。
   */
  await page.evaluate(async () => {
    await document.fonts.ready;
    const imgs = Array.from(document.images);
    await Promise.all(
      imgs.map((img) =>
        img.decode().catch(() => {
          /* 解码失败不致命 —— 图可能还没挂上 */
        }),
      ),
    );
  });
  await page.waitForTimeout(400);
  const buf = await page.screenshot({ type: 'png' });
  writeFileSync(join(OUT_DIR, opts.file), buf);
  // eslint-disable-next-line no-console
  console.log(`[shotly-store] wrote ${opts.file} (${buf.length} bytes)`);
  await page.close();
}

/** Read a PNG file into a data: URL. */
function pngDataUrl(path: string): string {
  const b64 = readFileSync(path).toString('base64');
  return `data:image/png;base64,${b64}`;
}

/**
 * 源码里最新的修改时间（只看会进构建产物的目录）。
 */
function newestSourceMtime(): number {
  let newest = 0;
  const walk = (p: string) => {
    if (!existsSync(p)) return;
    for (const e of readdirSync(p, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.output' || e.name === '.git') continue;
      const full = join(p, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(ts|vue|json|css|html)$/.test(e.name)) {
        newest = Math.max(newest, statSync(full).mtimeMs);
      }
    }
  };
  for (const d of ['entrypoints', 'utils', 'public']) walk(resolve(SHOTLY_REPO, d));
  for (const f of ['wxt.config.ts', 'package.json']) {
    const p = resolve(SHOTLY_REPO, f);
    if (existsSync(p)) newest = Math.max(newest, statSync(p).mtimeMs);
  }
  return newest;
}

/**
 * 产物比源码旧就重建。
 *
 * ## 为什么需要这个
 *
 * 这个 spec 加载的是**预先构建**的 `.output/chrome-mv3`，它自己不 build。
 * 于是踩过这个坑：改了弹窗 footer 的文案（“Upgrade Pro” → “Free &
 * open source”），直接重跑这个 spec，生成出来的截图**字节完全没变** ——
 * 因为跑的还是旧构建。
 *
 * 后果很阴：截图看起来“生成成功了”，但里面拍的是旧 UI。
 * 而这张图就是要**提交给商店审核**的 —— 于是商店素材和实现对不上。
 *
 * 静默产出过期素材，比直接失败更危险。所以这里：**产物旧了就重建**。
 * 构建只要 ~0.5s，比让人手动想“我是不是忘了 build”划算得多。
 */
function rebuildIfStale(): void {
  const builtAt = existsSync(SHOTLY_BUILT)
    ? statSync(SHOTLY_BUILT).mtimeMs
    : 0;
  const srcAt = newestSourceMtime();

  if (builtAt >= srcAt && builtAt > 0) return;

  console.log(
    `[shotly-store] 产物比源码旧（build ${new Date(builtAt).toISOString()} < ` +
      `src ${new Date(srcAt).toISOString()}）—— 重建`,
  );
  execFileSync('pnpm', ['build'], {
    cwd: SHOTLY_REPO,
    stdio: 'inherit',
  });
}

test.describe('Shotly 商店素材（真实 Chrome 运行）', () => {
  let context: BrowserContext;
  let extensionId: string;
  let staticServer: StaticServer;
  let userDataDir: string;
  let targetPage: Page;
  let popupPage: Page;

  test.setTimeout(300_000);

  test.beforeAll(async () => {
    test.skip(!existsSync(SHOTLY_REPO), `shotly 仓库不在：${SHOTLY_REPO}`);
    rebuildIfStale();
    mkdirSync(OUT_DIR, { recursive: true });
    mkdirSync(RAW_DIR, { recursive: true });

    userDataDir = mkdtempSync(join(tmpdir(), 'shotly-store-'));
    mkdirSync(userDataDir, { recursive: true });
    staticServer = await startStaticServer();

    context = await chromium.launchPersistentContext(userDataDir, {
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
      // The store listing is English, so the popup shown in these shots
      // must be English too — a Chinese popup inside English marketing
      // frames is exactly the listing/UI mismatch we just fixed.
      locale: 'en-US',
      viewport: { width: STORE_W, height: STORE_H },
    });

    await new Promise((r) => setTimeout(r, 8_000));

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
    expect(extensionId, 'extension ID 提取失败').toMatch(/^[a-z]{32}$/);
    // eslint-disable-next-line no-console
    console.log(`[shotly-store] extensionId = ${extensionId}`);

    // 目标页（真实文章页）
    targetPage = await context.newPage();
    await targetPage.goto(staticServer.url);
    await targetPage.waitForLoadState('domcontentloaded');
    await targetPage.waitForSelector('html[data-shotly-content="ready"]', { timeout: 15_000 });

    // popup 作为常规 tab 打开（和真实用户点工具栏图标等价）
    const popupUrl = `chrome-extension://${extensionId}/popup.html?testUrlPattern=${encodeURIComponent(
      staticServer.url.replace(/\/[^/]*$/, '/*'),
    )}`;
    popupPage = await context.newPage();
    await popupPage.goto(popupUrl);
    await popupPage.waitForLoadState('domcontentloaded');
    await popupPage.waitForFunction(
      () => !!(window as unknown as { __shotlyTest?: unknown }).__shotlyTest,
      undefined,
      { timeout: 15_000 },
    );
  });

  test.afterAll('tear down', async () => {
    // Playwright 1.61：旧式 `afterAll(hook, timeout)` 的 timeout 会被
    // **静默忽略**（实测：50ms timeout 挂 800ms hook，照样绿）。
    // 新签名是 `afterAll(title, hook)`，超时用 `test.setTimeout()` 设。
    test.setTimeout(60_000);
    await staticServer?.close();
    await closeContextSafely(context);
  });

  test('产出 4 张真实商店截图', async () => {
    // ── 素材 1：Shotly 真实抓出来的整页长图 ─────────────────────────
    // 触发一次真实采集，拿到真实产物 PNG。
    await popupPage.evaluate(() => {
      (window as unknown as { __shotlyTest?: { capture: () => void } }).__shotlyTest?.capture();
    });

    // 等进入采集态
    await popupPage.waitForFunction(
      () => {
        const t = (window as unknown as { __shotlyTest?: { getStatus: () => string } }).__shotlyTest;
        const s = t?.getStatus();
        return s === 'capturing' || s === 'starting' || s === 'finalizing';
      },
      undefined,
      { timeout: 30_000 },
    );

    // ── 素材 3：采集中的进度条（趁采集还在跑时截） ──────────────────
    // 长页面 + 多次切片，采集过程足够长，能稳定截到进度条。
    let progressShotTaken = false;
    for (let i = 0; i < 200; i++) {
      const p = await popupPage.evaluate(() => {
        const t = (
          window as unknown as {
            __shotlyTest?: { getProgress: () => { i: number; total: number } | null };
          }
        ).__shotlyTest;
        return t?.getProgress() ?? null;
      });
      if (p && p.i > 0) {
        // ⚠️ 必须等进度条的 CSS 动画停下来再截。
        //
        // `.bar-fill` 上有 `transition: width 200ms ease`（shotly 仓库
        // entrypoints/popup/App.vue）。在进度刚出现的瞬间截图，拿到的是
        // **动画中间态** —— 进度条宽度既不是上一档也不是这一档。
        //
        // 后果：每次重新生成素材，进度条宽度都差几个像素，
        // 于是 `git status` 永远有一张图是脏的 —— 素材没法版本化，
        // 审核员看到的进度条和旁边的文字也对不上。
        //
        // 这里等两帧 + 250ms（> transition 时长），让宽度稳定下来。
        await popupPage.waitForTimeout(250);
        // 再确认一次：进度没在这段时间里跑完（跑完就没有进度条了）
        const stillCapturing = await popupPage.evaluate(() => {
          const t = (
            window as unknown as {
              __shotlyTest?: { getProgress: () => { i: number; total: number } | null };
            }
          ).__shotlyTest;
          return t?.getProgress() ?? null;
        });
        if (!stillCapturing) {
          await popupPage.waitForTimeout(60);
          continue;
        }

        // ⚠️ 断言：进度条的**实际填充宽度**要和旁边的**文字声称的比例**一致。
        //
        // 这是本 spec 存在的核心断言。之前没有它，E2E 拍到了
        // `transition: width 200ms ease` 的**动画中间态**：
        // 文字写着「2 / 5」（40%），进度条只填了 35.2% ——
        // 这张图直接被当成商店素材提交给了审核员。
        //
        // 复现方式：把上面的 waitForTimeout(250) 改成 0，
        // 这条断言会失败。
        //
        const el = await popupPage.$('.popup');
        if (el) {
          /**
           * ⚠️ 拍图**之前**先验：进度条的实际渲染宽度 == 文字声称的比例。
           *
           * popup 里：
           *   文字   `{{ progress.i + 1 }} / {{ progress.total }}`
           *   宽度   `Math.round(((progress.i+1)/total)*100)%`
           * （entrypoints/popup/App.vue）
           *
           * 两者本该一致，但 `.bar-fill` 有 `transition: width 200ms ease` ——
           * 动画没停时**渲染出来的宽度**落后于文字。
           *
           * 用 DOM 的 getBoundingClientRect 量，比事后翻像素准，
           * 而且是在**写坏素材之前**就失败。
           *
           * 同时对**两个**基准：
           *   1. 内部状态 (i+1)/total —— 状态和画面一致
           *   2. 屏幕上**渲染出来的文字** —— 文字和画面一致
           * 只对 1 的话，改了文字模板（比如写成 i/total）不会被发现；
           * 只对 2 的话，状态本身算错了不会被发现。两个都才算完。
           */
          const measured = await popupPage.evaluate(() => {
            const fill = document.querySelector<HTMLElement>('.bar-fill');
            const track = document.querySelector<HTMLElement>('.bar');
            const line = document.querySelector<HTMLElement>('.status-line');
            if (!fill || !track) return null;
            const f = fill.getBoundingClientRect().width;
            const t = track.getBoundingClientRect().width;
            return {
              ratio: t > 0 ? f / t : 0,
              trackWidth: t,
              text: line?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
            };
          });
          expect(measured, 'popup 里找不到进度条（.bar / .bar-fill）—— UI 改了？').not.toBeNull();

          const expectedRatio = (stillCapturing.i + 1) / stillCapturing.total;
          expect(
            Math.abs(measured!.ratio - expectedRatio),
            `进度条渲染宽度 ${(measured!.ratio * 100).toFixed(1)}%，` +
              `但状态说「${stillCapturing.i + 1} / ${stillCapturing.total}」` +
              `（${(expectedRatio * 100).toFixed(1)}%）—— 动画还没停下来就截图了`,
          ).toBeLessThan(0.02);

          // 屏幕上的文字（审核员看到的就是这个）
          const label = measured!.text.match(/(\d+)\s*\/\s*(\d+)/);
          expect(label, `状态行里读不出「N / M」：${measured!.text}`).not.toBeNull();
          const labelRatio = Number(label![1]) / Number(label![2]);
          expect(
            Math.abs(measured!.ratio - labelRatio),
            `进度条渲染宽度 ${(measured!.ratio * 100).toFixed(1)}%，` +
              `但屏幕上写的是「${label![1]} / ${label![2]}」` +
              `（${(labelRatio * 100).toFixed(1)}%）—— 文字和进度条对不上`,
          ).toBeLessThan(0.02);

          // eslint-disable-next-line no-console
          console.log(
            `[shotly-store] 进度条 ${(measured!.ratio * 100).toFixed(1)}% ` +
              `= 文字「${measured!.text}」✓`,
          );

          await el.screenshot({ path: join(RAW_DIR, '_raw-progress.png') });
          /**
           * 把拍图那一刻的真实进度写下来。
           *
           * 用途：shotly 仓库的 `store-assets-consistency.test.ts` 会拿这个
           * meta 去量素材里的进度条像素 —— 文字说 N/M，进度条就得填 N/M。
           *
           * 这就是当初那个 bug 的守门：E2E 在动画中间截图时，
           * 文字写「2 / 5」但进度条只填了 35.2%，审核员一看就是坏的。
           * 光靠肉眼看不出来，得拿像素和状态对账。
           */
          const metaDir = resolve(SHOTLY_REPO, 'store-assets', 'meta');
          mkdirSync(metaDir, { recursive: true });
          writeFileSync(
            join(metaDir, '03-capture-progress.json'),
            JSON.stringify(
              { i: stillCapturing.i, total: stillCapturing.total },
              null,
              2,
            ) + '\n',
          );
          // eslint-disable-next-line no-console
          console.log(
            `[shotly-store] _raw-progress.png (progress ${stillCapturing.i}/${stillCapturing.total})`,
          );
          progressShotTaken = true;
        }
        break;
      }
      await popupPage.waitForTimeout(60);
    }
    expect(progressShotTaken, '没能抓到采集中的进度条').toBe(true);

    // 等完成
    await popupPage.waitForFunction(
      () => {
        const t = (window as unknown as { __shotlyTest?: { getStatus: () => string } }).__shotlyTest;
        return t?.getStatus() === 'done';
      },
      undefined,
      { timeout: 120_000 },
    );

    // 把 popup 里那个真实 blob 取出来落盘
    const capturedDataUrl = await popupPage.evaluate(async () => {
      const t = (
        window as unknown as { __shotlyTest?: { getResult: () => { blobUrl: string } | null } }
      ).__shotlyTest;
      const url = t?.getResult()?.blobUrl;
      if (!url) return null;
      const blob = await (await fetch(url)).blob();
      return await new Promise<string>((resolve) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result));
        fr.readAsDataURL(blob);
      });
    });
    expect(capturedDataUrl, '未能取回真实捕获内容').not.toBeNull();
    const capturePath = join(RAW_DIR, '_raw-capture.png');
    writeFileSync(capturePath, Buffer.from(String(capturedDataUrl).split(',')[1] ?? '', 'base64'));

    // ── 素材 4：完成态 popup（真实预览图 + 格式选择） ────────────────
    const popupEl = await popupPage.$('.popup');
    expect(popupEl, 'popup 元素未找到').not.toBeNull();

    // ⚠️ 必须等预览图**完整解码**才能截。
    //
    // 预览图是刚捕获的那张 1280×3521 的 PNG，用 object-fit: cover
    // 缩到 132px 高。Chrome 对大图是**渐进解码**的 —— 截图那一刻
    // 可能只解了一部分，于是缩放出来的像素和「全部解完」时差 ±1。
    //
    // 后果：每次重新生成素材，popup-done 的预览图都会差几个像素，
    // 连带 04 也不一致 —— 素材没法版本化。
    //
    // `img.decode()` 会在图片**完全解码可用**时 resolve，正好是这个语义。
    // 光 waitForTimeout 是在赌运气。
    await popupPage.evaluate(async () => {
      const imgs = Array.from(document.images);
      await Promise.all(
        imgs.map((img) =>
          img.decode().catch(() => {
            /* 解码失败不致命 —— 图可能还没挂上 */
          }),
        ),
      );
    });
    await popupPage.waitForTimeout(500);

    // ⚠️ 截**两次**，两次必须字节一致。
    //
    // 预览图是刚捕获的 1280×3521 大 PNG，Chrome 渐进解码 ——
    // 截图那一刻可能只解了一部分，缩放到 132px 高后像素会差 ±1。
    // 后果：每次重新生成素材，popup-done 都和上次不一样，
    // 连带 04 也不一样 → 素材没法版本化，提交到 CWS 的是哪一版说不清。
    //
    // 「截两次比一比」比「等固定时长」可靠：
    // 如果解码还没完成，第一次和第二次拍到的是**不同阶段**的半成品，
    // 字节必然不同 → 立刻暴露。解码完成了，两次就是同一张。
    const popupShot1 = await popupEl!.screenshot();
    const popupShot2 = await popupEl!.screenshot();
    expect(
      popupShot2.equals(popupShot1),
      'popup 截图两次不一致 —— 预览图还没解码完（Chrome 渐进解码大 PNG），' +
        '素材会每次重新生成都不一样',
    ).toBe(true);
    writeFileSync(join(RAW_DIR, '_raw-popup-done.png'), popupShot2);
    // eslint-disable-next-line no-console
    console.log('[shotly-store] _raw-popup-done.png');

    // ── 素材 2：真实网页上的区域框选浮层 ─────────────────────────────
    // 点「区域截图」，等 content script 画出浮层，再拖一个选框。
    // 用 data-shotly-action 定位，不要用可见文案——文案会随语言变，
    // 定位钩子不变。
    await popupPage.evaluate(() => {
      const region = document.querySelector<HTMLButtonElement>(
        'button[data-shotly-action="region"]',
      );
      region?.click();
    });
    await targetPage.waitForSelector('[data-shotly-region-overlay="1"]', { timeout: 20_000 });
    await targetPage.waitForTimeout(400);

    // 拖出一个选框，让截图里能看到真实的选区高亮 + 尺寸标签
    const box = await targetPage.evaluate(() => {
      const o = document.querySelector('[data-shotly-region-overlay="1"]');
      const r = o?.getBoundingClientRect();
      return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
    });
    expect(box, '区域浮层没有尺寸').not.toBeNull();
    const x0 = box!.x + 180;
    const y0 = box!.y + 150;
    await targetPage.mouse.move(x0, y0);
    await targetPage.mouse.down();
    await targetPage.mouse.move(x0 + 520, y0 + 330, { steps: 12 });
    await targetPage.waitForTimeout(350);
    await targetPage.screenshot({ path: join(RAW_DIR, '_raw-region.png') });
    // eslint-disable-next-line no-console
    console.log('[shotly-store] _raw-region.png');
    await targetPage.mouse.up();

    // ── 组装 4 张 1280×800 商店图 ────────────────────────────────────
    const captureData = pngDataUrl(capturePath);
    await composeStoreImage(context, {
      file: '01-full-page-capture.png',
      headline: 'One click, the whole page',
      sub: 'Shotly scrolls, stitches and trims every slice — including the short last one — into one clean image.',
      images: [{ src: captureData }],
      layout: 'hero',
    });

    await composeStoreImage(context, {
      file: '02-region-selection.png',
      headline: 'Drag. Capture. Done.',
      sub: 'Select exactly the region you need — a chart, a paragraph, a table — down to 100×100.',
      images: [{ src: pngDataUrl(join(RAW_DIR, '_raw-region.png')) }],
      layout: 'fit',
    });

    await composeStoreImage(context, {
      file: '03-capture-progress.png',
      headline: 'Live progress, no guessing',
      sub: 'Every slice is captured and stitched in the background. Nothing is uploaded, nothing is tracked.',
      images: [{ src: pngDataUrl(join(RAW_DIR, '_raw-progress.png')) }],
      layout: 'single',
    });

    await composeStoreImage(context, {
      file: '04-result-and-formats.png',
      headline: 'PNG, JPG or PDF',
      sub: 'Preview the real result, then export in the format you need — or copy straight to the clipboard.',
      images: [
        { src: pngDataUrl(join(RAW_DIR, '_raw-popup-done.png')), label: 'the popup' },
        { src: captureData, label: 'the full page it produced', fit: 'cover' },
      ],
      layout: 'split',
    });

    for (const f of [
      '01-full-page-capture.png',
      '02-region-selection.png',
      '03-capture-progress.png',
      '04-result-and-formats.png',
    ]) {
      const p = join(OUT_DIR, f);
      expect(existsSync(p), `缺少素材 ${f}`).toBe(true);
      expect(readFileSync(p).length, `素材 ${f} 为空`).toBeGreaterThan(10_000);
      // eslint-disable-next-line no-console
      console.log(`[shotly-store] ✓ ${f} (${readFileSync(p).length} bytes)`);
    }

    /**
     * 素材必须**可复现** —— 重新生成得到字节完全一样的文件。
     *
     * ## 为什么这重要
     *
     * 这 4 张图要提交给 Chrome Web Store，提交后**改不了**。
     * 如果它们每次生成都不一样，那么：
     * - 每次重新生成，`git status` 都有一张图是脏的 → 无法版本化；
     * - 没人能说清「仓库里那张」和「现在跑出来那张」是不是同一张；
     * - 提交到 CWS 的到底是哪一版，只有天知道。
     *
     * ## 踩过的坑（两个，都是 ±1 像素）
     *
     * 1. **CSS 动画中间态**：`.bar-fill` 有 `transition: width 200ms`，
     *    在进度刚出现时截图，拍到的是动画中途 —— 文字写 2/5 但只填了 35.2%。
     * 2. **渐进解码**：预览图是 1280×3521 的大 PNG，Chrome 渐进解码，
     *    截图那一刻可能只解了一部分，缩放后像素差 ±1。
     *
     * 两个都已经修（等 transition 结束 / 等 `img.decode()`），
     * 这条断言就是防它们改回去。
     *
     * ## 怎么查
     *
     * 用**同一批原始像素**重新合成一遍，逐字节对比。
     * 合成是纯函数（同样的输入 → 同样的输出），
     * 所以第二次应该和第一次完全一样。
     */
    {
      const firstPass = new Map(
        ['01-full-page-capture.png', '02-region-selection.png', '03-capture-progress.png', '04-result-and-formats.png'].map(
          (f) => [f, readFileSync(join(OUT_DIR, f))],
        ),
      );

      // 用同一批 raw 中间产物重新合成一遍
      await composeStoreImage(context, {
        file: '01-full-page-capture.png',
        headline: 'One click, the whole page',
        sub: 'Shotly scrolls, stitches and trims every slice — including the short last one — into one clean image.',
        images: [{ src: captureData }],
        layout: 'hero',
      });
      await composeStoreImage(context, {
        file: '02-region-selection.png',
        headline: 'Drag. Capture. Done.',
        sub: 'Select exactly the region you need — a chart, a paragraph, a table — down to 100×100.',
        images: [{ src: pngDataUrl(join(RAW_DIR, '_raw-region.png')) }],
        layout: 'fit',
      });
      await composeStoreImage(context, {
        file: '03-capture-progress.png',
        headline: 'Live progress, no guessing',
        sub: 'Every slice is captured and stitched in the background. Nothing is uploaded, nothing is tracked.',
        images: [{ src: pngDataUrl(join(RAW_DIR, '_raw-progress.png')) }],
        layout: 'single',
      });
      await composeStoreImage(context, {
        file: '04-result-and-formats.png',
        headline: 'PNG, JPG or PDF',
        sub: 'Preview the real result, then export in the format you need — or copy straight to the clipboard.',
        images: [
          { src: pngDataUrl(join(RAW_DIR, '_raw-popup-done.png')), label: 'the popup' },
          { src: captureData, label: 'the full page it produced', fit: 'cover' },
        ],
        layout: 'split',
      });

      for (const [f, first] of firstPass) {
        const second = readFileSync(join(OUT_DIR, f));
        expect(
          second.equals(first),
          `${f} 重新生成后和第一次不一致（${first.length} vs ${second.length} 字节）—— ` +
            `素材不可复现，提交到 CWS 的到底是哪一版说不清`,
        ).toBe(true);
      }
      // eslint-disable-next-line no-console
      console.log('[shotly-store] ✓ 4 张素材重新生成后字节一致（可复现）');
    }

    // 把刚落盘的 4 张图读成 data URL，交给浏览器去做像素检查
    // （静态服务器只服务测试页目录，所以不走 HTTP，直接内联）
    const storeImageFiles = [
      '01-full-page-capture.png',
      '02-region-selection.png',
      '03-capture-progress.png',
      '04-result-and-formats.png',
    ];
    const storeImageDataUrls = storeImageFiles.map((f) => pngDataUrl(join(OUT_DIR, f)));

    /**
     * 像素内容检查 —— 光看字节数抓不到「空白图」。
     *
     * ## 为什么这条是必须的
     *
     * 这 4 张图是要**直接上传到 Chrome Web Store** 的。提交前没法改 ——
     * 审核员看到的就是这些图。
     *
     * 而 1280×800 的纯白 PNG 压缩后也有几十 KB —— 上面那条
     * `byteSize > 10_000` **照样通过**。整个 spec 在「4 张图全是白纸」
     * 的情况下依然会绿。
     *
     * 之前真实踩过：stitch 的 crop 参数成了 NaN，
     * `canvas.drawImage` 遇到非有限参数**静默不绘制**（不抛错），
     * 落盘的是纯白图，所有字节数断言全过。
     *
     * ## 为什么还要逐段查
     *
     * 全图统计抓不住「局部缺失」：只要有一段有内容，全图比例就不会被拉低。
     * 所以每张图**按 400px 一段**查，每段都得有内容。
     */
    const stats = await popupPage.evaluate(async (dataUrls: string[]) => {
      const bandHeight = 400;
      const out: Array<{
        uniqueColors: number;
        nonWhiteRatio: number;
        emptyBands: number[];
      }> = [];

      for (const dataUrl of dataUrls) {
        const img = new Image();
        img.src = dataUrl;
        await img.decode();
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(img, 0, 0);
        const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);

        const colors = new Set<number>();
        let nonWhite = 0;
        let total = 0;
        for (let i = 0; i < data.length; i += 4 * 31) {
          total++;
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];
          if (!(r > 245 && g > 245 && b > 245)) nonWhite++;
          colors.add(((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3));
        }

        // 逐段查：每 400px 一段都得有内容
        const bandCount = Math.ceil(canvas.height / bandHeight);
        const emptyBands: number[] = [];
        for (let b = 0; b < bandCount; b++) {
          const y0 = b * bandHeight;
          const h = Math.min(bandHeight, canvas.height - y0);
          const band = ctx.getImageData(0, y0, canvas.width, h).data;
          let bn = 0;
          let bt = 0;
          for (let i = 0; i < band.length; i += 4 * 31) {
            bt++;
            const r = band[i];
            const g = band[i + 1];
            const bl = band[i + 2];
            if (!(r > 245 && g > 245 && bl > 245)) bn++;
          }
          if (bt > 0 && bn / bt < 0.005) emptyBands.push(b);
        }

        out.push({
          uniqueColors: colors.size,
          nonWhiteRatio: total > 0 ? nonWhite / total : 0,
          emptyBands,
        });
      }
      return out;
    }, storeImageDataUrls);

    for (const [i, s] of stats.entries()) {
      const name = storeImageFiles[i];
      expect(
        s.uniqueColors,
        `${name} 只有 ${s.uniqueColors} 种颜色 —— 可能是纯色/空白图`,
      ).toBeGreaterThan(3);
      expect(
        s.nonWhiteRatio,
        `${name} 非白像素占比只有 ${s.nonWhiteRatio.toFixed(4)} —— 几乎全白`,
      ).toBeGreaterThan(0.005);
      expect(
        s.emptyBands,
        `${name} 第 ${s.emptyBands.join(', ')} 段（每段 400px）是空的 —— 局部没画上`,
      ).toEqual([]);
    }
  });
});
