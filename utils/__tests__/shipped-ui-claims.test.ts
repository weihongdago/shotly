/**
 * 出货 UI 不能承诺不存在的功能。
 *
 * ## 背景
 *
 * v0.1.0 的弹窗 footer 写着：
 *
 * > ✨ Upgrade Pro to unlock the editor + watermark
 *
 * 但那三样东西**一样都不存在**：
 *
 * - **Pro** —— 没有付费路径、没有账号、没有支付（隐私政策明说「没有账号体系」）
 * - **editor** —— 根本没有 editor 入口（`entrypoints/` 只有 background /
 *   content / offscreen / popup；manifest 里还专门警告别加计划中的
 *   `editor.html`）
 * - **watermark** —— 全仓库只有这一行字符串提到水印
 *
 * 而且它不是个按钮 —— 是一段**点不动的静态文字**，就在弹窗底部。
 *
 * ## 为什么严重
 *
 * 这行字出现在**商店 listing 截图**里（`store-assets/screenshots/04-*.png`
 * 就是拍这个弹窗的完成态）。审核员看到的是：
 *
 * - 描述里写「Free and open source」
 * - 截图里写「Upgrade Pro to unlock ...」
 *
 * 两个说法不可能同时为真。而 Chrome Web Store 对「误导性 UI」是要拒的。
 *
 * 之前已有守门覆盖了**文档**层面（历史设计稿不许声称已实现的功能），
 * 但**出货 UI** 这一层没管到 —— 那行字就在代码里跑着。
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const ROOT = resolve(__dirname, '..', '..');

function readAllSourceFiles(dir: string, exts: string[]): string {
  if (!existsSync(dir)) return '';
  const out: string[] = [];
  const walk = (p: string) => {
    for (const e of readdirSync(p, { withFileTypes: true })) {
      const full = resolve(p, e.name);
      if (e.isDirectory()) {
        if (e.name === '__tests__' || e.name === 'node_modules') continue;
        walk(full);
      } else if (exts.some((x) => e.name.endsWith(x))) {
        out.push(readFileSync(full, 'utf8'));
      }
    }
  };
  walk(dir);
  return out.join('\n');
}

/** 出货代码（不含测试）—— 「有没有实现」只看这里。 */
const shippedSrc = [
  readAllSourceFiles(resolve(ROOT, 'entrypoints'), ['.ts', '.vue']),
  readAllSourceFiles(resolve(ROOT, 'utils'), ['.ts', '.vue']),
].join('\n');

/**
 * 「真的有付费路径」的证据。
 *
 * ⚠️ 这个正则被坑过两次，都是**假阳性**：
 *   - `stripe` 匹配到了注释里的 "transparent **stripe**s"（颜色条纹）
 *   - `license` 匹配到了一个**空壳** port 名 `license-port`
 *     （为没实现的 Pro 版预留的，从来没被连接过，也没有 handler）
 *
 * 假阳性会让守门**永远绿** —— 那比没有守门更糟。
 * 所以这里用**词边界** + 具体的 API 名，而不是宽泛的单词。
 */
const PAID_TIER_EVIDENCE =
  /\bstripe\b\s*[\.\(]|stripe\.com|checkout\.session|paymentIntent|\bpayment\s*[:(]/i;

/**
 * 另一个更宽但仍需谨慎的证据层：真的存在账号/订阅/授权的业务逻辑。
 * 这层要求**不是**一个孤零零的 port 名。
 */
const ACCOUNT_EVIDENCE =
  /subscribe\s*\(|createSubscription|signIn|signUp|login\s*\(|purchase\s*\(|redeemLicense|validateLicense/i;

const i18n = readFileSync(resolve(ROOT, 'utils', 'i18n.ts'), 'utf8');
const popup = readFileSync(resolve(ROOT, 'entrypoints', 'popup', 'App.vue'), 'utf8');

describe('出货 UI 的功能声称（architecture §一致性）', () => {
  /**
   * 付费引导必须有真的付费路径。
   *
   * 只要 UI 里出现「升级 Pro / 付费 / premium」这类话，
   * 代码里就必须有对应的付费实现（支付、订阅、账号、授权）。
   *
   * 没有 → 守门报红。因为没有付费路径还挂着付费引导，
   * 就是**骗用户点一个点不动的东西**。
   */
  it('UI 里不许出现付费引导，除非代码里真有付费路径', () => {
    // UI 里付费引导的措辞
    const upsellWording = /upgrade\s*pro|premium|go\s*pro|upgrade\s*to\s*pro|付费|升级\s*pro|解锁\s*pro/i;

    // 只看**渲染出来的**文案（i18n 消息表 + 模板里的字面量）
    const userFacing = i18n + '\n' + popup;

    const hasWording = upsellWording.test(userFacing);
    const hasImplementation =
      PAID_TIER_EVIDENCE.test(shippedSrc) || ACCOUNT_EVIDENCE.test(shippedSrc);

    if (hasWording) {
      expect(
        hasImplementation,
        'UI 里出现了付费引导（Upgrade Pro / 付费 / premium），但代码里没有任何付费路径 —— ' +
          '这是骗用户点一个点不动的东西，而且商店截图里就拍着它',
      ).toBe(true);
    }
  });

  /**
   * UI 提到的功能，代码里必须真的有。
   *
   * 这条比上一条更宽：任何在 UI 文案里被点名当作**卖点**的功能
   * （编辑器、水印、批注、裁剪…），都得有实现。
   *
   * 做法：从 i18n 消息表里找出所有形如「解锁 X」「unlock X」「X + Y」
   * 的功能名词，再逐个在出货代码里找证据。
   */
  it('UI 里作为卖点提到的功能，代码里必须真的有', () => {
    // 「解锁 X」「unlock X」这种句式里点名的功能
    const namedFeatures = new Set<string>();
    for (const m of i18n.matchAll(
      /unlock(?:es)?\s+(?:the\s+)?([a-z][a-z ]{2,30}?)(?:\s*\+|$|')/gi,
    )) {
      for (const w of m[1].toLowerCase().split(/\s+/)) {
        if (w.length > 3) namedFeatures.add(w);
      }
    }

    // 已知的功能名词 → 代码里该有的证据
    const featureEvidence: Record<string, RegExp> = {
      editor: /editor/i,
      watermark: /watermark/i,
    };

    for (const feature of namedFeatures) {
      const evidence = featureEvidence[feature];
      if (!evidence) continue; // 没登记的功能名，跳过（登记了才查）
      expect(
        evidence.test(shippedSrc),
        `UI 文案里把「${feature}」当卖点（unlock ${feature}），但代码里找不到实现`,
      ).toBe(true);
    }
  });

  /**
   * 弹窗 footer 必须在说**真话**。
   *
   * 具体说：footer 的文案不能承诺任何未实现的付费/账号能力。
   * 这条单独拆出来，是因为 footer 就在弹窗最底部 —— 截图一眼就能看到，
   * 而它恰恰是当初写错的地方。
   */
  it('弹窗 footer 的文案不能承诺未实现的付费能力', () => {
    const footerKey = popup.match(/i18n\.t\('(footer\.[^']+)'\)/)?.[1];
    expect(footerKey, '弹窗里找不到 footer 的 i18n key').toBeTruthy();

    const msgRe = new RegExp(`'${footerKey}':\\s*'([^']*)'`);
    const en = i18n.match(msgRe)?.[1];
    expect(en, `i18n 里找不到 ${footerKey} 的英文文案`).toBeTruthy();

    const paidTierEvidence =
      PAID_TIER_EVIDENCE.test(shippedSrc) || ACCOUNT_EVIDENCE.test(shippedSrc);

    expect(
      /upgrade|pro\b|premium|pay|付费|升级|解锁/i.test(en!) &&
        !paidTierEvidence,
      `弹窗 footer 还在提付费（"${en}"），但代码里没有付费路径`,
    ).toBe(false);
  });

  /**
   * footer 说「免费」的话，listing 也得说「免费」—— 两边不能打架。
   *
   * 审核员会对照 listing 描述和截图。截图里写「Free」而描述里写「$5」
   * （或者反过来），就是在给自己找拒因。
   */
  it('footer 的「免费」承诺要和商店 listing 一致', () => {
    const listing = readFileSync(resolve(ROOT, 'store-assets', 'CWS-listing.md'), 'utf8');
    const footerKey = popup.match(/i18n\.t\('(footer\.[^']+)'\)/)?.[1];
    const en = i18n.match(new RegExp(`'${footerKey}':\\s*'([^']*)'`))?.[1] ?? '';

    const footerSaysFree = /free/i.test(en);
    const listingSaysFree = /Free and open source|免费且开源/i.test(listing);

    expect(
      footerSaysFree === listingSaysFree || !footerSaysFree,
      `footer 说免费=${footerSaysFree}，listing 说免费=${listingSaysFree} —— 两边不一致`,
    ).toBe(true);
  });
});
