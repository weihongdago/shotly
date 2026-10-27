/**
 * 商店 listing ↔ 实现 一致性（CI 守门）
 *
 * 这个测试跑在 `pnpm test` 里 —— 也就是 **CI 每次 push 都会跑**。
 * （另有一份 Playwright 版在 test-infra/，那份做真实浏览器校验；
 *   这一份是静态守门，不依赖浏览器，跑得快、能在 CI 里拦下漂移。）
 *
 * 为什么要守：
 *   listing 吹了没实现的功能 = 商店审核拒 + 用户信任危机。
 *   而「代码、manifest、listing 三处各改各的」这种漂移，人眼看不住。
 *
 * 两条独立的漂移方向：
 *   1. listing 承诺了 manifest 没有的功能（吹）
 *   2. manifest 有功能但 listing 没提（漏 —— 少见，但会让用户预期错）
 */

import { test, expect, describe } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..', '..'); // shotly/
const LISTING_PATH = resolve(ROOT, 'store-assets', 'CWS-listing.md');
const WXT_CONFIG = resolve(ROOT, 'wxt.config.ts');
const BACKGROUND = resolve(ROOT, 'entrypoints', 'background.ts');
const MANIFEST = resolve(ROOT, '.output', 'chrome-mv3', 'manifest.json');
const RUNBOOK = resolve(ROOT, 'store-assets', 'SUBMIT-RUNBOOK.md');

/**
 * 有些检查必须读**真实构建产物**（.output/chrome-mv3/）。
 *
 * 产物不存在时，本地跳过（没 build 就不该卡住单测），但 CI 里必须**报错** ——
 * 静默跳过会让这条检查在 CI 上形同虚设，而看上去还是绿的。
 * CI 的 workflow 里 build 排在 test 之前，所以产物一定在。
 */
function requireBuiltOutput(): boolean {
  if (existsSync(MANIFEST)) return true;
  if (process.env.CI) {
    expect(
      false,
      'CI 里缺少 .output/chrome-mv3/ —— build 必须在 test 之前跑，否则这两条检查会静默失效',
    ).toBe(true);
  } else {
    console.warn('[store-listing-guard] 没找到构建产物，跳过产物级检查（CI 里会报错）');
  }
  return false;
}

function readListing(): string {
  return readFileSync(LISTING_PATH, 'utf8');
}

/**
 * The copy that actually gets submitted to the store.
 *
 * Everything else in the markdown (permission tables, risk table, notes)
 * is *documentation about* the listing — it legitimately mentions things
 * that are not in the submitted text. Only the fenced blocks are the real
 * listing copy, so only those get checked.
 */
function readSubmittedCopy(): string {
  return [...readListing().matchAll(/```\n([\s\S]*?)\n```/g)].map((m) => m[1]).join('\n');
}

/** Shortcuts declared in wxt.config.ts — the source the manifest is built from. */
function declaredShortcuts(): string[] {
  const src = readFileSync(WXT_CONFIG, 'utf8');
  const block = src.match(/commands:\s*\{([\s\S]*?)\n    \},/);
  if (!block) return [];
  const out: string[] = [];
  for (const m of block[1].matchAll(/'([a-z-]+)':\s*\{[\s\S]*?default:\s*'([^']+)'/g)) {
    out.push(m[2]);
  }
  return out;
}

describe('商店 listing ↔ 实现 一致性', () => {
  test('listing 文件存在（提交材料在仓库里，不在别处）', () => {
    expect(existsSync(LISTING_PATH), `找不到 listing：${LISTING_PATH}`).toBe(true);
  });

  test('listing 提到的每个快捷键都在 wxt.config.ts 里声明', () => {
    const declared = new Set(declaredShortcuts());
    const mentioned = new Set(readSubmittedCopy().match(/Alt\+Shift\+[A-Z]/g) ?? []);

    expect(mentioned.size, 'listing 正文里一个快捷键都没提，检查正则是否失效').toBeGreaterThan(0);
    for (const key of mentioned) {
      expect(declared.has(key), `listing 提到 ${key}，但 manifest 没有声明这个快捷键`).toBe(true);
    }
  });

  test('wxt.config.ts 里的每条 command 在 background 里都有独立分支', () => {
    const src = readFileSync(WXT_CONFIG, 'utf8');
    const block = src.match(/commands:\s*\{([\s\S]*?)\n    \},/);
    const names = block ? [...block[1].matchAll(/'([a-z-]+)':\s*\{/g)].map((m) => m[1]) : [];
    expect(names.length, 'wxt.config.ts 里没有声明任何 command').toBeGreaterThan(0);

    const bg = readFileSync(BACKGROUND, 'utf8');
    for (const name of names) {
      // 每条命令必须有**独立**分支，不能是 `cmd === 'a' || cmd === 'b'` ——
      // 合并意味着两条命令走同一条流程（这正是 D+4 发现的假承诺）。
      const ownBranch = new RegExp(`cmd\\s*===\\s*['"\`]${name}['"\`]`).test(bg);
      expect(ownBranch, `command "${name}" 在 background 里没有独立分支`).toBe(true);
    }

    const merged = bg.match(
      /cmd\s*===\s*['"][^'"]+['"]\s*\|\|\s*cmd\s*===\s*['"][^'"]+['"]/g,
    );
    expect(
      merged ?? [],
      `background 把多条 command 合并到同一个 handler：${merged?.join(' / ')}`,
    ).toEqual([]);
  });

  test('构建产物里没有硬编码的第三方网络请求', () => {
    // 「不上传、不追踪」是 listing 的第一卖点，也是隐私政策的承诺。
    // 静态扫一遍构建产物，防止有人偷偷加进埋点 SDK。
    if (!requireBuiltOutput()) return;
    const outDir = resolve(ROOT, '.output', 'chrome-mv3');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = resolve(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.js')) files.push(p);
      }
    };
    walk(outDir);

    const suspects: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      const netCalls =
        src.match(/(?:fetch|axios\.(?:get|post|put)|\.open)\s*\(\s*['"`](https?:\/\/[^'"`]+)/g) ?? [];
      for (const c of netCalls) suspects.push(`${f.replace(outDir, '')}: ${c}`);
      const scriptLoads = src.match(/importScripts\s*\(\s*['"`](https?:\/\/[^'"`]+)/g) ?? [];
      for (const c of scriptLoads) suspects.push(`${f.replace(outDir, '')}: ${c}`);
    }
    expect(suspects, `构建产物里出现了硬编码的第三方网络请求：\n${suspects.join('\n')}`).toEqual([]);
  });

  test('manifest 权限与 listing 的权限理由表完全一致（不多不少）', () => {
    if (!requireBuiltOutput()) return;
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as {
      permissions?: string[];
      host_permissions?: string[];
    };
    const declared = new Set([...(manifest.permissions ?? []), ...(manifest.host_permissions ?? [])]);

    // 权限理由表行形如：| `activeTab` | Access the current tab ... |
    const mentioned = [...readListing().matchAll(/^\| `([a-zA-Z<>/_]+)` \| /gm)].map((m) => m[1]);

    expect(mentioned.length, 'listing 的权限理由表是空的').toBeGreaterThan(0);
    for (const p of mentioned) {
      expect(declared.has(p), `listing 声明了权限 "${p}"，但 manifest 里没有 —— 会被审核问`).toBe(true);
    }
    for (const p of declared) {
      expect(mentioned, `manifest 有权限 "${p}"，listing 里没有给出理由`).toContain(p);
    }
  });

  test('listing 不声称未实现的平台支持（Firefox / Edge / Safari）', () => {
    // 捕获链路依赖 `chrome.offscreen` —— Firefox 没实现这个 API，
    // 所以 firefox 产物运行时是坏的（见 README 顶部 ⚠️）。
    // 如果哪天真的支持了 Firefox，记得先改这条断言再改文案。
    const copy = readSubmittedCopy();
    const unsupported = ['firefox', 'edge', 'safari'].filter((b) =>
      new RegExp(`\\b${b}\\b`, 'i').test(copy),
    );
    expect(
      unsupported,
      `listing 声称支持 ${unsupported.join(' / ')}，但这些浏览器上扩展跑不起来`,
    ).toEqual([]);
  });

  test('提审手册的权限理由表与 listing 第 6 节完全一致', () => {
    // 提审手册（SUBMIT-RUNBOOK.md）是给「$5 到账后照着填」用，
    // 里面抄了一份权限理由表。两份一旦漂移，审核时照着填的就是旧文案
    // —— 而审核看的 manifest 是当下的。
    //
    // SSOT 是 listing 第 6 节；手册只是它的副本。
    const runbook = readFileSync(RUNBOOK, 'utf8');

    // 提取两边「| `perm` | reason |」形式的行，比对权限名与理由文本。
    const rows = (text: string) =>
      new Map(
        [...text.matchAll(/^\| `([a-zA-Z<>/_]+)` \| ([^|]+) \|/gm)].map((m) => [
          m[1],
          m[2].trim(),
        ]),
      );

    // ⚠️ listing 里有**两张**权限表：第 6 节（英文，提交用）和
    //    第 9.4 节（中文，参考用）。这里只能取英文那张 ——
    //    否则 Map 会被后出现的中文行覆盖，比对的就不是同一个东西了。
    const listingText = readListing();
    const enSection = listingText.split(/^## 6\./m)[1]?.split(/^## 7\./m)[0] ?? '';
    expect(enSection.length, 'listing 第 6 节（英文权限表）没找到').toBeGreaterThan(100);

    const listingRows = rows(enSection);
    const runbookRows = rows(runbook);

    expect(listingRows.size, 'listing 第 6 节的权限表解析不出来').toBeGreaterThan(0);
    expect(runbookRows.size, '提审手册的权限表解析不出来').toBeGreaterThan(0);

    for (const [perm, reason] of listingRows) {
      expect(runbookRows.has(perm), `提审手册缺权限 "${perm}" 的理由`).toBe(true);
      expect(
        runbookRows.get(perm),
        `提审手册里 "${perm}" 的理由与 listing 第 6 节不一致 —— 以 listing 为准`,
      ).toBe(reason);
    }
  });
});
