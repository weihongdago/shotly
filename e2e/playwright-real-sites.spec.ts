/**
 * Shotly 真实站点冒烟（Real-site smoke）
 *
 * ## 为什么需要
 *
 * DoD 里有一条：「5 个测试站点（GitHub / Twitter / Wikipedia / 长博客 /
 * 内部 SPA）截图全部成功」。
 *
 * 但到现在为止，所有 E2E 都跑在**本地 fixture** 上（`e2e/test-pages/`、
 * `poc-d3/fixtures/`）。fixture 是我们自己写的 HTML ——
 * 它没有真实站点的那些麻烦：
 *
 *   - 真实站点的 DOM 规模（GitHub 一个页面几万个节点）
 *   - 懒加载 / 虚拟滚动（滚到底才加载的图片）
 *   - 固定定位的头像、侧边栏（拼接时容易错位）
 *   - CSP / 跨域 iframe / web font
 *   - 页面高度动辄几万 px（Twitter 时间线）
 *
 * fixture 全绿 ≠ 真实站点能抓。这是**没有测过的领域**，不是「测过了没问题」。
 *
 * ## 为什么默认不跑（而且要显式排除，不是静默 skip）
 *
 * 真实站点测试有三个固有特性：
 *   1. **依赖网络** —— 网络抖一下就红
 *   2. **依赖站点现状** —— 站点改版 / 加广告 / 改布局，测试就红
 *   3. **慢** —— 每站十几秒到一分钟
 *
 * 所以它**不能**进阻塞 CI：否则第三方站点一改版，我们的 CI 就红，
 * 大家会开始习惯性地重跑甚至忽略它 —— 守门一旦变成噪音就没了。
 *
 * 但「不能进阻塞 CI」不等于「不存在」。这里的做法是：
 *
 *   - 单独一个 Playwright **project**（`real-sites`，见 `playwright.config.ts`），
 *     合并门禁那个 project（`chromium`）用 `testIgnore` 显式排除它 ——
 *     是**显式排除**，不是 `test.skip()`（静默 skip 是最坏的语义，见 memory：
 *     silent-skip-is-worse-than-hard-failure）
 *   - 单独一个 npm script：`pnpm test:e2e:real`（= `--project=real-sites`）
 *   - 单独一个 GitHub workflow：**每天定时跑**（schedule），
 *     跑挂了会发通知 —— 相当于「定期体检报告」，
 *     而不是「每次 push 都拦你一下」
 *
 * ⚠️ ⚠️ **不要用 `playwright test`（不带 `--project`）跑自检。**
 *
 *    那会把 `real-sites` 也跑上 —— 6 条打真网站的用例，
 *    会因限流/改版/网络抖动而红，而那**跟 Shotly 能不能提交没关系**。
 *    提审手册里那条自检命令因此写的是 `pnpm test:e2e`（= `--project=chromium`），
 *    手动跑也一样：`pnpm test:e2e`。
 *
 *    （反面教材：以前手册里写的是 `playwright test e2e/` —— 不带 project，
 *    实际跑的是 40 条含真实站点，数字和命令都对不上。）
 *
 * ## 判定标准
 *
 * 不看「图好不好看」，只看三件硬事实：
 *   1. **抓完了**（status === 'done'，没有 timeout / error）
 *   2. **输出不是空白图**（唯一颜色数 > 阈值）
 *   3. **高度合理**（> 一屏，且不超过该站点的合理上限）
 *
 * 真实站点无法断言像素级内容 —— 站点随时会改。
 * 断言「抓成功了且不是白纸」就已经覆盖了 DoD 的核心意图。
 */

import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  assertBuildIsFresh,
  launchShotly,
  probeReachability,
  runCapture,
  SHOTLY_BUILT,
} from './helpers/shotly-harness';

const REPORT_DIR = resolve(process.cwd(), 'reports', 'real-sites');

interface SiteCase {
  /** 稳定标识，用于报告和失败信息。 */
  id: string;
  /** DoD 里点名的站点。 */
  label: string;
  url: string;
  /** 该站点的合理高度区间（px）—— 站点改版时这个也要跟着改。 */
  minHeight: number;
  maxHeight: number;
  /**
   * 预期结果。
   *
   * - `capture`（默认）：应该抓成功。
   * - `too-long`：页面**故意**超过了硬上限（`HARD_PAGE_LIMIT_PX = 50_000`）。
   *   这不是失败 —— 是**正确行为**：拼接画布再大 Chrome 会 OOM，
   *   所以产品主动拒绝并引导用户改用区域截取。
   *   这种情况要断言的是「**给了明确的中文提示**，而不是崩了/静默卡住」。
   */
  expect: 'capture' | 'too-long';
  /**
   * 额外等待（ms）：真实站点有些内容是滚到底才加载的。
   * 只在少数站点上加，不要写成全局默认。
   */
  settleMs?: number;
}

const SITES: SiteCase[] = [
  {
    id: 'wikipedia',
    label: 'Wikipedia（长文章）',
    // ⚠️ 用的是 test-plan-v1.md 里点名的词条（实测 7_529px，在上限内）。
    //    别换成别的词条 —— Wikipedia 的导航框（navbox）会让很多词条
    //    突然变成 60_000px+（例：Beijing 实测 63_969px），
    //    那样这条用例就变成「测超限」而不是「测截图」了。
    url: 'https://en.wikipedia.org/wiki/Web_browser',
    minHeight: 3_000,
    maxHeight: 20_000,
    expect: 'capture',
  },
  {
    id: 'wikipedia-oversized',
    label: 'Wikipedia（超过硬上限的词条）',
    url: 'https://en.wikipedia.org/wiki/Wikipedia',
    minHeight: 0,
    maxHeight: 0,
    // ⚠️ 这个词条实测 ~67_000px，超过 50_000px 的硬上限。
    //    所以正确行为不是「抓成功」，而是「明确告知用户页面太长，
    //    并建议改用区域截取」。这条用例守的就是这个。
    expect: 'too-long',
  },
  {
    id: 'github',
    label: 'GitHub（仓库页）',
    url: 'https://github.com/openclaw/openclaw',
    minHeight: 3_000,
    maxHeight: 40_000,
    expect: 'capture',
  },
  {
    id: 'x-com',
    label: 'X / Twitter（时间线）',
    // 未登录时 X 会跳登录页 —— 那时抓到的仍然是个真页面，
    // 判定标准是「抓到了非空白图」，不要求内容是时间线。
    url: 'https://x.com/explore',
    minHeight: 300,
    maxHeight: 40_000,
    expect: 'capture',
  },
  {
    id: 'long-blog',
    label: '长博客（单篇长文）',
    url: 'https://martinfowler.com/articles/microservices.html',
    minHeight: 5_000,
    maxHeight: 40_000,
    expect: 'capture',
  },
  {
    id: 'example-spa',
    label: '内部 SPA 替身（客户端路由 + 懒加载图片）',
    // react.dev 是 Next.js 渲染的（实测 9 张图里 8 张带 loading="lazy"），
    // 路由是客户端的（不是 hash 路由 —— 之前标签写错了）。
    url: 'https://react.dev/learn',
    minHeight: 3_000,
    maxHeight: 40_000,
    expect: 'capture',
  },
];

interface SiteReport {
  id: string;
  label: string;
  url: string;
  status: string;
  pageHeight: number;
  outputWidth: number;
  outputHeight: number;
  byteSize: number;
  uniqueColors: number;
  nonWhiteRatio: number;
  durationMs: number;
  /** 失败/拒绝时的原因（null = 没有）。 */
  error?: string | null;
  /** 网络不可达（跟产品无关，跳过了这个站）。 */
  networkUnreachable?: boolean;
}

test.describe('Shotly 真实站点冒烟', () => {
  let harness: Awaited<ReturnType<typeof launchShotly>> | undefined;
  const reports: SiteReport[] = [];

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    // ⚠️ 硬失败而不是 test.skip。
    //    「没 build / build 旧了」就静默跳过 = 这套用例什么都没测，
    //    但报告看起来是绿的。而真实站点套件的价值恰恰在于
    //    「每个站点的结论都可见」—— 静默跳过连这个都没有。
    //
    //    实际踩中过（2026-11-05）：改了 i18n 文案但没重新 build，
    //    测的是旧产物，断言「提示里应该建议改用区域截图」失败，
    //    一度以为是产品没改对。
    assertBuildIsFresh(SHOTLY_BUILT);
    mkdirSync(REPORT_DIR, { recursive: true });
    harness = await launchShotly();
  });

  test.afterAll('写出报告', async () => {
    test.setTimeout(60_000);
    await harness?.close();
    writeFileSync(
      join(REPORT_DIR, 'real-sites-report.json'),
      JSON.stringify(reports, null, 2),
      'utf-8',
    );
    writeFileSync(join(REPORT_DIR, 'real-sites-logs.txt'), harness?.logs.join('\n') ?? '', 'utf-8');
  });

  for (const site of SITES) {
    // ⚠️ 标题要说清楚这条**到底在断言什么**。
    //    「超过硬上限的词条 能抓成功」是自相矛盾的 ——
    //    它要断言的恰恰是「抓不成，但必须说清楚为什么、怎么办」。
    test(
      site.expect === 'too-long'
        ? `${site.label} 会明确拒绝并给出下一步`
        : `${site.label} 能抓成功`,
      async () => {
      test.setTimeout(300_000);
      const started = Date.now();
      const base: SiteReport = {
        id: site.id,
        label: site.label,
        url: site.url,
        status: 'unknown',
        pageHeight: 0,
        outputWidth: 0,
        outputHeight: 0,
        byteSize: 0,
        uniqueColors: 0,
        nonWhiteRatio: 0,
        durationMs: 0,
      };

      /**
       * ⚠️ 报告只推一次。
       * 之前写法在 `expect` 抛错后又被 catch 推了一次 ——
       * 结果是同一个站点在报告里出现两条，看起来像“跑了两次”。
       */
      let pushed = false;
      const push = () => {
        if (!pushed) {
          pushed = true;
          reports.push(base);
        }
      };

      try {
        // ── 先探活：网络不可达不是 Shotly 的问题 ──
        //
        // ⚠️ 这里**只能 skip，不能 fail** —— 但必须同时打上
        //    `network-unreachable` 标注，并且写进报告和 summary。
        //
        //    静默 skip 是最坏的语义：看绿的人以为「测过了，其实没测」。
        //    所以 skip 的代价是「必须在别处明确说出来」——
        //    这就是标注 + 报告 + summary 三处都要写的原因。
        const reach = await probeReachability(harness!.context, site.url);
        if (!reach.reachable) {
          base.status = 'network-unreachable';
          base.networkUnreachable = true;
          base.error = reach.reason ?? 'unreachable';
          base.durationMs = Date.now() - started;
          push();
          test.info().annotations.push({
            type: 'network-unreachable',
            description: `${site.url} 不可达：${base.error}`,
          });
          test.skip(true, `网络不可达（与 Shotly 无关）：${base.error}`);
        }

        const outcome = await runCapture(harness!, {
          targetUrl: site.url,
          timeoutMs: 180_000,
          beforeCapture:
            site.settleMs !== undefined
              ? async (page) => {
                  await page.waitForTimeout(site.settleMs as number);
                }
              : undefined,
        });

        base.status = outcome.status;
        base.durationMs = Date.now() - started;

        // ── 页面太长：这是**正确行为**，要断言的是提示而不是崩溃 ──
        if (outcome.status === 'error' && isTooLong(outcome.error)) {
          base.status = 'too-long';
          base.error = outcome.error ?? null;
          push();

          if (site.expect === 'too-long') {
            // 提示要说清楚：页面多高、上限多少、**建议怎么办**。
            //
            // 最后一条是重点：架构 §4 明确要求「页面过长，建议区域截图」。
            // 只说「不行」不说「怎么办」的提示 = 用户直接放弃。
            expect(
              outcome.error,
              `${site.label} 页面太长，但没给出任何提示 —— 用户会不知道发生了什么`,
            ).not.toBeNull();
            expect(
              outcome.error ?? '',
              `${site.label} 的提示里应该提到高度上限`,
            ).toMatch(/\d/);
            expect(
              outcome.error ?? '',
              `${site.label} 的提示里应该建议改用区域截图 —— 否则用户只会放弃`,
            ).toMatch(/region|区域/i);
            return;
          }
          // 预期能抓成功的站点却报太长 —— 页面可能变长了，要看见。
          expect(
            outcome.error ?? '',
            `${site.label} 本应能抓成功，却报「页面太长」：${outcome.error}`,
          ).toBe('');
          return;
        }

        if (outcome.status !== 'done') {
          base.error = outcome.error ?? `status=${outcome.status}`;
          push();
          expect(outcome.status, `${site.label} 没抓成功：${base.error}`).toBe('done');
          return;
        }

        const { result, analysis } = outcome;
        base.pageHeight = result.height;
        base.outputWidth = result.width;
        base.outputHeight = result.height;
        base.byteSize = result.byteSize;
        base.uniqueColors = analysis.uniqueColors;
        base.nonWhiteRatio = analysis.nonWhiteRatio;
        push();

        expect(result.byteSize, `${site.label} 输出是空的`).toBeGreaterThan(5_000);
        expect(
          analysis.uniqueColors,
          `${site.label} 几乎是纯色（${analysis.uniqueColors} 种颜色）—— 抓到了空白页`,
        ).toBeGreaterThan(3);
        expect(
          analysis.nonWhiteRatio,
          `${site.label} 几乎全白（${analysis.nonWhiteRatio}）—— 抓到了空白页`,
        ).toBeGreaterThan(0.002);
        expect(
          result.height,
          `${site.label} 输出高度 ${result.height}px 不在合理区间 ${site.minHeight}~${site.maxHeight}`,
        ).toBeGreaterThan(site.minHeight);
        expect(
          result.height,
          `${site.label} 输出高度 ${result.height}px 不在合理区间 ${site.minHeight}~${site.maxHeight}`,
        ).toBeLessThan(site.maxHeight);
      } catch (err) {
        base.status = base.status === 'unknown' ? 'error' : base.status;
        base.error = err instanceof Error ? err.message : String(err);
        base.durationMs = Date.now() - started;
        push();
        throw err;
      }
      },
    );
  }
});

/**
 * 报错是不是「页面太长」。
 *
 * ⚠️ 匹配的是**中文文案里的关键信息**，而不是错误码 ——
 * popup 把 reason 翻译成用户语言了（`error.pageTooLongReason`），
 * 英文只是 fallback。这里匹配两种语言都行，
 * 因为判定的是「产品主动拒绝了」，不是「具体怎么措辞的」。
 */
function isTooLong(error: string | null | undefined): boolean {
  if (!error) return false;
  return /too long|too-long|太长|过长|超过/i.test(error);
}
