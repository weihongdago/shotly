/**
 * 公开站点的完整性检查
 *
 * CWS 后台要填三个 URL，全部必须**当场可访问**：
 *   - 隐私政策（必填）
 *   - 支持页面（必填）
 *   - 主页
 *
 * 站点是 GitHub Pages 托管的，域名 getshotly.com 还没注册，所以这三个
 * URL 全指向 weihongdago.github.io/shotly/。审核员点进去发现 404
 * 就是退审 —— 不会有第二次机会。
 *
 * 本测试跑在 `pnpm test` 里，CI 每次 push 都跑。
 * 它检查的是**生成出来的 dist-pages/**（也就是真正发布上去的东西），
 * 不是源码 —— 源码对了但生成逻辑坏了的情况照样会漏。
 */

import { test, expect, describe } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..', '..');
const DIST = resolve(ROOT, 'dist-pages');

/** 站点在 GitHub Pages 上的公开地址。 */
const SITE = 'https://weihongdago.github.io/shotly';

function readDist(file: string): string {
  return readFileSync(resolve(DIST, file), 'utf8');
}

/**
 * dist-pages 没构建出来时的处理。
 *
 * - CI 里：**硬失败**。站点没构建 = 检查形同虚设，而看上去还是绿的。
 *   CI workflow 里 build-pages 排在 test 之前，所以产物一定在。
 * - 本地：跳过（没跑 build-pages 就不该卡住单测）。
 */
const DIST_READY = existsSync(resolve(DIST, 'index.html'));

if (!DIST_READY && process.env.CI) {
  expect(
    false,
    'CI 里缺少 dist-pages/ —— 站点没构建，检查会静默失效（先跑 node tools/build-pages.mjs）',
  ).toBe(true);
}
if (!DIST_READY) {
  console.warn('[site-guard] 没找到 dist-pages/，跳过站点检查（CI 里会报错）');
}

/**
 * `describe.skipIf` 而不是 `beforeAll` + `test.skip()` ——
 * vitest 2.x 的 `test.skip()` 只接受 (name, fn)，传布尔值是类型错误。
 * 整个 suite 跳过才是这里想要的语义。
 */
describe.skipIf(!DIST_READY)('公开站点（GitHub Pages）', () => {

  test('三个 CWS 必填/常用 URL 都有对应的页面', () => {
    for (const f of ['index.html', 'privacy.html', 'support.html']) {
      expect(existsSync(resolve(DIST, f)), `缺 ${f} —— 后台对应 URL 会 404`).toBe(true);
    }
  });

  test('站点里没有指向未注册域名的链接', () => {
    // getshotly.com 还没注册，链过去就是 DNS 失败。
    // 域名到手后这条会自动失效（那时再改回来）。
    for (const f of readdirSync(DIST).filter((n) => n.endsWith('.html'))) {
      const html = readDist(f);
      const hits = html.match(/https?:\/\/(www\.)?getshotly\.com[^\s"'<]*/g) ?? [];
      expect(hits, `${f} 里链到了未注册的域名 getshotly.com：${hits.join(', ')}`).toEqual([]);
    }
  });

  test('隐私政策里的联系方式是可用的渠道（不是死邮箱）', () => {
    const html = readDist('privacy.html');
    // 必须是 GitHub Issues 这种当场能验证的渠道，而不是一个可能不存在的邮箱
    expect(
      html,
      '隐私政策没有指向 GitHub Issues —— 审核员无法验证联系方式',
    ).toContain('https://github.com/weihongdago/shotly/issues');
  });

  test('支持页面的联系方式是可用的渠道', () => {
    const html = readDist('support.html');
    expect(html, '支持页面没有指向 GitHub Issues').toContain(
      'https://github.com/weihongdago/shotly/issues',
    );
  });

  test('首页能导航到隐私政策和支持页面', () => {
    const html = readDist('index.html');
    expect(html, '首页没有隐私政策入口').toContain('./privacy.html');
    expect(html, '首页没有支持页面入口').toContain('./support.html');
  });

  test('站点里所有站内链接都指向真实存在的文件', () => {
    for (const f of readdirSync(DIST).filter((n) => n.endsWith('.html'))) {
      const html = readDist(f);
      const local = [...html.matchAll(/href="\.\/([^"]+)"/g)].map((m) => m[1]);
      for (const target of local) {
        expect(
          existsSync(resolve(DIST, target)),
          `${f} 链到 ./${target}，但那个文件不存在`,
        ).toBe(true);
      }
    }
  });

  test('站点里的绝对站点链接都指向正确的路径', () => {
    // index.html 用的是相对链接（./privacy.html），所以它本身不会出现
    // 站点绝对地址。这里查的是**所有**页面里出现的绝对站点 URL ——
    // 防止有人改仓库/站点路径后漏改某一页。
    for (const f of readdirSync(DIST).filter((n) => n.endsWith('.html'))) {
      const html = readDist(f);
      const urls = [
        ...html.matchAll(/https?:\/\/weihongdago\.github\.io\/[^\s"'<>]*/g),
      ].map((m) => m[0]);
      for (const u of urls) {
        expect(
          u.startsWith(`${SITE}/`) || u === SITE,
          `${f} 里的绝对链接指向了别的路径：${u}（期望 ${SITE}/...）`,
        ).toBe(true);
      }
    }
  });
});
