/**
 * Shotly **打包产物**冒烟测试
 *
 * 为什么单独测 zip：
 *   CWS 收到的是 `shotly-0.1.0-chrome.zip`，不是 `.output/chrome-mv3/`。
 *   其它所有 E2E 测的都是 unpacked 目录 —— 内容一样，但**打包这一步本身**
 *   是个可能出错的黑盒：`wxt zip` 打包规则变了、某个 locale 目录被漏掉、
 *   `.output` 里有个残留文件被一起打进去、manifest 被改写……
 *   这些都是 unpacked 测不出来的。
 *
 * 所以：把 zip 解到临时目录，**从解压出来的目录**装进 Chrome，
 *       跑一次真实截图。
 *
 * 与 `playwright-mv3-launcher.spec.ts` 的区别：那份测 unpacked 目录，
 * 这份测**打包后**的形态。两者都要，因为「本地能跑」和「提交给审核的能跑」
 * 是两件事。
 */

import { test, expect } from '@playwright/test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { launchShotly, runCapture, type ShotlyHarness } from './helpers/shotly-harness';

const SHOTLY_DIR = resolve(process.cwd());
const BUILT_DIR = join(SHOTLY_DIR, '.output', 'chrome-mv3');
const ZIP_PATH = join(SHOTLY_DIR, '.output', 'shotly-0.1.0-chrome.zip');

/** Unzip the packaged artifact into a temp dir and return that dir. */
function unzipPackage(): string {
  const dest = mkdtempSync(join(tmpdir(), 'shotly-zip-'));
  execFileSync('unzip', ['-q', '-o', ZIP_PATH, '-d', dest], { stdio: 'pipe' });
  return dest;
}

test.describe('Shotly 打包产物（提交给 CWS 的 zip）', () => {
  let harness: ShotlyHarness;
  let extracted = '';

  test.beforeAll(async () => {
    test.skip(!existsSync(ZIP_PATH), `还没打包：缺少 ${ZIP_PATH}（先跑 pnpm zip）`);

    extracted = unzipPackage();
    harness = await launchShotly({ bootWaitMs: 8000, extensionPath: extracted });
  });

  test.afterAll(async () => {
    await harness?.close();
    if (extracted) rmSync(extracted, { recursive: true, force: true });
  });

  test('zip 里包含 manifest / popup / offscreen / _locales', () => {
    for (const f of [
      'manifest.json',
      'popup.html',
      'offscreen.html',
      'background.js',
      '_locales/en/messages.json',
      '_locales/zh_CN/messages.json',
    ]) {
      expect(existsSync(join(extracted, f)), `zip 里缺 ${f}`).toBe(true);
    }
  });

  test('zip 里的 manifest 与 unpacked 构建一致', () => {
    const a = execFileSync('cat', [join(BUILT_DIR, 'manifest.json')], { encoding: 'utf8' });
    const b = execFileSync('cat', [join(extracted, 'manifest.json')], { encoding: 'utf8' });
    expect(JSON.parse(b)).toEqual(JSON.parse(a));
  });

  test('从 zip 解压出来的扩展能装进 Chrome 并跑通真实截图', async () => {
    const outcome = await runCapture(harness, {
      targetUrl: harness.server.page('long-page.html'),
      timeoutMs: 120_000,
    });

    expect(
      outcome.status,
      `打包产物跑截图失败：${outcome.status === 'error' ? outcome.error : ''}`,
    ).toBe('done');
    if (outcome.status !== 'done') return;

    // 产物必须是真的图，不是空壳 —— 否则「装得上」也说明不了什么。
    expect(outcome.result.byteSize, '截图是空的').toBeGreaterThan(1000);
    expect(outcome.analysis.height, '截图高度不对').toBeGreaterThan(800);
    expect(
      outcome.analysis.nonWhiteRatio,
      '截图一片空白 —— 打包产物没真正工作',
    ).toBeGreaterThan(0.05);
  });
});
