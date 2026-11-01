/**
 * Shotly 隐私保证 E2E —— 「不向任何第三方服务器发一个请求」
 *
 * 背景：Shotly 的核心卖点是「截图不出你的电脑」「不上传、不追踪」。
 * 商店 listing 把它写成第一卖点，隐私政策按「不收集用户数据」提交。
 *
 * **如果这条是假的，商店审核会拒，用户也会被坑。** 所以它必须被测。
 *
 * 为什么必须是运行时断言，不能靠 grep 构建产物？
 *   - 打包后 fetch 的参数是运行时变量，静态看不出它指向哪
 *   - 真正要防的是「有人加了一行埋点 SDK」——那得**跑起来**才抓得到
 *   - 静态扫描只能证明「现在没有」，证明不了「跑起来没有」
 *
 * 做法：给 BrowserContext 装一个网络拦截器，记录扩展跑**真实截图流程**
 *       期间发出的每一个请求，然后断言这些请求全部指向本地。
 *
 * ⚠️ 这个测试不能空转：如果截图流程根本没跑起来，「零请求」也是绿的。
 *     所以用 harness 的 runCapture() —— 它带像素级分析，能证明
 *     截图真的产出了非空白长图。断言里同时校验这一点。
 */

import { test, expect } from '@playwright/test';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { launchShotly, runCapture, type ShotlyHarness } from './helpers/shotly-harness';

/** 允许的请求来源 —— 全部是本地的。 */
function isLocalRequest(url: string): boolean {
  if (url.startsWith('chrome-extension://')) return true; // 扩展自身资源
  if (url.startsWith('data:')) return true; // 内联数据
  if (url.startsWith('blob:')) return true; // 扩展内部生成的 blob URL
  if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) return true; // 被测页面
  if (url === 'about:blank') return true;
  if (url.startsWith('chrome://')) return true;
  return false;
}

test.describe('Shotly 隐私保证（无第三方网络请求）', () => {
  let harness: ShotlyHarness;
  /** 扩展跑起来期间发出的所有请求。 */
  const observed: Array<{ url: string; method: string; resourceType: string }> = [];

  test.beforeAll(async () => {
    harness = await launchShotly({
      bootWaitMs: 8000,
      // ⚠️ 拦截器必须在扩展启动**之前**装好。
      //    扩展装上就执行顶层代码（埋点 SDK 的典型行为），
      //    晚装一步就漏掉了最该抓的那批请求。
      onContext: async (ctx) => {
        await ctx.route('**/*', async (route) => {
          const req = route.request();
          observed.push({
            url: req.url(),
            method: req.method(),
            resourceType: req.resourceType(),
          });
          await route.continue().catch(() => {
            /* 某些 chrome-extension:// 资源不可拦截，忽略 */
          });
        });
      },
    });
  });

  test.afterAll(async () => {
    await harness?.close();
  });

  test('跑完整截图流程，全程零第三方请求', async () => {
    // ── 1. 跑真实截图（harness 会做像素级校验） ──
    const outcome = await runCapture(harness, {
      targetUrl: harness.server.page('long-page.html'),
      timeoutMs: 120_000,
    });

    expect(outcome.status, `截图流程失败：${outcome.status === 'error' ? outcome.error : ''}`).toBe(
      'done',
    );
    if (outcome.status !== 'done') return;

    // ── 2. 确认截图**真的**产出了内容（防止本用例空转） ──
    expect(outcome.result.byteSize, '截图是空的').toBeGreaterThan(1000);
    expect(outcome.analysis.height, '截图高度不对').toBeGreaterThan(800);
    expect(
      outcome.analysis.nonWhiteRatio,
      '截图是一片空白 —— 流程没真跑，零请求就没有意义',
    ).toBeGreaterThan(0.05);
    expect(
      outcome.analysis.bands.every((b) => b > 0.01),
      `有整段是空白的：${JSON.stringify(outcome.analysis.bands)}`,
    ).toBe(true);

    // ── 3. 断言：没有一个请求指向第三方 ──
    const external = observed.filter((r) => !isLocalRequest(r.url));

    console.log(`[shotly-privacy] 整个流程共 ${observed.length} 条请求：`);
    for (const r of observed) {
      console.log(`   [${r.method}] ${r.resourceType} ${r.url}`);
    }

    expect(
      external,
      `扩展在跑截图流程时发出了 ${external.length} 个第三方请求：\n` +
        external.map((r) => `  ${r.method} ${r.resourceType} ${r.url}`).join('\n') +
        `\n这直接违反「不上传、不追踪」的承诺，会被商店审核拒。`,
    ).toEqual([]);
  });

  test('构建产物里没有硬编码的第三方网络请求', async () => {
    // 运行时断言防「现在」，静态断言防「将来有人偷偷加进代码但还没触发」
    //
    // ⚠️ 目录不存在时必须**报错**，不能静默通过 ——
    //    readdirSync 遇到不存在的目录会抛错（这点是好的），
    //    但如果哪天有人写成 existsSync 判断 + 直接 return，
    //    这个守门就变成「扫了 0 个文件 = 没问题」的假绿。
    const builtDir = join(process.cwd(), '.output', 'chrome-mv3');
    expect(
      existsSync(builtDir),
      `构建产物不存在：${builtDir} —— 这个守门就扫不到任何文件，会假绿`,
    ).toBe(true);

    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.js')) files.push(p);
      }
    };
    walk(builtDir);

    // 扫到 0 个 js = 可疑（构建产物结构变了，或者扫错了目录）
    expect(
      files.length,
      `在 ${builtDir} 里一个 .js 都没扫到 —— 守门没在测东西`,
    ).toBeGreaterThan(0);

    const suspects: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      // 只看真正会被当成 URL 用的地方：fetch / XHR.open / importScripts 的字面量实参
      const netCalls =
        src.match(
          /(?:fetch|axios\.(?:get|post|put)|\.open)\s*\(\s*['"`](https?:\/\/[^'"`]+)/g,
        ) ?? [];
      for (const c of netCalls) suspects.push(`${f}: ${c}`);
      const scriptLoads = src.match(/importScripts\s*\(\s*['"`](https?:\/\/[^'"`]+)/g) ?? [];
      for (const c of scriptLoads) suspects.push(`${f}: ${c}`);
    }

    expect(
      suspects,
      `构建产物里出现了硬编码的第三方网络请求：\n${suspects.join('\n')}`,
    ).toEqual([]);

    console.log(`[shotly-privacy] 静态检查：${files.length} 个 JS 文件，无硬编码第三方请求`);
  });
});
