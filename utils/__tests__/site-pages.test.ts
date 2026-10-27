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

  /**
   * 首页「What it does」里的每一条，代码里都要真的能做。
   *
   * ## 为什么需要这条
   *
   * D+4 深夜发现：首页写着「Local history (50 entries, LRU) so you can
   * **re-download** yesterday's shot」，但当时 popup 里历史库**只能删、
   * 不能下载** —— 站点吹了一个不存在的功能。
   *
   * 这条比 listing 漂移更危险：listing 的文案会被审核逐句读，
   * 但**首页是审核员随手点开的**。吹了就会变成「功能不足 / 只是个空壳」
   * 的拒因。
   *
   * 所以这里逐条验：站点声称的能力 → 代码里必须有对应实现。
   */
  test('首页声称的每个功能，代码里都要真的能做', () => {
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

    const index = readDist('index.html');

    // 站点文案里的关键词 → 代码里必须存在的证据
    const claims: Array<{ kw: RegExp; evidence: RegExp; label: string }> = [
      {
        kw: /re-download/i,
        label: '从历史库重新下载',
        // 必须是**真的**下载：既要有 store 取 blob 的接口，也要有 popup 的下载动作
        evidence: /getHistoryBlob\s*\(/,
      },
      {
        kw: /50 entries|LRU/i,
        label: '历史库 50 条 + LRU 淘汰',
        evidence: /HISTORY_MAX_ENTRIES\s*=\s*50/,
      },
      {
        kw: /Region capture/i,
        label: '区域截图',
        evidence: /captureRegion/,
      },
      {
        kw: /PNG,? JPG or PDF/i,
        label: '导出 PNG / JPG / PDF',
        evidence: /application\/pdf/,
      },
      {
        kw: /clipboard/i,
        label: '复制到剪贴板',
        evidence: /clipboard\.write\(/,
      },
      {
        kw: /live progress bar/i,
        label: '实时进度条',
        evidence: /progress/i,
      },
      {
        kw: /Light and dark UI/i,
        label: '深浅色 UI',
        evidence: /prefers-color-scheme/,
      },
    ];

    for (const c of claims) {
      if (!c.kw.test(index)) continue; // 站点没提这条，跳过
      expect(
        c.evidence.test(src),
        `首页声称「${c.label}」，但代码里找不到对应实现 —— 站点吹了不存在的功能`,
      ).toBe(true);
    }
  });

  /**
   * 「re-download」这条要在 **store 层**再查一次。
   *
   * 上一条用聚合源码做证据匹配，有漏洞：把 store 里的
   * `getHistoryBlob` 改名后，popup 里的**调用点**还是匹配得上，
   * 守门就漏了。所以这条直接验 store 里**定义**了这个导出函数。
   */
  test('首页声称能 re-download，store 层就得真的提供取 blob 的接口', () => {
    const index = readDist('index.html');
    if (!/re-download/i.test(index)) return;

    const store = readFileSync(resolve(ROOT, 'utils', 'history-store.ts'), 'utf8');
    expect(
      /export\s+async\s+function\s+getHistoryBlob\s*\(/m.test(store),
      '首页声称能 re-download，但 utils/history-store.ts 里没有导出 getHistoryBlob —— store 层取不到 blob',
    ).toBe(true);
  });

  /**
   * 「re-download」这条要**额外**查一次 popup 里有没有下载动作。
   *
   * 上一条只查了 store 层有 `getHistoryBlob` —— 但如果 popup 根本没调用它，
   * 用户在界面上还是下载不了。这条验的是**界面层**。
   */
  test('首页声称能 re-download，popup 界面就必须真的有下载动作', () => {
    const index = readDist('index.html');
    if (!/re-download/i.test(index)) return;

    const popup = readFileSync(resolve(ROOT, 'entrypoints', 'popup', 'App.vue'), 'utf8');
    expect(
      /downloadHistoryItem/.test(popup),
      '首页声称能 re-download，但 popup 里没有下载历史条目的动作',
    ).toBe(true);
    expect(
      /@click="downloadHistoryItem\(/i.test(popup),
      'popup 里有 downloadHistoryItem 函数，但没有绑到任何按钮上 —— 界面上点不到',
    ).toBe(true);
  });
});
