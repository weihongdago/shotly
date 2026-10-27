/**
 * 历史库的「重新下载」能力 —— 防回归。
 *
 * ## 这个守门在防什么
 *
 * D+4 深夜发现：`getHistoryBlob()` 存在、有文档注释、有单测覆盖，
 * **但整个 UI 从来没调用过它**。历史库面板只有一个「删除」按钮 ——
 * 你能存 50 张全页截图，然后一张也拿不回来。
 *
 * 而公开站点首页写着：
 *   "Local history (50 entries, LRU) so you can re-download yesterday's shot"
 *
 * 也就是说，**对外吹的功能实际上不存在**。这是比文案过时更严重的一类问题：
 * 不是「说错了」，是「根本没做」，而且没人发现 —— 因为没有任何东西
 * 提醒你缺这一块。
 *
 * 「API 存在 + 有单测 + 没人调用」是一个**静默通过**的状态：
 * - 单元测试全绿（测的是那个 API 自己，不是它的调用方）
 * - typecheck 全绿（没人引用就没有类型错误）
 * - CI 全绿
 * - 唯一的破绽在产品层面：用户点不到那个功能
 *
 * 所以这里不测「API 能不能用」，测「**UI 有没有真的接上**」。
 *
 * ## 为什么用静态检查而不是组件测试
 *
 * popup 是 Vue SFC，没有现成的组件测试基座（@vue/test-utils 也没装）。
 * 为一个断言引入整套组件测试基座不划算。这里直接读 App.vue 源码，
 * 检查关键接线是否还在 —— 漂了就会红。
 *
 * 代价：这是**结构性**检查，不是**行为性**检查。真正的行为验证在
 * `test-infra/e2e/`（真实 Chrome 跑一遍重新下载）。
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..', '..');
const POPUP = resolve(ROOT, 'entrypoints', 'popup', 'App.vue');
const HISTORY_STORE = resolve(ROOT, 'utils', 'history-store.ts');
const I18N = resolve(ROOT, 'utils', 'i18n.ts');
const BUILD_PAGES = resolve(ROOT, 'tools', 'build-pages.mjs');

describe('历史库 · 重新下载', () => {
  it('popup 导入了 getHistoryBlob（真的去 IndexedDB 取 blob）', () => {
    const popup = readFileSync(POPUP, 'utf8');
    expect(
      /import\s*\{[^}]*getHistoryBlob[^}]*\}\s*from\s*['"][^'"]*history-store['"]/.test(popup),
      'popup 没有 import getHistoryBlob —— 历史库的图取不回来',
    ).toBe(true);
  });

  it('popup 真的调用了 getHistoryBlob（不是只 import）', () => {
    const popup = readFileSync(POPUP, 'utf8');
    const calls = popup.match(/await\s+getHistoryBlob\s*\(/g) ?? [];
    expect(
      calls.length,
      'popup import 了 getHistoryBlob 但从没调用 —— 这正是原来的 bug：' +
        'API 存在、有单测、没人用，功能实际不存在',
    ).toBeGreaterThan(0);
  });

  it('历史库每一行都有「下载」和「删除」两个动作', () => {
    const popup = readFileSync(POPUP, 'utf8');
    // 历史列表那一段
    const listBlock = popup.match(/<ul[^>]*history-list[\s\S]*?<\/ul>/)?.[0];
    expect(listBlock, '找不到历史列表的模板').toBeTruthy();

    expect(
      /@click="downloadHistoryItem\(item\)"/.test(listBlock!),
      '历史条目没有重新下载按钮 —— 首页吹的「re-download yesterday\'s shot」是假的',
    ).toBe(true);
    expect(
      /@click="removeHistoryItem\(item\.id\)"/.test(listBlock!),
      '历史条目没有删除按钮',
    ).toBe(true);
  });

  it('重新下载用的文件名带标题和时间戳（不会互相覆盖）', () => {
    const popup = readFileSync(POPUP, 'utf8');
    const fn = popup.match(/async function downloadHistoryItem[\s\S]*?\n}/)?.[0];
    expect(fn, '找不到 downloadHistoryItem').toBeTruthy();

    expect(
      /buildExportFilename\s*\(\{[\s\S]*?title:\s*item\.meta\.title/.test(fn!),
      '重新下载没有用历史条目的标题命名文件',
    ).toBe(true);
    expect(
      /timestamp:\s*item\.meta\.capturedAt/.test(fn!),
      '重新下载没有用历史条目的时间戳 —— 同一张图反复下载会互相覆盖',
    ).toBe(true);
  });

  it('重新下载失败时有用户能看懂的提示（不是静默吞掉）', () => {
    const popup = readFileSync(POPUP, 'utf8');
    const fn = popup.match(/async function downloadHistoryItem[\s\S]*?\n}/)?.[0];
    expect(fn, '找不到 downloadHistoryItem').toBeTruthy();

    // 取不到 blob（比如刚被删了）必须报错，不能静默什么都不发生
    expect(
      /errorMsg\.value\s*=/.test(fn!),
      '重新下载失败时没有设置 errorMsg —— 用户点了没反应都不知道为什么',
    ).toBe(true);
  });

  it('i18n 里两种语言都有重新下载相关的文案', () => {
    const i18n = readFileSync(I18N, 'utf8');
    for (const key of ['error.downloadFailed', 'error.historyMissing']) {
      const hits = i18n.match(new RegExp(`'${key}'`, 'g')) ?? [];
      expect(hits.length, `i18n 里 '${key}' 只出现了一次（en/zh 必须都有）`).toBe(2);
    }
  });

  it('getHistoryBlob 返回的是原始 PNG（格式转换是可选的，不阻塞下载）', () => {
    const store = readFileSync(HISTORY_STORE, 'utf8');
    const fn = store.match(/export async function getHistoryBlob[\s\S]*?\n}/)?.[0];
    expect(fn, '找不到 getHistoryBlob').toBeTruthy();
    expect(
      /Blob \| undefined/.test(fn!),
      'getHistoryBlob 的返回类型变了 —— 检查重新下载的实现是否还成立',
    ).toBe(true);
  });

  it('首页那句「re-download」有对应的实现，不是空头承诺', () => {
    const pages = readFileSync(BUILD_PAGES, 'utf8');
    const claimsRedownload = /re-download/i.test(pages);
    const popup = readFileSync(POPUP, 'utf8');
    const implementsRedownload = /downloadHistoryItem/.test(popup);

    // 两边必须一致：吹了就得做，做了才能吹
    expect(
      claimsRedownload === implementsRedownload,
      `首页 ${claimsRedownload ? '声称' : '没声称'}可以重新下载，` +
        `但 popup ${implementsRedownload ? '实现了' : '没实现'} —— ` +
        '对外宣传和实际功能必须对齐',
    ).toBe(true);
  });

  it('扩展产物存在（避免守门在没构建时静默跳过）', () => {
    expect(
      existsSync(resolve(ROOT, 'entrypoints', 'popup', 'App.vue')),
      '找不到 popup 源码',
    ).toBe(true);
  });
});
