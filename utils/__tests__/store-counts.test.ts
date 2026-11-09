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
const TEST_PLAN = resolve(ROOT, 'docs', 'test-plan-v1.md');
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
   * `docs/test-plan-v1.md` 里 2.3 节的 E2E 数量也必须是真的。
   *
   * ## 为什么
   *
   * 2026-11-08 那一节刚加进来时，手写了「用例数 29」「35 条 E2E」——
   * **当天就已经漂了**（真实值是 34 + 6 = 40）。
   *
   * 漂的数字有两种害法：
   *   - 偏小 → 低报自己的测试规模
   *   - 偏大 → 读者照着文档跑，跑出来的条数对不上，文档就不可信了
   *
   * 这个文档现在是**活文档**（不只是历史设计稿），所以数字要自动同步。
   * 同步脚本已经接管了它（`tools/sync-store-counts.mjs`），
   * 这里再验一遍，让漂移在 `pnpm test` 里就暴露，而不用等 CI。
   */
  test('测试计划文档里的 E2E 数量 = 实际数出来的', () => {
    const plan = readFileSync(TEST_PLAN, 'utf8');

    // 主门禁（--project=chromium）与真实站点（--project=real-sites）是两批。
    const count = (project: string): number => {
      const out = execFileSync(
        'pnpm',
        ['exec', 'playwright', 'test', `--project=${project}`, '--list'],
        {
          cwd: ROOT,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 180_000,
        },
      );
      const m = out.match(/Total:\s*(\d+)\s+tests?/);
      if (!m) throw new Error(`数不到 ${project} 的用例数 —— playwright --list 没输出 Total`);
      return Number(m[1]);
    };

    const blocking = count('chromium');
    const realSites = count('real-sites');
    expect(blocking, '主门禁用例数是 0 —— 检查方式失效了').toBeGreaterThan(10);
    expect(realSites, '真实站点用例数是 0 —— 检查方式失效了').toBeGreaterThan(0);

    const m = plan.match(/\| 用例数 \| (\d+) \| (\d+) \|/);
    expect(m, '测试计划文档里没找到「| 用例数 | N | M |」这一行').toBeTruthy();
    expect(Number(m![1]), '测试计划里的主 E2E 用例数过期了（跑 node tools/sync-store-counts.mjs）').toBe(
      blocking,
    );
    expect(Number(m![2]), '测试计划里的真实站点用例数过期了（跑 node tools/sync-store-counts.mjs）').toBe(
      realSites,
    );

    // 总数也必须对得上（提审文档里对外声称的那个数）
    const total = plan.match(/提审文档里写的是「(\d+) 条 E2E」= (\d+) \+ (\d+)/);
    expect(total, '测试计划文档里没找到 E2E 总数的表述').toBeTruthy();
    expect(Number(total![1]), 'E2E 总数过期了').toBe(blocking + realSites);
    expect(Number(total![2]), 'E2E 总数的拆分过期了').toBe(blocking);
    expect(Number(total![3]), 'E2E 总数的拆分过期了').toBe(realSites);
  });

  /**
   * 文档里「命令旁边的数字」必须是**那条命令**数出来的。
   *
   * ## 为什么这条守门必须存在
   *
   * 2026-11-09 踩过这个坑：提审手册的自检命令写的是
   * `pnpm exec playwright test e2e/`（不带 project 过滤），
   * 而旁边标的数字是 40 —— 但**合并门禁**只跑 `--project=chromium`（34 条）。
   *
   * 麻烦在于：**数字是对的**（自动同步脚本数出来的），
   * 错的是**命令** —— 它多跑了 6 条打真网站的用例。
   * 于是「提交前最后一道关卡」会因为限流 / 改版 / 网络抖动而红，
   * 而那跟 Shotly 能不能提交**毫无关系**。
   *
   * 门禁一旦变成噪音，就再也没人认真看它 ——
   * 那这条命令就从「守门」退化成「许愿池」。
   *
   * ## 自动同步为什么拦不住
   *
   * 同步脚本保证的是「文档里的数字 == 脚本数出来的数」。
   * 但没人保证「脚本数的那个东西 == 文档旁边那条命令跑的东西」。
   * 命令换成不带 project 过滤的那条，数字仍然自动同步，
   * 守门仍然全绿 —— **文档照样是错的**。
   *
   * 所以这条守门直接去核对「命令 ↔ 数字」的对应关系。
   */
  test('手册里命令旁边的数字 = 那条命令实际跑出来的条数', () => {
    const runbook = readFileSync(RUNBOOK, 'utf8');

    /** 数某个 project 下的用例数（真跑 runner 的 --list，不数源码）。 */
    const count = (project: string): number => {
      const out = execFileSync(
        'pnpm',
        ['exec', 'playwright', 'test', `--project=${project}`, '--list'],
        {
          cwd: ROOT,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 180_000,
        },
      );
      const m = out.match(/Total:\s*(\d+)\s+tests?/);
      if (!m) throw new Error(`数不到 ${project} 的用例数 —— playwright --list 没输出 Total`);
      return Number(m[1]);
    };

    /**
     * 每条 E2E 命令对应哪个 playwright project（或者「全都要」）。
     *
     * ⚠️ 映射写在**这里**而不是读 package.json —— 因为要验的是
     *    「文档里这条命令到底跑到哪些用例」，而 package.json 里的
     *    script 字符串本身也可能被改（改成不带 --project 的形式）。
     *    两种写法都要挡住，所以这里写死「命令 → project」的期望。
     *
     * ⚠️ `null` 表示「不带 project 过滤 = 全跑」——
     *    这种命令**不能**当自检命令用（会把打真网站的那批也带上），
     *    但它也不是不存在，所以要能算出一个数来跟文档比对。
     */
    const COMMAND_PROJECT: Record<string, string | null> = {
      'pnpm test:e2e': 'chromium',
      'pnpm test:e2e:real': 'real-sites',
      'pnpm exec playwright test e2e/': null,
      'pnpm exec playwright test --project=chromium': 'chromium',
    };

    // 只扫 **bash 代码块**里的行 —— 正文里的叙述性提及不算命令。
    const bashBlocks = [...runbook.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
    expect(
      bashBlocks.length,
      '手册里一个 bash 代码块都没找到 —— 文档结构变了，守门失效了',
    ).toBeGreaterThan(0);

    const lines = bashBlocks
      .flatMap((b) => b.split('\n'))
      .filter((l) => /playwright\s+test|pnpm\s+test:e2e/.test(l));

    expect(
      lines.length,
      '手册的 bash 代码块里一条 E2E 命令都没找到 —— 文档结构变了，守门失效了',
    ).toBeGreaterThan(0);

    for (const line of lines) {
      // ⚠️ 命令要取**完整的一段**（`pnpm test:e2e`），
      //    不能只取第一个空格分隔的词（那就只剩 `pnpm` 了）。
      const cmd = line.trim().match(
        /^(pnpm\s+test:e2e(?::real)?|pnpm\s+exec\s+playwright\s+test\s+(?:--project=\w+\s*)?e2e\/)/,
      )?.[1];

      expect(
        cmd,
        `手册的 bash 块里这条 E2E 命令解析不出来：「${line.trim()}」—— 守门的命令识别逻辑要跟着文档改`,
      ).toBeDefined();

      const project = COMMAND_PROJECT[cmd!];
      expect(
        project !== undefined,
        `手册里出现了未登记的 E2E 命令「${cmd}」—— 请先把它登记进这条守门，否则它的数字没人验`,
      ).toBe(true);

      const actual =
        project === null ? count('chromium') + count('real-sites') : count(project);

      const annotated = line.match(/#\s*(\d+)/);
      if (!annotated) continue; // 没标数字的命令不参与数字核对

      const n = Number(annotated[1]);
      expect(
        n,
        `手册里「${cmd}」旁边写的是 ${n} 条，但那条命令实际跑 ${actual} 条 —— 数字和命令口径不一致`,
      ).toBe(actual);
    }
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
    const plan = readFileSync(TEST_PLAN, 'utf8');

    const anchors: Array<{ text: string; where: string; doc: string }> = [
      { text: '`pnpm test` 全绿（', where: 'listing', doc: listing },
      { text: '一致性守卫（vitest 版在 CI 每次 push 都跑，', where: 'listing', doc: listing },
      { text: 'pnpm zip && pnpm test', where: 'runbook', doc: runbook },
      { text: '**第 3 节**代码块内容（英文） | ', where: 'runbook', doc: runbook },
      { text: '| 用例数 | ', where: 'test-plan', doc: plan },
      { text: '判定 | `expected=', where: 'test-plan', doc: plan },
      { text: '提审文档里写的是「', where: 'test-plan', doc: plan },
      { text: '条 E2E」= ', where: 'test-plan', doc: plan },
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
