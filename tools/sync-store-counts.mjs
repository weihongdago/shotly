/**
 * 同步提审文档里的测试数量 —— 数字不该是手抄的。
 *
 * ## 为什么需要这个脚本
 *
 * 提审手册和 listing 里写着「208 单测」「29 条 E2E」「一致性守卫 5 用例」
 * 这些数字。它们是**证据**：审核被质疑「功能不足 / 只是个空壳」时，
 * 要贴得出测试规模。
 *
 * 但手抄的数字会漂 —— 每加一个测试文件就得手动改两处文档，
 * 忘了改就是「文档说有 196，CI 跑出 222」。D+4 深夜就抓到了三处漂移：
 *   - 单测数 196 → 实际 208
 *   - E2E 数 25 → 实际 29
 *   - 一致性守卫 5 用例 → 实际 15
 *
 * 而且漂移的**方向**很糟：文档数字总是**偏小**（人记得上次加测试前的数），
 * 于是文档在**低报**自己的测试规模 —— 正好在需要它的时候。
 *
 * ## 怎么用
 *
 * ```bash
 * node tools/sync-store-counts.mjs           # 改写数字
 * node tools/sync-store-counts.mjs --check   # 只检查（CI 用；漂了就退出 1）
 * ```
 *
 * ## 数字从哪来
 *
 * - 单测数 / 一致性守卫用例数：`vitest list`（只列举，不执行，快）
 * - E2E 数：`playwright test --list`（在 test-infra 里；不在就跳过并**明确说出来**）
 * - 详细说明字符数：直接数字符
 *
 * ⚠️ 不用 `grep -c "test("` 数源码 —— 那种数法会把 `test.each`、
 * 条件分支里的 test 一起算上，和 runner 的实际结果对不上。
 * 唯一准的来源是 runner 自己。
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const checkOnly = process.argv.includes('--check');

/** @type {{file: string, label: string, derive: () => number | null}[]} */
const targets = [];

/**
 * 一处待改的数字。
 *
 * `anchor` 是紧挨在数字**前面**的字面文本（不含尾随空格）；
 * `value` 是要写进那个位置的字符串（可以是「222/222」这种复合形式）。
 *
 * 数字本身允许是「196/196」这种带斜杠的复合形式，也允许前面有空格。
 *
 * @typedef {{anchor: string, value: string, what: string}} Edit
 */

// ─── 单测数 ───────────────────────────────────────────────────────────────────

/**
 * `vitest list` 每行一个用例：`path/to/file.test.ts > describe > name`
 * 空的 describe 会少一层 `>`，所以按「行里有 ' > '」计数。
 */
/**
 * @returns {string[]}
 */
function vitestList() {
  const out = execFileSync('pnpm', ['exec', 'vitest', 'list'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return out.split('\n').filter((l) => l.includes(' > '));
}

/** @returns {number | null} */
function unitTestCount() {
  try {
    return vitestList().length;
  } catch {
    return null;
  }
}

/** @returns {number | null} */
function consistencyGuardCount() {
  try {
    return vitestList().filter((l) => l.includes('store-listing-consistency')).length;
  } catch {
    return null;
  }
}

// ─── E2E 数 ───────────────────────────────────────────────────────────────────
//
// E2E 在**另一个目录**（test-infra/），不在本仓库里 —— 本仓库的 CI
// 跑不了 Playwright（没装浏览器，也没这个目录）。
// 所以这里能数的就数，数不到就**明说**，不假装数到了。

/** @returns {number | null} */
function e2eCount() {
  const infra = resolve(root, '..', 'test-infra');
  if (!existsSync(infra)) return null;
  try {
    const out = execFileSync('pnpm', ['exec', 'playwright', 'test', 'e2e/', '--list'], {
      cwd: infra,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const m = out.match(/Total:\s*(\d+)\s+tests?/);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

// ─── 详细说明字符数 ───────────────────────────────────────────────────────────

/** @returns {number | null} */
function detailedDescriptionChars() {
  const listing = readFileSync(resolve(root, 'store-assets', 'CWS-listing.md'), 'utf8');
  const sec = listing.split('## 3.')[1]?.split('## 4.')[0];
  const body = sec?.match(/```\n([\s\S]*?)\n```/)?.[1];
  return body ? body.length : null;
}

// ─── 改写 ─────────────────────────────────────────────────────────────────────

/**
 * 每个替换都锚在**唯一**的上下文上。
 *
 * ⚠️ 锚点太宽会误伤（同一份文档里数字出现多次），锚点太窄会匹配不到。
 * 每条都带足上下文，并且**改完立刻断言替换成功** —— 匹配不到就报错，
 * 不静默跳过（静默跳过 = 文档继续漂着，你以为同步过了）。
 */
/**
 * @param {string} file
 * @param {Edit[]} edits
 * @returns {boolean}
 */
function applyReplacements(file, edits) {
  const path = resolve(root, file);
  const before = readFileSync(path, 'utf8');
  let after = before;

  for (const e of edits) {
    const at = after.indexOf(e.anchor);
    if (at === -1) {
      console.error(`  ✗ 没找到锚点：${file} —— ${e.what}`);
      console.error(`    锚点：${JSON.stringify(e.anchor)}`);
      return false;
    }
    const numStart = at + e.anchor.length;
    const rest = after.slice(numStart);
    // 数字前允许有空格、# 注释符等非数字字符；但不能跨行
    const m = rest.match(/^[^\S\n]*[#：:]*[^\S\n]*(\d+(?:\/\d+)?)/);
    if (!m) {
      console.error(`  ✗ 锚点后面找不到数字：${file} —— ${e.what}`);
      console.error(`    锚点：${JSON.stringify(e.anchor)}`);
      console.error(`    后面是：${JSON.stringify(rest.slice(0, 30))}`);
      return false;
    }
    // m[0] 里包含数字**前面**的空白/注释符，m[1] 才是数字本身。
    // 只替换数字，保留前面的空白 —— 否则会写成「pnpm test222 单测」。
    const numEnd = numStart + m[0].length;
    const lead = m[0].slice(0, m[0].length - m[1].length);
    after = after.slice(0, numStart) + lead + e.value + after.slice(numEnd);
  }

  if (after === before) return true;

  if (checkOnly) {
    console.error(`  ✗ ${file} 的数字过期了`);
    return false;
  }

  writeFileSync(path, after, 'utf8');
  console.log(`  ✓ ${file} 已更新`);
  return true;
}

// ─── 主流程 ───────────────────────────────────────────────────────────────────

const unit = unitTestCount();
const guard = consistencyGuardCount();
const e2e = e2eCount();
const chars = detailedDescriptionChars();

console.log('实测数字：');
console.log(`  单测用例数        ${unit ?? '（数不到）'}`);
console.log(`  一致性守门用例数  ${guard ?? '（数不到）'}`);
console.log(`  E2E 用例数        ${e2e ?? '（数不到 —— test-infra/ 不在本仓库，CI 也跑不了）'}`);
console.log(`  详细说明字符数    ${chars ?? '（数不到）'}`);

if (unit == null) {
  console.error('\n✗ 连单测数都数不到（vitest list 失败）—— 检查方式失效了，拒绝同步。');
  process.exit(1);
}

/** @type {Edit[]} */
const edits = [];

// 提审手册
/** @type {Edit[]} */
const runbookEdits = [];
runbookEdits.push({
  anchor: 'pnpm zip && pnpm test',
  value: String(unit),
  what: '手册里的单测数',
});
if (e2e != null) {
  runbookEdits.push({
    anchor: 'playwright test e2e/',
    value: String(e2e),
    what: '手册里的 E2E 数',
  });
  runbookEdits.push({
    anchor: '个功能全部可用，有 ',
    value: String(e2e),
    what: '手册里的 E2E 数（拒因应对表）',
  });
}
if (chars != null) {
  runbookEdits.push({
    anchor: '**第 3 节**代码块内容（英文） | ',
    value: String(chars),
    what: '手册里的详细说明字符数',
  });
}

// listing
/** @type {Edit[]} */
const listingEdits = [];
listingEdits.push({
  anchor: '`pnpm test` 全绿（',
  value: `${unit}/${unit}`,
  what: 'listing 检查清单里的单测数',
});
if (guard != null) {
  listingEdits.push({
    anchor: '一致性守卫（vitest 版在 CI 每次 push 都跑，',
    value: String(guard),
    what: 'listing 检查清单里的一致性守卫用例数',
  });
}

console.log(checkOnly ? '\n检查中…' : '\n同步中…');

let ok = true;
ok = applyReplacements('store-assets/SUBMIT-RUNBOOK.md', runbookEdits) && ok;
ok = applyReplacements('store-assets/CWS-listing.md', listingEdits) && ok;

if (!ok) {
  console.error(
    checkOnly
      ? '\n✗ 提审文档里的数字过期了。跑 `node tools/sync-store-counts.mjs` 更新。'
      : '\n✗ 有替换没匹配上 —— 文档结构可能变了，需要手动看一下。',
  );
  process.exit(1);
}

console.log(checkOnly ? '\n✓ 提审文档里的数字都是准的' : '\n✓ 数字已同步');
