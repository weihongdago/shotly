/**
 * Shotly PoC-D3 五场景真实浏览器 E2E
 *
 * 场景定义在 shotly/poc-d3/scenarios/，每个场景的验收清单也在那里。
 * 这个 spec 把那五份清单变成可执行的断言 —— 跑的是真实 Chrome + 真实
 * 扩展 + 真实 fixture，不是 mockup。
 *
 * 断言全部基于**像素**，不是 byteSize：
 * stitch 几何算错时 drawImage 静默失败，画出纯白图，而纯白 PNG 仍有
 * 100KB+，只看数字的断言会全部通过。
 */

import { test, expect } from '@playwright/test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  SHOTLY_BUILT,
  launchShotly,
  runCapture,
  signatureDistance,
  type ShotlyHarness,
} from './helpers/shotly-harness';

const REPORT_DIR = resolve(process.cwd(), 'reports', 'poc-d3');

/** A band that is basically empty — one slice never made it into the canvas. */
const EMPTY_BAND = 0.005;

interface ScenarioReport {
  scenario: string;
  fixture: string;
  pageHeight: number;
  outputWidth: number;
  outputHeight: number;
  byteSize: number;
  uniqueColors: number;
  nonWhiteRatio: number;
  bands: number;
  emptyBands: number[];
  durationMs: number;
  notes: string[];
}

const reports: ScenarioReport[] = [];

test.describe.configure({ mode: 'serial' });

test.describe('Shotly PoC-D3 真实浏览器五场景', () => {
  let harness: ShotlyHarness;

  test.beforeAll('launch browser', async () => {
    /**
     * ⚠️ Playwright 1.61 改了 hook 的签名：
     *    旧式 `beforeAll(hook, timeout)` 的 timeout 会被**静默忽略**
     *    （实测：50ms 的 timeout 挂着 800ms 的 hook，照样绿）。
     *    新签名是 `beforeAll(title, hook)`，超时用 `test.setTimeout()` 设。
     *
     * 这里尤其重要：启动真浏览器要 120s，用默认的 30s 会随机挂。
     */
    test.setTimeout(120_000);
    test.skip(!existsSync(SHOTLY_BUILT), `shotly 未 build：${SHOTLY_BUILT}`);
    mkdirSync(REPORT_DIR, { recursive: true });
    harness = await launchShotly();
  });

  test.afterAll('tear down', async () => {
    test.setTimeout(60_000);
    await harness?.close();
    writeFileSync(
      join(REPORT_DIR, 'poc-d3-report.json'),
      JSON.stringify(reports, null, 2),
      'utf-8',
    );
    writeFileSync(join(REPORT_DIR, 'poc-d3-logs.txt'), harness?.logs.join('\n') ?? '', 'utf-8');
  });

  // ── S1 ──────────────────────────────────────────────────────────────────────
  test('S1 短页标准场景：拼接正确、无横向条纹、首尾完整', async () => {
    test.setTimeout(180_000);
    const started = Date.now();
    const outcome = await runCapture(harness, {
      targetUrl: harness.server.fixture('01-wikipedia.html'),
      timeoutMs: 120_000,
    });

    expect(outcome.status, `S1 未完成：${JSON.stringify(outcome)}`).toBe('done');
    if (outcome.status !== 'done') return;
    const { result, analysis } = outcome;

    // 页面高 4_500 ~ 5_500px，输出应当是同一量级（不小于一屏）。
    expect(result.height, 'S1 输出高度应 > 一屏').toBeGreaterThan(800);
    expect(result.height, 'S1 输出高度应在 5_000px 量级').toBeLessThan(20_000);

    // 内容断言
    expect(analysis.uniqueColors, `S1 几乎是纯色：${analysis.uniqueColors}`).toBeGreaterThan(3);
    expect(analysis.nonWhiteRatio, `S1 几乎全白：${analysis.nonWhiteRatio}`).toBeGreaterThan(0.005);

    // 逐段断言
    const empty = analysis.bands
      .map((ratio, i) => ({ i, ratio }))
      .filter((b) => b.ratio < EMPTY_BAND);
    expect(empty, `S1 以下横向带是空的：${JSON.stringify(empty)}`).toEqual([]);

    pushReport({
      scenario: 'S1',
      fixture: '01-wikipedia.html',
      pageHeight: result.height,
      outputWidth: result.width,
      outputHeight: result.height,
      byteSize: result.byteSize,
      uniqueColors: analysis.uniqueColors,
      nonWhiteRatio: analysis.nonWhiteRatio,
      bands: analysis.bands.length,
      emptyBands: empty.map((b) => b.i),
      durationMs: Date.now() - started,
      notes: ['短页标准场景，全绿'],
    });
  });

  // ── S2 ──────────────────────────────────────────────────────────────────────
  test('S2 超长页 + 高 DPR：多段拼接完整，不触发 SW idle-kill', async () => {
    test.setTimeout(600_000);
    const started = Date.now();

    // 高 DPR 必须用独立的 context —— deviceScaleFactor 在
    // launchPersistentContext 时定死，运行中改不了。
    const dpr2 = await launchShotly({ deviceScaleFactor: 2 });

    try {
      const outcome = await runCapture(dpr2, {
        targetUrl: dpr2.server.fixture('02-notion-mock.html'),
        timeoutMs: 420_000,
      });

      expect(outcome.status, `S2 未完成：${JSON.stringify(outcome)}`).toBe('done');
      if (outcome.status !== 'done') return;
      const { result, analysis } = outcome;

      // 页面 30_000px；DPR=2 时输出宽 2_600 量级、高 30_000 量级。
      expect(result.height, 'S2 输出高度应覆盖整页').toBeGreaterThan(25_000);
      expect(result.width, 'S2 DPR=2 输出宽度应为 CSS 宽度的两倍').toBeGreaterThan(2_400);

      expect(analysis.uniqueColors, `S2 几乎是纯色：${analysis.uniqueColors}`).toBeGreaterThan(3);
      expect(analysis.nonWhiteRatio, `S2 几乎全白：${analysis.nonWhiteRatio}`).toBeGreaterThan(0.005);

      const empty = analysis.bands
        .map((ratio, i) => ({ i, ratio }))
        .filter((b) => b.ratio < EMPTY_BAND);
      expect(empty, `S2 以下横向带是空的：${JSON.stringify(empty)}`).toEqual([]);

      pushReport({
        scenario: 'S2',
        fixture: '02-notion-mock.html',
        pageHeight: result.height,
        outputWidth: result.width,
        outputHeight: result.height,
        byteSize: result.byteSize,
        uniqueColors: analysis.uniqueColors,
        nonWhiteRatio: analysis.nonWhiteRatio,
        bands: analysis.bands.length,
        emptyBands: empty.map((b) => b.i),
        durationMs: Date.now() - started,
        notes: [
          `DPR=2，${analysis.bands.length} 个横向带全有内容`,
          `单段耗时 ≈ ${((Date.now() - started) / analysis.bands.length).toFixed(0)}ms`,
        ],
      });
    } finally {
      await dpr2.close();
    }
  });

  // ── S3 ──────────────────────────────────────────────────────────────────────
  test('S3 跨域 iframe 占位：5 个占位可见，同源 iframe 保留原样', async () => {
    test.setTimeout(180_000);
    const started = Date.now();
    const outcome = await runCapture(harness, {
      targetUrl: harness.server.fixture('03-iframe-mix.html'),
      timeoutMs: 120_000,
      // ⚠️ 两种颜色都要在这里登记：`colorHits` 只统计被点名的颜色，
      // 没点名的读出来永远是 undefined → 断言拿 0 → 假失败。
      colors: ['#2DD4BF', '#DAFBE1'],
    });

    expect(outcome.status, `S3 未完成：${JSON.stringify(outcome)}`).toBe('done');
    if (outcome.status !== 'done') return;
    const { result, analysis } = outcome;

    expect(result.height, 'S3 输出高度应 > 一屏').toBeGreaterThan(800);

    // 占位块的薄荷绿左边条是 #2DD4BF。它出现在最终 PNG 里，才说明
    // 占位 div 真的被画进去了 —— 而不是"代码里有这段逻辑"。
    const mint = analysis.colorHits['#2DD4BF'] ?? 0;
    expect(mint, 'S2/S3 截图里找不到占位块的薄荷绿 #2DD4BF').toBeGreaterThan(50);

    // 同源 iframe 的真实内容（绿色徽章 #dafbe1）应当原样保留。
    const sameOriginGreen = analysis.colorHits['#DAFBE1'] ?? 0;
    expect(
      sameOriginGreen,
      '同源 iframe 的内容没有出现在结果里（#dafbe1 徽章色找不到）',
    ).toBeGreaterThan(0);

    expect(analysis.uniqueColors, `S3 几乎是纯色：${analysis.uniqueColors}`).toBeGreaterThan(3);
    const empty = analysis.bands
      .map((ratio, i) => ({ i, ratio }))
      .filter((b) => b.ratio < EMPTY_BAND);
    expect(empty, `S3 以下横向带是空的：${JSON.stringify(empty)}`).toEqual([]);

    pushReport({
      scenario: 'S3',
      fixture: '03-iframe-mix.html',
      pageHeight: result.height,
      outputWidth: result.width,
      outputHeight: result.height,
      byteSize: result.byteSize,
      uniqueColors: analysis.uniqueColors,
      nonWhiteRatio: analysis.nonWhiteRatio,
      bands: analysis.bands.length,
      emptyBands: empty.map((b) => b.i),
      durationMs: Date.now() - started,
      notes: [`占位块薄荷绿像素 ${mint}`, `同源 iframe 徽章像素 ${sameOriginGreen}`],
    });
  });

  // ── S4 ──────────────────────────────────────────────────────────────────────
  test('S4 懒加载重图页：200 块全部上色，没有空白占位', async () => {
    test.setTimeout(240_000);
    const started = Date.now();
    const outcome = await runCapture(harness, {
      targetUrl: harness.server.fixture('04-pinterest-mock.html'),
      timeoutMs: 180_000,
    });

    expect(outcome.status, `S4 未完成：${JSON.stringify(outcome)}`).toBe('done');
    if (outcome.status !== 'done') return;
    const { result, analysis } = outcome;

    expect(result.height, 'S4 输出高度应 > 一屏').toBeGreaterThan(800);

    // 关键：懒加载图是彩色渐变块。如果图没就位，那一块会是纯白，
    // 逐段断言会把它抓出来。
    expect(analysis.uniqueColors, `S4 几乎是纯色：${analysis.uniqueColors}`).toBeGreaterThan(10);
    const empty = analysis.bands
      .map((ratio, i) => ({ i, ratio }))
      .filter((b) => b.ratio < EMPTY_BAND);
    expect(empty, `S4 以下横向带是空的（懒加载图没就位）：${JSON.stringify(empty)}`).toEqual([]);

    // 页面里 200 块渐变砖，正常情况下每一段都该有明显的彩色。
    const weakBands = analysis.bands
      .map((ratio, i) => ({ i, ratio }))
      .filter((b) => b.ratio < 0.02);
    expect(weakBands, `S4 以下横向带几乎没有内容：${JSON.stringify(weakBands)}`).toEqual([]);

    pushReport({
      scenario: 'S4',
      fixture: '04-pinterest-mock.html',
      pageHeight: result.height,
      outputWidth: result.width,
      outputHeight: result.height,
      byteSize: result.byteSize,
      uniqueColors: analysis.uniqueColors,
      nonWhiteRatio: analysis.nonWhiteRatio,
      bands: analysis.bands.length,
      emptyBands: empty.map((b) => b.i),
      durationMs: Date.now() - started,
      notes: [`${analysis.bands.length} 个横向带全部有内容`],
    });
  });

  // ── S5a ─────────────────────────────────────────────────────────────────────
  test('S5a 极限页 49,500px：接近上限仍能完整拼出', async () => {
    test.setTimeout(600_000);
    const started = Date.now();
    const outcome = await runCapture(harness, {
      targetUrl: harness.server.fixture('05-extreme-49k.html'),
      timeoutMs: 480_000,
    });

    expect(outcome.status, `S5a 未完成：${JSON.stringify(outcome)}`).toBe('done');
    if (outcome.status !== 'done') return;
    const { result, analysis } = outcome;

    expect(result.height, 'S5a 输出高度应覆盖 49,500px').toBeGreaterThan(45_000);
    expect(analysis.uniqueColors, `S5a 几乎是纯色：${analysis.uniqueColors}`).toBeGreaterThan(3);
    expect(analysis.nonWhiteRatio, `S5a 几乎全白：${analysis.nonWhiteRatio}`).toBeGreaterThan(0.005);

    const empty = analysis.bands
      .map((ratio, i) => ({ i, ratio }))
      .filter((b) => b.ratio < EMPTY_BAND);
    expect(empty, `S5a 以下横向带是空的：${JSON.stringify(empty)}`).toEqual([]);

    pushReport({
      scenario: 'S5a',
      fixture: '05-extreme-49k.html',
      pageHeight: result.height,
      outputWidth: result.width,
      outputHeight: result.height,
      byteSize: result.byteSize,
      uniqueColors: analysis.uniqueColors,
      nonWhiteRatio: analysis.nonWhiteRatio,
      bands: analysis.bands.length,
      emptyBands: empty.map((b) => b.i),
      durationMs: Date.now() - started,
      notes: [
        `${analysis.bands.length} 段全部有内容`,
        `sticky 条只应出现一次`,
      ],
    });
  });

  // ── S5b ─────────────────────────────────────────────────────────────────────
  test('S5b 超限拒绝 50,001px：不触发捕获，报清楚的错误', async () => {
    test.setTimeout(120_000);
    const started = Date.now();

    // ⚠️ `harness.logs` 是**整个共享 harness** 的日志累积 —— 上一个用例
    // （S5a，49_500px 的正常捕获）留下的 "stitcher initialized" 也在里面。
    // 必须先记下起点，只看本次用例产生的日志，否则会把上一个用例的
    // 正常日志当成“超限页竟然触发了捕获”。
    const logMark = harness.logs.length;

    const outcome = await runCapture(harness, {
      targetUrl: harness.server.fixture('05-extreme-50k.html'),
      timeoutMs: 60_000,
    });

    // 必须失败 —— 而且是明确地失败。
    expect(outcome.status, 'S5b 竟然成功了？超限页面应该被拒绝').toBe('error');
    if (outcome.status !== 'error') return;
    expect(outcome.error, 'S5b 错误信息为空').toBeTruthy();
    expect(
      outcome.error,
      `S5b 错误信息不准确：${outcome.error}`,
    ).toMatch(/too long/i);

    // 没有 OffscreenCanvas 被初始化，也没有 captureVisibleTab 被调用。
    const swLogs = harness.logs
      .slice(logMark)
      .filter((l) => /offscreen|captureVisibleTab|stitcher/i.test(l));
    expect(
      swLogs.length,
      `超限页面竟然触发了捕获相关日志：${swLogs.slice(0, 5).join(' | ')}`,
    ).toBe(0);

    pushReport({
      scenario: 'S5b',
      fixture: '05-extreme-50k.html',
      pageHeight: 50_001,
      outputWidth: 0,
      outputHeight: 0,
      byteSize: 0,
      uniqueColors: 0,
      nonWhiteRatio: 0,
      bands: 0,
      emptyBands: [],
      durationMs: Date.now() - started,
      notes: [`已拒绝：${outcome.error}`, '未触发任何捕获 / offscreen 初始化'],
    });
  });

  // ── S5c ─────────────────────────────────────────────────────────────────────
  test('S5c dark mode：背景保持深色，没有被白底覆盖', async () => {
    test.setTimeout(180_000);
    const started = Date.now();
    const outcome = await runCapture(harness, {
      targetUrl: harness.server.fixture('05-dark-mode.html'),
      timeoutMs: 120_000,
    });

    expect(outcome.status, `S5c 未完成：${JSON.stringify(outcome)}`).toBe('done');
    if (outcome.status !== 'done') return;
    const { result, analysis } = outcome;

    expect(result.height, 'S5c 输出高度应 > 一屏').toBeGreaterThan(800);
    expect(analysis.uniqueColors, `S5c 几乎是纯色：${analysis.uniqueColors}`).toBeGreaterThan(3);

    // 深色页面：非白像素应该很多，而且整图不该是"几乎全白"。
    expect(
      analysis.nonWhiteRatio,
      `S5c 深色页面却几乎全白：${analysis.nonWhiteRatio}`,
    ).toBeGreaterThan(0.5);

    const empty = analysis.bands
      .map((ratio, i) => ({ i, ratio }))
      .filter((b) => b.ratio < EMPTY_BAND);
    expect(empty, `S5c 以下横向带是空的：${JSON.stringify(empty)}`).toEqual([]);

    pushReport({
      scenario: 'S5c',
      fixture: '05-dark-mode.html',
      pageHeight: result.height,
      outputWidth: result.width,
      outputHeight: result.height,
      byteSize: result.byteSize,
      uniqueColors: analysis.uniqueColors,
      nonWhiteRatio: analysis.nonWhiteRatio,
      bands: analysis.bands.length,
      emptyBands: empty.map((b) => b.i),
      durationMs: Date.now() - started,
      notes: [`非白占比 ${analysis.nonWhiteRatio.toFixed(4)}（深色背景保持住了）`],
    });
  });

  // ── S5d ─────────────────────────────────────────────────────────────────────
  test('S5d web font 延迟：截图里的字是 webfont，不是 fallback', async () => {
    test.setTimeout(180_000);
    const started = Date.now();

    // 字体请求与捕获**同时**发起 —— 谁先谁后由 pipeline 的等待窗口决定。
    const outcome = await runCapture(harness, {
      targetUrl: harness.server.fixture('05-web-font-delay.html'),
      timeoutMs: 120_000,
      beforeCapture: async (targetPage) => {
        await targetPage.evaluate(() => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (window as any).__shotlyLoadFont?.();
        });
      },
      // 页面顶部的两行是同一句话：
      //   A (y 0..80)   要 webfont，缺了才回退到 serif
      //   B (y 80..160) 明确要求 generic serif
      // 如果截图时 webfont 还没生效，两行会一模一样。
      // 签名必须在 popup 还活着的时候取 —— blob URL 一关闭就被 revoke。
      signatures: [
        { label: 'webfont', y0: 0, h: 80 },
        { label: 'fallback', y0: 80, h: 80 },
      ],
    });

    expect(outcome.status, `S5d 未完成：${JSON.stringify(outcome)}`).toBe('done');
    if (outcome.status !== 'done') return;
    const { result, signatures } = outcome;

    const sigA = signatures.webfont;
    const sigB = signatures.fallback;
    expect(sigA, '拿不到第一行的像素签名').toBeTruthy();
    expect(sigB, '拿不到第二行的像素签名').toBeTruthy();
    expect(sigA!.inkRatio, '第一行完全没有墨迹 —— 文字没画出来').toBeGreaterThan(0.01);
    expect(sigB!.inkRatio, '第二行完全没有墨迹 —— 文字没画出来').toBeGreaterThan(0.01);

    const distance = signatureDistance(sigA!.signature, sigB!.signature);
    expect(
      distance,
      `两行渲染完全一致（差异 ${distance.toFixed(4)}）—— webfont 在截图时还没生效，用的是 fallback`,
    ).toBeGreaterThan(0.02);

    pushReport({
      scenario: 'S5d',
      fixture: '05-web-font-delay.html',
      pageHeight: result.height,
      outputWidth: result.width,
      outputHeight: result.height,
      byteSize: result.byteSize,
      uniqueColors: 0,
      nonWhiteRatio: 0,
      bands: 0,
      emptyBands: [],
      durationMs: Date.now() - started,
      notes: [
        `webfont 行 vs fallback 行 像素差异 ${(distance * 100).toFixed(2)}%`,
        `A 墨迹率 ${sigA!.inkRatio.toFixed(4)} · B 墨迹率 ${sigB!.inkRatio.toFixed(4)}`,
      ],
    });
  });
});

function pushReport(r: ScenarioReport): void {
  reports.push(r);
  // eslint-disable-next-line no-console
  console.log(`[poc-d3] ${r.scenario} → ${JSON.stringify(r)}`);
}
