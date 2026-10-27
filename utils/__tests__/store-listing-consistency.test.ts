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
const PRIVACY_PATH = resolve(ROOT, 'PRIVACY.md');
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

  /**
   * CWS 表单字段的**硬上限**。
   *
   * 超限 = 表单直接不让你提交，而不是被审核挑出来。
   * 上限是官方文档写死的（2026-10-27 核对）：
   *   - 商品名称：45
   *   - 简短说明：132
   *   - 详细说明：16000
   *
   * 这些数字不常变，但**文案**会变 —— 改文案的人不会记得回头看上限。
   * 这里验两道：
   *   1. 实际文案没超限（超了 = 提审时表单报错）
   *   2. listing 里括号里写的那个数字 = 实际字符数（防止自我安慰）
   */
  test('CWS 表单字段没超硬上限（超限 = 表单不让提交）', () => {
    const s = readListing();

    const name = s.match(/## 1\. 商品名称\s*\n\n\*\*(.+?)\*\*/)?.[1];
    expect(name, 'listing 第 1 节没找到商品名称').toBeTruthy();
    expect(
      name!.length,
      `商品名称 ${name!.length} 字符，超过 CWS 上限 45：「${name!}」`,
    ).toBeLessThanOrEqual(45);

    const shortDesc = s.match(/## 2\.[\s\S]*?```\n([\s\S]*?)\n```/)?.[1];
    expect(shortDesc, 'listing 第 2 节没找到简短说明').toBeTruthy();
    expect(
      shortDesc!.length,
      `简短说明 ${shortDesc!.length} 字符，超过 CWS 上限 132`,
    ).toBeLessThanOrEqual(132);

    const detail = s
      .split('## 3.')[1]
      ?.split('## 4.')[0]
      ?.match(/```\n([\s\S]*?)\n```/)?.[1];
    expect(detail, 'listing 第 3 节没找到详细说明').toBeTruthy();
    expect(
      detail!.length,
      `详细说明 ${detail!.length} 字符，超过 CWS 上限 16000`,
    ).toBeLessThanOrEqual(16000);

    // 中文版同样有上限
    const cnName = s.match(/### 9\.1 商品名称\s*\n+```\n([\s\S]*?)\n```/)?.[1];
    expect(cnName, 'listing 9.1 没找到中文商品名称').toBeTruthy();
    expect(cnName!.length, `中文商品名称 ${cnName!.length} 字符，超过上限 45`).toBeLessThanOrEqual(45);

    const cnShort = s.match(/### 9\.2 简短说明[\s\S]*?```\n([\s\S]*?)\n```/)?.[1];
    expect(cnShort, 'listing 9.2 没找到中文简短说明').toBeTruthy();
    expect(cnShort!.length, `中文简短说明 ${cnShort!.length} 字符，超过上限 132`).toBeLessThanOrEqual(132);
  });

  /**
   * listing 里括号里声称的字符数 = 实际字符数。
   *
   * D+4 夜间发现提审手册写「详细说明 1122 字符」，实际只有 1079。
   * 数字本身不是审核项，但它一旦不准就说明**没人真的数过** ——
   * 而这份文案是要直接粘贴进 CWS 表单的。
   */
  test('listing 里声称的字符数 = 实际字符数', () => {
    const s = readListing();

    /**
     * ⚠️ 必须把标注正则**限定在该字段所属的章节**里。
     * 否则 `s.match(/（(\d+) 字符/)` 会命中全文**第一个**出现的位置
     * （商品名称那行），拿它的数字去对简短说明 —— 报错信息会指向错的字段。
     */
    const check = (label: string, actual: string, scope: string, claimedLine: RegExp) => {
      const m = scope.match(claimedLine);
      expect(m, `listing 的${label}节里没找到字符数标注`).toBeTruthy();
      const claimed = Number(m![1]);
      expect(
        claimed,
        `${label} 标注的字符数 ${claimed} ≠ 实际 ${actual.length}`,
      ).toBe(actual.length);
    };

    const sec1 = s.split('## 1.')[1]?.split('## 2.')[0] ?? '';
    const name = sec1.match(/\*\*(.+?)\*\*/)?.[1] ?? '';
    check('商品名称', name, sec1, /（(\d+) 字符，Chrome Web Store 上限 45/);

    const sec2 = s.split('## 2.')[1]?.split('## 3.')[0] ?? '';
    const shortDesc = sec2.match(/```\n([\s\S]*?)\n```/)?.[1] ?? '';
    check('简短说明', shortDesc, sec2, /（(\d+) 字符，上限 132/);

    const sec91 = s.split('### 9.1')[1]?.split('### 9.2')[0] ?? '';
    const cnName = sec91.match(/```\n([\s\S]*?)\n```/)?.[1] ?? '';
    check('中文商品名称', cnName, sec91, /（(\d+) 字符，上限 45/);

    const sec92 = s.split('### 9.2')[1]?.split('### 9.3')[0] ?? '';
    const cnShort = sec92.match(/```\n([\s\S]*?)\n```/)?.[1] ?? '';
    check('中文简短说明', cnShort, sec92, /（(\d+) 字符/);
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

  /**
   * 权限理由的**语义**必须和代码一致。
   *
   * 上面的用例只能验「权限名对得上」，验不了「理由写得对不对」。
   * D+4 夜间的真实 bug：listing 写
   *   | `storage` | Store user preferences (theme, default export format) |
   * 但代码里 chrome.storage 只存了**语言选择**（`shotly.locale`）——
   * 主题是跟随系统的（prefers-color-scheme），没有手动开关；
   * 导出格式根本没持久化。
   *
   * 这不算假宣传（审核不会逐字核），但**理由写得比实际宽**就等于给审核
   * 留了一个「这个权限到底用来干什么」的疑问。权限理由越具体，审核越容易放行。
   *
   * 所以这里逐条验：理由里提到的**每一项能力**，代码里都要真的存在。
   */
  test('权限理由里提到的每项能力，代码里都要真的存在', () => {
    const src = ['entrypoints', 'utils']
      .flatMap((d) => {
        const dir = resolve(ROOT, d);
        if (!existsSync(dir)) return [];
        const out: string[] = [];
        const walk = (p: string) => {
          for (const e of readdirSync(p, { withFileTypes: true })) {
            const full = resolve(p, e.name);
            if (e.isDirectory()) walk(full);
            else if (/\.(ts|vue)$/.test(e.name) && !e.name.includes('__tests__')) out.push(full);
          }
        };
        walk(dir);
        return out;
      })
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n');

    // 理由文本 → 能在代码里找到的证据（至少一个）
    const claims: Array<{ perm: string; needle: RegExp; evidence: RegExp }> = [
      {
        perm: 'storage',
        // 理由说存语言 → 代码必须有语言相关的 storage 键
        needle: /language|locale|语言/i,
        evidence: /chrome\.storage\.local\.(set|get)\(/,
      },
      {
        perm: 'clipboardWrite',
        needle: /clipboard/i,
        evidence: /clipboard\.write\(/,
      },
      {
        perm: 'downloads',
        needle: /download|save/i,
        evidence: /chrome\.downloads\.download\(/,
      },
      {
        perm: 'tabs',
        needle: /title|url/i,
        evidence: /tabs\.query\(/,
      },
      {
        perm: 'offscreen',
        needle: /offscreen|canvas|stitch/i,
        evidence: /chrome\.offscreen\.createDocument\(/,
      },
      {
        perm: 'scripting',
        needle: /region|overlay|inject/i,
        evidence: /executeScript|scripting/i,
      },
      {
        perm: 'activeTab',
        needle: /current tab|activeTab|当前标签页/i,
        evidence: /activeTab|tabs\.query\(/,
      },
      {
        perm: 'unlimitedStorage',
        needle: /history|IndexedDB|quota/i,
        evidence: /openDB\(|indexedDB/,
      },
    ];

    // 提取 listing 第 6 节的权限理由表（英文，提交用）
    const listingText = readListing();
    const enSection = listingText.split(/^## 6\./m)[1]?.split(/^## 7\./m)[0] ?? '';
    const reasons = new Map(
      [...enSection.matchAll(/^\| `([a-zA-Z<>/_]+)` \| ([^|]+) \|/gm)].map((m) => [
        m[1],
        m[2].trim(),
      ]),
    );

    for (const c of claims) {
      const reason = reasons.get(c.perm);
      if (reason == null) continue; // 该权限没在理由表里（另一个用例负责报错）
      expect(c.needle.test(reason), `权限 "${c.perm}" 的理由没提它实际做的事：${reason}`).toBe(
        true,
      );
      expect(
        c.evidence.test(src),
        `权限 "${c.perm}" 的理由声称了某项能力，但代码里找不到对应实现：${reason}`,
      ).toBe(true);
    }
  });

  /**
   * 反向：listing 的权限理由**不能**声称代码里不存在的能力。
   *
   * 上一条验「提到的是真的」，这条验「没提到的就不准吹」。
   * 具体盯死一类吹法：说存了某项偏好，但 chrome.storage 里其实没有那个键。
   */
  /**
   * 隐私政策里的 storage 描述也要和代码一致。
   *
   * CWS 会**逐条核对**隐私政策与实际行为 —— 政策写了但代码没做（或反过来），
   * 是被拒的常见原因，比 listing 措辞不当更硬。
   *
   * D+4 夜间发现的同一处不准：政策写「Preferences (theme, default format)」，
   * 但 chrome.storage 只存语言选择。
   */
  test('隐私政策里的 storage 描述与代码一致', () => {
    const privacy = readFileSync(PRIVACY_PATH, 'utf8');
    const i18n = readFileSync(resolve(ROOT, 'utils', 'i18n.ts'), 'utf8');
    const themeSrc = readFileSync(resolve(ROOT, 'utils', 'theme.ts'), 'utf8');

    // 政策里出现了哪些「被存储的偏好」
    const claimsTheme = /主题/.test(privacy) || /\btheme\b/i.test(privacy);
    const claimsFormat = /默认导出格式|默认格式|default (export )?format/i.test(privacy);

    const storesTheme = /chrome\.storage\.local\.set\(\{[^}]*theme/i.test(i18n + themeSrc);
    const storesFormat = /chrome\.storage\.local\.set\(\{[^}]*format/i.test(i18n + themeSrc);

    expect(
      claimsTheme ? storesTheme : true,
      '隐私政策声称存储了主题，但代码里没有（主题跟随系统，不是持久化偏好）',
    ).toBe(true);
    expect(
      claimsFormat ? storesFormat : true,
      '隐私政策声称存储了默认导出格式，但代码里没有',
    ).toBe(true);

    // 政策必须提到语言（唯一真的被存的偏好）
    expect(
      /语言|language|locale/i.test(privacy),
      '隐私政策没提界面语言选择 —— 而那才是实际被存储的东西',
    ).toBe(true);
  });

  test('权限理由不能声称存储了实际没存的东西', () => {
    const i18n = readFileSync(resolve(ROOT, 'utils', 'i18n.ts'), 'utf8');
    const themeSrc = existsSync(resolve(ROOT, 'utils', 'theme.ts'))
      ? readFileSync(resolve(ROOT, 'utils', 'theme.ts'), 'utf8')
      : '';
    const storageSrc = i18n + themeSrc;

    // storage 确实被用来存东西（至少一处 set 调用）
    expect(
      /chrome\.storage\.local\.set\(/.test(i18n),
      '代码里找不到 chrome.storage.local.set —— 这个检查方式失效了',
    ).toBe(true);

    const listingText = readListing();
    const enSection = listingText.split(/^## 6\./m)[1]?.split(/^## 7\./m)[0] ?? '';
    const storageRow = [...enSection.matchAll(/^\| `storage` \| ([^|]+) \|/gm)][0]?.[1] ?? '';

    expect(storageRow, 'listing 第 6 节没找到 storage 的理由行').not.toBe('');

    // 主题：必须真的有把主题写进 storage 的代码
    // （主题本身存在，但它是跟随系统的 prefers-color-scheme，不是存下来的偏好）
    if (/\btheme\b/i.test(storageRow) || /主题/.test(storageRow)) {
      expect(
        /chrome\.storage\.local\.set\(\{[^}]*theme/i.test(storageSrc),
        '权限理由声称存储了主题，但代码里没有把主题存进 chrome.storage（主题跟随系统，不是持久化偏好）',
      ).toBe(true);
    }

    // 默认导出格式：必须真的有把格式写进 storage 的代码
    if (/default (export )?format/i.test(storageRow) || /默认导出格式/.test(storageRow)) {
      expect(
        /chrome\.storage\.local\.set\(\{[^}]*format/i.test(storageSrc),
        '权限理由声称存储了默认导出格式，但代码里没有',
      ).toBe(true);
    }

    // 反向：说存的是语言，就必须真有语言相关的 storage 键
    if (/language|locale/i.test(storageRow) || /语言/.test(storageRow)) {
      expect(
        /shotly\.locale|locale/i.test(storageSrc) &&
          /chrome\.storage\.local\.set\(/.test(storageSrc),
        '权限理由声称存储语言选择，但代码里没有对应的 storage 键',
      ).toBe(true);
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
