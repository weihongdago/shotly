/**
 * Shotly 商店 listing ↔ 真实实现 一致性检查
 *
 * 背景（D+4 实测踩出来的）：listing 里写了
 *   「Alt+Shift+V — capture the visible viewport」
 * 但 manifest 里的 `capture-visible` 命令被 background 路由到了**跟
 * `capture-full-page` 完全一样**的全页截图流程 —— 用户按下去拿到的是整页长图。
 *
 * 这类“文案/文档吹了功能”的漂移靠人眼看不住：代码、manifest、listing
 * 三处各改各的，评审时才会暴露。所以把它变成测试。
 *
 * 本 spec 锁三件事：
 *   1. manifest 声明的每条 command，都必须在 background 里被**区别对待**
 *      （即：每条命令各自有独立的分支，而不是全部归到同一个 handler）
 *   2. listing 文本里提到的每个快捷键，都必须真实存在于 manifest
 *   3. listing 文本里提到的每个功能段落，都必须能在代码里找到对应的实现
 *
 * 真实浏览器跑真实构建产物，不 mock。
 */

import { test, expect } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SHOTLY_BUILT = resolve(process.cwd(), '.output', 'chrome-mv3');
const SHOTLY_SRC = resolve(process.cwd());
const LISTING = resolve(process.cwd(), 'store-assets', 'CWS-listing.md');

interface BuiltManifest {
  commands?: Record<string, { suggested_key?: { default?: string }; description?: string }>;
  permissions?: string[];
  host_permissions?: string[];
}

function readManifest(): BuiltManifest {
  return JSON.parse(readFileSync(resolve(SHOTLY_BUILT, 'manifest.json'), 'utf8')) as BuiltManifest;
}

function readListing(): string {
  return readFileSync(LISTING, 'utf8');
}

/**
 * The copy that actually gets submitted to the store.
 *
 * Everything else in the markdown (permission tables, risk table, my own
 * notes) is *documentation about* the listing — and it legitimately
 * mentions things that are not in the submitted text. Only the fenced
 * blocks are the real listing copy, so only those get checked.
 */
function readSubmittedCopy(): string {
  return [...readListing().matchAll(/```\n([\s\S]*?)\n```/g)].map((m) => m[1]).join('\n');
}

test.describe('Shotly listing ↔ 实现 一致性', () => {
  test.beforeAll(() => {
    test.skip(!existsSync(SHOTLY_BUILT), `shotly 未 build：缺少 ${SHOTLY_BUILT}`);
  });

  test('manifest 声明的每条 command 在 background 里都有独立分支', async () => {
    const manifest = readManifest();
    const commands = Object.keys(manifest.commands ?? {});
    expect(commands.length, 'manifest 没有声明任何快捷键').toBeGreaterThan(0);

    const bg = readFileSync(resolve(SHOTLY_SRC, 'entrypoints', 'background.ts'), 'utf8');

    for (const cmd of commands) {
      // 必须是 `if (cmd === '<name>')` 这种**各自独立**的分支，
      // 而不是 `if (cmd === 'a' || cmd === 'b')`。
      const ownBranch = new RegExp(`cmd\\s*===\\s*['"\`]${cmd}['"\`]`).test(bg);
      expect(ownBranch, `command "${cmd}" 在 background 里没有独立分支`).toBe(true);

      // 也不能出现在一个把多条命令合并的 or 条件里。
      const merged = bg.match(/cmd\s*===\s*['"][^'"]+['"]\s*\|\|\s*cmd\s*===\s*['"][^'"]+['"]/g);
      expect(
        merged ?? [],
        `background 把多条 command 合并到同一个 handler：${merged?.join(' / ')}`,
      ).toEqual([]);
    }
  });

  test('listing 提到的每个快捷键都在 manifest 里真实存在', async () => {
    const manifest = readManifest();
    const declared = new Set(
      Object.entries(manifest.commands ?? {}).map(([, v]) => v.suggested_key?.default ?? ''),
    );

    // 只看**实际提交的文案**（``` 围栏里的），不看文档正文 ——
    // 文档里的「已知风险」表会讨论具体快捷键，那是说明，不是承诺。
    const copy = readSubmittedCopy();
    const mentioned = new Set(copy.match(/Alt\+Shift\+[A-Z]/g) ?? []);

    expect(mentioned.size, 'listing 正文里一个快捷键都没提，检查正则是否失效').toBeGreaterThan(0);
    for (const key of mentioned) {
      expect(declared.has(key), `listing 提到 ${key}，但 manifest 没有声明这个快捷键`).toBe(true);
    }
  });

  test('listing 提到的每个权限都在 manifest 里（不多不少）', async () => {
    const manifest = readManifest();
    const listing = readListing();

    const declared = new Set([
      ...(manifest.permissions ?? []),
      ...(manifest.host_permissions ?? []),
    ]);

    // listing 第 6/9.4 节的权限理由表里，第一列是权限名。
    // 表格行形如：| `activeTab` | Access the current tab ... |
    const mentioned = [...listing.matchAll(/^\| `([a-zA-Z<>/_]+)` \| /gm)].map((m) => m[1]);

    expect(mentioned.length, 'listing 的权限理由表是空的').toBeGreaterThan(0);
    for (const p of mentioned) {
      expect(declared.has(p), `listing 声明了权限 "${p}"，但 manifest 里没有 —— 会被审核问`).toBe(
        true,
      );
    }

    // 反向：manifest 里的每个权限都必须在 listing 里有理由。
    for (const p of declared) {
      expect(mentioned, `manifest 有权限 "${p}"，listing 里没有给出理由`).toContain(p);
    }
  });

  test('listing 描述的功能在代码里有对应实现', async () => {
    const listing = readListing();
    const popup = readFileSync(resolve(SHOTLY_SRC, 'entrypoints', 'popup', 'App.vue'), 'utf8');
    const content = readFileSync(resolve(SHOTLY_SRC, 'entrypoints', 'content.ts'), 'utf8');

    // listing 承诺的四件事，逐一落到具体实现上。
    expect(popup, 'listing 承诺整页截图，popup 里没有对应入口').toContain('data-shotly-action="full"');
    expect(popup, 'listing 承诺区域截图，popup 里没有对应入口').toContain(
      'data-shotly-action="region"',
    );
    expect(content, 'listing 承诺区域框选，content script 里没有实现').toContain('selectRegion');
    expect(popup, 'listing 承诺 PNG/JPG/PDF 导出，popup 里没有格式选择').toContain(
      "['png', 'jpg', 'pdf']",
    );
    expect(popup, 'listing 承诺历史库，popup 里没有历史面板').toContain('showHistory');
  });
});
