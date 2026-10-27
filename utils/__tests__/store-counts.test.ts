/**
 * 提审文档里的**测试数量**不许漂。
 *
 * 背景：这些数字（单测数、E2E 数、一致性守门用例数）是审核被质疑
 * 「功能不足 / 只是个空壳」时要贴出来的证据。D+4 深夜抓到三处漂移：
 *   - 单测数 196 → 实际 208 → 又漂到 222
 *   - E2E 数 25 → 实际 29
 *   - 一致性守门 5 用例 → 实际 15
 *
 * 漂移的方向很糟：文档数字总是**偏小**（人记得上次加测试前的数），
 * 于是文档在**低报**自己的测试规模 —— 正好在需要它的时候。
 *
 * 这里不重写 `tools/sync-store-counts.mjs` 的逻辑（那是权威实现），
 * 而是验两件更重要的事：
 *   1. 文档里的数字 = runner 实际数出来的（用 vitest 自己的 API）
 *   2. 同步脚本的锚点还能找到（文档结构变了 → 脚本报错而不是静默跳过）
 *
 * ⚠️ 为什么不用 `grep -c "test("` 数源码：那种数法会把 `test.each`、
 *    条件分支里的 test 都算上，和 runner 的实际结果对不上。
 *    唯一准的来源是 runner 自己。
 */

import { test, expect, describe } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(__dirname, '..', '..');
const LISTING = resolve(ROOT, 'store-assets', 'CWS-listing.md');
const RUNBOOK = resolve(ROOT, 'store-assets', 'SUBMIT-RUNBOOK.md');
const SYNC_TOOL = resolve(ROOT, 'tools', 'sync-store-counts.mjs');

/**
 * 列出所有 vitest 用例。
 *
 * ⚠️ **不排除本文件**。
 *
 * 一开始这里排除了自己（怕「自己算自己」循环），结果和
 * `tools/sync-store-counts.mjs` 数的不是同一个集合：
 * 脚本数 227（含本文件的 5 条），这里数 222（排除了）——
 * 两边永远对不上，check 会在「同步 → 失败 → 同步」之间来回。
 *
 * 正确做法是**两边数同一个集合**：都包含本文件。
 * 这不构成循环依赖 —— 每次跑都是重新数一遍，数字总是当下的真值；
 * 加测试 → 数字变 → 守门报「过期」→ 跑同步脚本 → 一致。
 */
function vitestList(): string[] {
  const out = execFileSync('pnpm', ['exec', 'vitest', 'list'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 120_000,
  });
  return out.split('\n').filter((l) => l.includes(' > '));
}

describe('提审文档里的测试数量', () => {
  test('同步脚本存在且可执行', () => {
    expect(existsSync(SYNC_TOOL), `找不到 ${SYNC_TOOL}`).toBe(true);
  });

  test('文档里的单测数 = vitest 实际数出来的', () => {
    const listed = vitestList();
    const actual = listed.length;
    expect(actual, 'vitest list 一条都没数到 —— 检查方式失效了').toBeGreaterThan(100);

    const listing = readFileSync(LISTING, 'utf8');
    const m = listing.match(/`pnpm test` 全绿（(\d+)\/(\d+)）/);
    expect(m, 'listing 检查清单里没找到「pnpm test 全绿（N/N）」').toBeTruthy();
    expect(Number(m![1]), 'listing 里的单测数过期了（跑 node tools/sync-store-counts.mjs）').toBe(
      actual,
    );
    expect(Number(m![2]), 'listing 里的单测数分母过期了').toBe(actual);

    const runbook = readFileSync(RUNBOOK, 'utf8');
    const rm = runbook.match(/pnpm test\s+#\s*(\d+)\s*单测/);
    expect(rm, '提审手册里没找到「# N 单测」').toBeTruthy();
    expect(Number(rm![1]), '提审手册里的单测数过期了（跑 node tools/sync-store-counts.mjs）').toBe(
      actual,
    );
  });

  test('文档里的一致性守门用例数 = 实际数出来的', () => {
    const guard = vitestList().filter((l) => l.includes('store-listing-consistency')).length;
    expect(guard, '没数到一致性守门的用例 —— 检查方式失效了').toBeGreaterThan(0);

    const listing = readFileSync(LISTING, 'utf8');
    const m = listing.match(/一致性守卫（vitest 版在 CI 每次 push 都跑，(\d+) 用例/);
    expect(m, 'listing 检查清单里没找到一致性守卫的用例数').toBeTruthy();
    expect(Number(m![1]), '一致性守门用例数过期了（跑 node tools/sync-store-counts.mjs）').toBe(
      guard,
    );
  });

  /**
   * 同步脚本的锚点必须还能找到。
   *
   * 如果有人改了文档结构（比如把手册里的命令换了写法），
   * 脚本应该**报错**，而不是静默跳过 —— 静默跳过 = 数字从此不再被同步，
   * 而且没人知道。
   */
  test('同步脚本的锚点在文档里都还能找到', () => {
    const listing = readFileSync(LISTING, 'utf8');
    const runbook = readFileSync(RUNBOOK, 'utf8');

    const anchors: Array<{ text: string; where: string; doc: string }> = [
      { text: '`pnpm test` 全绿（', where: 'listing', doc: listing },
      { text: '一致性守卫（vitest 版在 CI 每次 push 都跑，', where: 'listing', doc: listing },
      { text: 'pnpm zip && pnpm test', where: 'runbook', doc: runbook },
      { text: '**第 3 节**代码块内容（英文） | ', where: 'runbook', doc: runbook },
    ];

    for (const a of anchors) {
      expect(
        a.doc.includes(a.text),
        `同步脚本的锚点在 ${a.where} 里找不到了：「${a.text}」—— 文档结构变了，脚本需要更新`,
      ).toBe(true);
    }
  });

  /**
   * 锚点后面必须**紧跟**数字。
   *
   * 这条比「锚点还在」更严：锚点还在但后面不是数字（比如后面跟的是
   * 一段说明文字），脚本会找不到要改的数字。
   */
  test('同步脚本的锚点后面都紧跟着数字', () => {
    const listing = readFileSync(LISTING, 'utf8');
    const runbook = readFileSync(RUNBOOK, 'utf8');

    const probes: Array<{ anchor: string; doc: string; label: string }> = [
      { anchor: '`pnpm test` 全绿（', doc: listing, label: 'listing 单测数' },
      { anchor: '一致性守卫（vitest 版在 CI 每次 push 都跑，', doc: listing, label: 'listing 守门数' },
      { anchor: 'pnpm zip && pnpm test', doc: runbook, label: 'runbook 单测数' },
      { anchor: '**第 3 节**代码块内容（英文） | ', doc: runbook, label: 'runbook 字符数' },
    ];

    for (const p of probes) {
      const at = p.doc.indexOf(p.anchor);
      expect(at, `${p.label}：锚点找不到了`).toBeGreaterThanOrEqual(0);
      const rest = p.doc.slice(at + p.anchor.length);
      expect(
        /^[^\S\n]*[#：:]*[^\S\n]*\d/.test(rest),
        `${p.label}：锚点后面不是数字 —— 同步脚本会报错，文档结构可能变了`,
      ).toBe(true);
    }
  });
});
