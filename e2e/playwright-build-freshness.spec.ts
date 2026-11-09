/**
 * 构建产物新鲜度守门
 *
 * ## 为什么需要
 *
 * E2E 加载的是 **`.output/chrome-mv3`（预构建产物）**，不是源码。
 * 所以改了源码没重新 build，E2E 测的是**旧代码** ——
 * 而且它会正常跑、正常出结果，只是结果跟你的改动无关。
 *
 * 实际踩中过（2026-11-05）：改了「页面太长」的文案后跑真实站点冒烟，
 * 断言「提示里应该建议改用区域截图」失败，收到的还是旧文案。
 * 一度以为是产品没改对 —— 实际是**测的根本不是改过的代码**。
 *
 * 这比「构建失败」危险得多：
 *   - 构建失败 → 停下来，你立刻知道
 *   - 测的是旧代码 → **可能照样绿**，或者红在一个跟你改动无关的地方
 *
 * 所以这个守门必须**两个方向都验**：
 *   1. 产物旧了 → 必须硬失败（不能静默放行）
 *   2. 产物是新的 → 必须放行（不能误报）
 *
 * 只验第 1 条 = 狼来了；只验第 2 条 = 守门不存在。
 */

import { test, expect } from '@playwright/test';
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { assertBuildIsFresh, SHOTLY_BUILT } from './helpers/shotly-harness';

/**
 * 搭一个「产物目录 + 源码目录」的最小现场。
 *
 * 用临时目录而不是改真源码的 mtime ——
 * 改真源码会污染工作区，还会让并行跑的其他用例看到不一致的状态。
 */
function makeFixture(opts: { sourceNewer?: boolean } = {}): {
  builtDir: string;
  sourceDir: string;
  cleanup: () => void;
} {
  const root = join(tmpdir(), `shotly-freshness-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const builtDir = join(root, 'built');
  const sourceDir = join(root, 'src');
  mkdirSync(builtDir, { recursive: true });
  mkdirSync(sourceDir, { recursive: true });

  // 产物：一个 js 文件
  const builtFile = join(builtDir, 'popup.js');
  writeFileSync(builtFile, '// built\n');
  // 源码：一个 ts 文件
  const srcFile = join(sourceDir, 'i18n.ts');
  writeFileSync(srcFile, '// source\n');

  const builtTime = new Date(Date.now() - 10 * 60_000); // 10 分钟前
  const srcTime = opts.sourceNewer ? new Date(Date.now()) : builtTime;
  utimesSync(builtFile, builtTime, builtTime);
  utimesSync(srcFile, srcTime, srcTime);

  return {
    builtDir,
    sourceDir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test.describe('构建产物新鲜度', () => {
  test('产物比源码旧时必须硬失败，而不是静默用旧代码', () => {
    const fx = makeFixture({ sourceNewer: true });
    try {
      expect(
        () => assertBuildIsFresh(fx.builtDir, [fx.sourceDir]),
        '源码比 build 新时必须抛错 —— 否则 E2E 测的是旧代码，而且可能照样绿',
      ).toThrow(/比源码旧/);
    } finally {
      fx.cleanup();
    }
  });

  test('产物是新的时必须放行（不能误报，否则狼来了）', () => {
    const fx = makeFixture();
    try {
      expect(
        () => assertBuildIsFresh(fx.builtDir, [fx.sourceDir]),
        '源码不比 build 新却报 stale —— 这个守门就没人会信了',
      ).not.toThrow();
    } finally {
      fx.cleanup();
    }
  });

  test('产物目录不存在时必须硬失败，而不是跳过', () => {
    expect(
      () => assertBuildIsFresh(resolve(process.cwd(), '.output', 'definitely-not-here')),
      '产物不存在时必须抛错 —— 静默跳过 = 什么都没测',
    ).toThrow(/未 build/);
  });

  test('测试文件不比 build 新不算 stale（改个 *.test.ts 不该报 stale）', () => {
    // ⚠️ 这里**不能**用 sourceNewer 现场 —— 那个现场的源码本来就比 build 新，
    //    抛错才是对的。要测的是「只有测试文件比 build 新」这种情况。
    const fx = makeFixture();
    try {
      // 追加一个「刚创建」的测试文件 —— 它比 build 新，但不影响产物。
      const testFile = join(fx.sourceDir, 'foo.test.ts');
      writeFileSync(testFile, '// test\n');
      const now = new Date();
      utimesSync(testFile, now, now);

      expect(
        () => assertBuildIsFresh(fx.builtDir, [fx.sourceDir]),
        '改一个 *.test.ts 不该让 build 看起来是旧的',
      ).not.toThrow();
    } finally {
      fx.cleanup();
    }
  });

  test('真实产物现在是新鲜的（本次 CI 的 build 刚做完）', () => {
    if (!existsSync(SHOTLY_BUILT)) {
      // 没 build → 硬失败。这正是本文件要防的事。
      expect(() => assertBuildIsFresh(SHOTLY_BUILT)).toThrow(/未 build/);
      return;
    }
    expect(
      () => assertBuildIsFresh(SHOTLY_BUILT),
      '刚 build 完却报 stale —— 说明 mtime 比对逻辑有误',
    ).not.toThrow();
  });
});
