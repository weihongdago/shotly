/**
 * 功能参数的数字 ↔ 代码常量 一致性（CI 守门）
 *
 * ## 为什么单独一个文件
 *
 * `store-listing-consistency.test.ts` 查的是**功能有没有实现**。
 * 这个文件查的是**数字对不对** —— 一个更隐蔽的漂移方向。
 *
 * ## 漂移长什么样
 *
 * listing 写着「Minimum 100×100」「last 50 shots」「50 000 px」，
 * 代码里是 `MIN_REGION_SIZE = 100` / `HISTORY_MAX_ENTRIES = 50` /
 * `HARD_PAGE_LIMIT_PX = 50_000`。
 *
 * 改代码不改文档 → 用户拖一个 80×80 的框被拒，但页面写着最小 100×100
 * （数字还比实际宽松，问题不大）；改文档不改代码 → 更糟：
 * listing 说最小 50×50，用户拖 60×60 被拒，直接是 bug 级的口径不一致。
 *
 * 三份文档都写了这几个数字（listing 英文、中文、站点），任何一处漏改
 * 都是漂移。人眼看不住 —— 所以这里查。
 *
 * ## 查法
 *
 * **不写字面量**。字面量会跟着常量一起漂（把 50 改成 60，测试里那个
 * 写死的 50 也得改，那就等于没有守门）。所以：从源码里**解析**出常量的
 * 值，再去文档里找同样的数字。
 *
 * 这条和 `tools/sync-store-counts.mjs` 是同一个思路 ——
 * 数字的唯一权威来源是代码，文档只是它的投影。
 */

import { test, expect, describe } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { maxAllowedCssHeight } from '../screenshot-engine';

const ROOT = resolve(__dirname, '..', '..'); // shotly/
const LISTING = readFileSync(resolve(ROOT, 'store-assets', 'CWS-listing.md'), 'utf8');
const SITE_TEMPLATE = readFileSync(resolve(ROOT, 'tools', 'build-pages.mjs'), 'utf8');
const README = readFileSync(resolve(ROOT, 'README.md'), 'utf8');

/**
 * 从源码里解析一个数值常量。
 *
 * `50_000` 和 `50000` 都认 —— TS 允许数字分隔符，写法会变。
 *
 * @param file 相对 shotly/ 的路径
 * @param name 常量名
 * @returns 解析到的值；找不到就抛错（守门失效比数字错更糟）
 */
function readNumericConst(file: string, name: string): number {
  const src = readFileSync(resolve(ROOT, file), 'utf8');
  const m = src.match(new RegExp(`export\\s+const\\s+${name}\\s*=\\s*([\\d_]+)`));
  expect(
    m,
    `源码里找不到常量 ${name}（${file}）—— 常量改名了？守门要跟着更新`,
  ).toBeTruthy();
  return Number(m![1].replace(/_/g, ''));
}

/** 提交的 listing 正文（代码块里的才是真正交上去的文案）。 */
function submittedCopy(): string {
  return [...LISTING.matchAll(/```\n([\s\S]*?)\n```/g)].map((m) => m[1]).join('\n');
}

describe('功能参数的数字 ↔ 代码常量', () => {
  test('listing 说的最小区域尺寸 = 代码里的 MIN_REGION_SIZE', () => {
    const min = readNumericConst('utils/region-selector.ts', 'MIN_REGION_SIZE');

    // 英文详细说明：「Minimum 100×100」
    const en = submittedCopy().match(/Minimum\s+(\d+)\s*×\s*(\d+)/);
    expect(
      en,
      'listing 详细说明里找不到「Minimum N×N」的最小尺寸声称 —— 文案结构变了？',
    ).toBeTruthy();
    expect(
      Number(en![1]),
      `listing 说最小 ${en![1]}×${en![2]}，但代码里 MIN_REGION_SIZE = ${min}`,
    ).toBe(min);
    expect(
      Number(en![2]),
      `listing 说最小 ${en![1]}×${en![2]}（宽高不一致），代码里是 ${min}×${min}`,
    ).toBe(min);

    // 中文详细说明：「最小 100×100」
    const zh = LISTING.match(/最小\s+(\d+)\s*×\s*(\d+)/);
    expect(zh, 'listing 中文版里找不到「最小 N×N」').toBeTruthy();
    expect(
      Number(zh![1]),
      `listing 中文版说最小 ${zh![1]}×${zh![2]}，但代码里是 ${min}`,
    ).toBe(min);
    expect(Number(zh![2]), `listing 中文版说最小 ${zh![1]}×${zh![2]}，代码里是 ${min}×${min}`).toBe(
      min,
    );
  });

  test('listing 说的历史库容量 = 代码里的 HISTORY_MAX_ENTRIES', () => {
    const max = readNumericConst('utils/history-store.ts', 'HISTORY_MAX_ENTRIES');

    // 英文：「(last 50 shots, stored only on your device)」
    const en = submittedCopy().match(/last\s+(\d+)\s+shots/);
    expect(en, 'listing 详细说明里找不到「last N shots」').toBeTruthy();
    expect(
      Number(en![1]),
      `listing 说历史库存 ${en![1]} 张，代码里 HISTORY_MAX_ENTRIES = ${max}`,
    ).toBe(max);

    // 中文：「（最近 50 张，只存在你自己的设备上）」
    const zh = LISTING.match(/最近\s+(\d+)\s+张/);
    expect(zh, 'listing 中文版里找不到「最近 N 张」').toBeTruthy();
    expect(
      Number(zh![1]),
      `listing 中文版说历史库存 ${zh![1]} 张，代码里是 ${max}`,
    ).toBe(max);
  });

  test('站点说的历史库容量 = 代码里的 HISTORY_MAX_ENTRIES', () => {
    const max = readNumericConst('utils/history-store.ts', 'HISTORY_MAX_ENTRIES');

    // 站点首页（英文）：「Local history (50 entries, LRU)」
    const en = SITE_TEMPLATE.match(/Local history \((\d+)\s+entries/);
    expect(en, '站点模板里找不到「Local history (N entries」').toBeTruthy();
    expect(
      Number(en![1]),
      `站点说历史库 ${en![1]} 条，代码里 HISTORY_MAX_ENTRIES = ${max}`,
    ).toBe(max);

    // 站点首页（中文）：「历史库最多存 50 条」
    const zh = SITE_TEMPLATE.match(/历史库最多存\s+(\d+)\s+条/);
    expect(zh, '站点模板（中文）里找不到「历史库最多存 N 条」').toBeTruthy();
    expect(
      Number(zh![1]),
      `站点中文版说历史库 ${zh![1]} 条，代码里是 ${max}`,
    ).toBe(max);
  });

  test('站点/listing 说的页面高度上限 = 代码里的 HARD_PAGE_LIMIT_PX', () => {
    const limit = readNumericConst('utils/screenshot-engine.ts', 'HARD_PAGE_LIMIT_PX');

    // 站点（中文）：「Shotly 的上限是 min(50 000, ...)"
    const zh = SITE_TEMPLATE.match(/上限是\s*<code>min\((\d[\d\s ]*),/);
    expect(zh, '站点模板里找不到页面高度上限的声称').toBeTruthy();
    expect(
      Number(zh![1].replace(/[\s ]/g, '')),
      `站点说上限 ${zh![1]} px，代码里 HARD_PAGE_LIMIT_PX = ${limit}`,
    ).toBe(limit);

    // 站点（英文）：「50&nbsp;000&nbsp;px documents」
    // 千位分隔符在 HTML 里是 `&nbsp;` 实体，不是空格 —— 所以得先把它还原。
    const en = SITE_TEMPLATE.match(/(\d(?:[\d\s ]|&nbsp;)*)\s*px documents/);
    expect(en, '站点模板（英文）里找不到页面高度上限的声称').toBeTruthy();
    expect(
      Number(en![1].replace(/[\s ]|&nbsp;/g, '')),
      `站点英文版说上限 ${en![1]} px，代码里是 ${limit}`,
    ).toBe(limit);
  });

  /**
   * listing 写的快捷键，wxt.config.ts 里真的这么声明。
   *
   * 声明的写法是 `default: 'Alt+Shift+S'`（Chrome 扩展的 suggested_key
   * 格式），所以这里比的是**完整的和弦字符串**，不是单个 key ——
   * 比单 key 会被 `Alt+Shift+S` 里的 `Shift` 误判成另一个快捷键。
   *
   * 反向查（声明了但文档没写）由 store-listing-consistency 那条负责。
   */
  /**
   * README 里的数字也要对。
   *
   * README 是**公开仓库首页** —— 审核员、用户、以后维护的人都会看它。
   * 之前只有权限理由表被守门覆盖，数字型声称是裸的。
   *
   * 注意：README 里那些 band 数（7/7、150、124/124）是 PoC-D3 的
   * **实测结果**，不是公式推导出来的 —— 那些不查（查了只会假报警）。
   * 这里只查能从常量推导的：历史库容量、页面高度上限。
   */
  test('README 里的数字型声称 = 代码常量', () => {
    const max = readNumericConst('utils/history-store.ts', 'HISTORY_MAX_ENTRIES');
    const limit = readNumericConst('utils/screenshot-engine.ts', 'HARD_PAGE_LIMIT_PX');

    // 「50-entry LRU」
    const en = README.match(/(\d+)-entry LRU/);
    expect(en, 'README 里找不到「N-entry LRU」的历史库容量声称').toBeTruthy();
    expect(
      Number(en![1]),
      `README 说历史库 ${en![1]} 条，代码里 HISTORY_MAX_ENTRIES = ${max}`,
    ).toBe(max);

    // 「max 50, LRU eviction」
    const cap = README.match(/max (\d+), LRU eviction/);
    expect(cap, 'README 里找不到「max N, LRU eviction」').toBeTruthy();
    expect(
      Number(cap![1]),
      `README 说历史库上限 ${cap![1]} 条，代码里是 ${max}`,
    ).toBe(max);

    // 「50 000」页面高度上限
    const h = README.match(/`min\(([\d\s ]+),/);
    expect(h, 'README 里找不到页面高度上限的公式').toBeTruthy();
    expect(
      Number(h![1].replace(/[\s ]/g, '')),
      `README 说上限 ${h![1]} px，代码里 HARD_PAGE_LIMIT_PX = ${limit}`,
    ).toBe(limit);
  });

  /**
   * README 写的是「min(50 000, ⌊65 535 / DPR⌋)」这个**公式** ——
   * 公式里的两个数都要和代码一致，而且公式本身要真的成立。
   *
   * 直接用代码里的 `maxAllowedCssHeight()` 验：
   * README 声称 DPR=1 → 50 000，DPR=2 → 32 767。
   */
  test('README 的页面高度上限公式 = 代码算出来的值', () => {
    const limit = readNumericConst('utils/screenshot-engine.ts', 'HARD_PAGE_LIMIT_PX');
    const canvasCap = readNumericConst('utils/screenshot-engine.ts', 'MAX_CANVAS_DIMENSION_PX');

    // README 原文：「(50 000 at DPR 1, 32 767 at DPR 2)」
    const m = README.match(/\((\d[\d\s ]+) at DPR 1, (\d[\d\s ]+) at DPR 2\)/);
    expect(m, 'README 里找不到「N at DPR 1, M at DPR 2」的上限说明').toBeTruthy();

    const dpr1 = Number(m![1].replace(/[\s ]/g, ''));
    const dpr2 = Number(m![2].replace(/[\s ]/g, ''));

    expect(dpr1, 'README 说 DPR 1 的上限和 HARD_PAGE_LIMIT_PX 不一致').toBe(limit);
    expect(dpr2, 'README 说 DPR 2 的上限和代码算出来的不一致').toBe(
      maxAllowedCssHeight(2),
    );

    // 公式里的 canvas 上限也要对
    const canvas = README.match(/⌊(\d[\d\s ]+) \/ DPR⌋/);
    expect(canvas, 'README 里找不到 canvas 维度上限').toBeTruthy();
    expect(
      Number(canvas![1].replace(/[\s ]/g, '')),
      `README 说 canvas 上限 ${canvas![1]}，代码里 MAX_CANVAS_DIMENSION_PX = ${canvasCap}`,
    ).toBe(canvasCap);
  });

  test('listing 写的快捷键，wxt.config.ts 里真的这么声明', () => {
    const cfg = readFileSync(resolve(ROOT, 'wxt.config.ts'), 'utf8');

    // listing 详细说明里的「Alt+Shift+X」写法
    for (const m of submittedCopy().matchAll(/(Alt\+Shift\+[A-Z])/g)) {
      const chord = m[1];
      expect(
        cfg.includes(`'${chord}'`) || cfg.includes(`"${chord}"`),
        `listing 写了快捷键 ${chord}，但 wxt.config.ts 里没有声明这个和弦`,
      ).toBe(true);
    }
  });
});
