/**
 * Build the public website (GitHub Pages) for Shotly.
 *
 * Why: the Chrome Web Store requires a **publicly accessible privacy
 * policy URL**. The domain (getshotly.com) is not registered yet, so
 * GitHub Pages stands in until it is — and it doubles as the project's
 * landing page, which the CWS listing also wants.
 *
 * Output goes to `dist-pages/`, which is published to the `gh-pages`
 * branch by `tools/publish-pages.mjs`.
 *
 * Usage: node tools/build-pages.mjs
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { markdownToHtml, page } from './md-to-html.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const outDir = resolve(root, 'dist-pages');
mkdirSync(outDir, { recursive: true });

const REPO = 'https://github.com/weihongdago/shotly';
const VERSION = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;

// ─── styles.css ──────────────────────────────────────────────────────────────
const CSS = `:root {
  --mint: #2dd4bf;
  --ink: #1f2328;
  --muted: #59636e;
  --line: #e6e8eb;
  --bg: #ffffff;
  --code-bg: #f6f8fa;
}
@media (prefers-color-scheme: dark) {
  :root {
    --ink: #e6edf3;
    --muted: #9198a1;
    --line: #30363d;
    --bg: #0d1117;
    --code-bg: #161b22;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 3rem 1.25rem 5rem;
  background: var(--bg);
  color: var(--ink);
  font: 16px/1.7 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
}
main { max-width: 52rem; margin: 0 auto; }
h1 { font-size: 2.1rem; line-height: 1.2; letter-spacing: -0.02em; margin: 0 0 .6rem; }
h2 { font-size: 1.35rem; margin: 2.4rem 0 .8rem; padding-bottom: .35rem; border-bottom: 1px solid var(--line); }
h3 { font-size: 1.05rem; margin: 1.8rem 0 .6rem; }
p, li { color: var(--ink); }
a { color: #0b6e99; }
code {
  background: var(--code-bg);
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: .1em .35em;
  font-size: .88em;
}
table { border-collapse: collapse; width: 100%; margin: 1rem 0; font-size: .94rem; }
th, td { border: 1px solid var(--line); padding: .5rem .7rem; text-align: left; vertical-align: top; }
th { background: var(--code-bg); font-weight: 600; }
hr { border: 0; border-top: 1px solid var(--line); margin: 2.2rem 0; }
blockquote {
  margin: 1rem 0;
  padding: .6rem 1rem;
  border-left: 3px solid var(--mint);
  background: var(--code-bg);
  border-radius: 0 6px 6px 0;
}
.eyebrow {
  display: inline-block;
  font-size: .78rem;
  letter-spacing: .08em;
  text-transform: uppercase;
  color: var(--mint);
  font-weight: 700;
  margin-bottom: .35rem;
}
.lede { font-size: 1.1rem; color: var(--muted); margin-top: 0; }
.cta { display: flex; flex-wrap: wrap; gap: .7rem; margin: 1.6rem 0 2rem; }
.btn {
  display: inline-block;
  padding: .6rem 1.05rem;
  border-radius: 8px;
  border: 1px solid var(--line);
  text-decoration: none;
  font-weight: 600;
  font-size: .95rem;
}
.btn.primary { background: var(--mint); border-color: var(--mint); color: #05231f; }
.btn:hover { filter: brightness(1.04); }
.cards { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr)); margin: 1.5rem 0 2rem; }
.card { border: 1px solid var(--line); border-radius: 10px; padding: 1rem 1.1rem; }
.card h3 { margin: 0 0 .4rem; font-size: 1rem; }
.card p { margin: 0; color: var(--muted); font-size: .93rem; }
footer { margin-top: 3.5rem; padding-top: 1.2rem; border-top: 1px solid var(--line); color: var(--muted); font-size: .88rem; }
`;
writeFileSync(resolve(outDir, 'styles.css'), CSS);

// ─── index.html ──────────────────────────────────────────────────────────────
const index = page({
  title: 'Shotly — whole-page screenshots for Chrome, on-device only',
  description:
    'Shotly captures whole-page screenshots in Chrome, stitches them at full device resolution, and never sends anything off your machine.',
  body: `<p class="eyebrow">Chrome extension</p>
<h1>Shotly</h1>
<p class="lede">Whole-page screenshots for Chrome — stitched at full device resolution, exported as PNG / JPG / PDF, and never uploaded anywhere.</p>

<div class="cta">
  <a class="btn primary" href="${REPO}">View source on GitHub</a>
  <a class="btn" href="./support.html">Support</a>
  <a class="btn" href="./privacy.html">Privacy policy</a>
</div>

<div class="cards">
  <div class="card">
    <h3>Retina-correct</h3>
    <p>The stitch canvas is sized in <strong>device</strong> pixels, so a 1280&nbsp;px page on a 2× display exports a 2560&nbsp;px image — never a downsampled one.</p>
  </div>
  <div class="card">
    <h3>Private by construction</h3>
    <p>No accounts, no telemetry, no third-party requests. Screenshots live in your browser's IndexedDB and nowhere else.</p>
  </div>
  <div class="card">
    <h3>Handles the hard pages</h3>
    <p>Lazy images, fixed headers, cross-origin embeds, web fonts and 50&nbsp;000&nbsp;px documents — all covered by five verified scenarios.</p>
  </div>
</div>

<h2>What it does</h2>
<ul>
  <li>Whole-page capture with a live progress bar</li>
  <li>Region capture — drag a rectangle, get just that</li>
  <li>Export to PNG, JPG or PDF (and copy straight to the clipboard)</li>
  <li>Local history (50 entries, LRU) so you can re-download yesterday's shot</li>
  <li>Light and dark UI</li>
</ul>

<h2>Install</h2>
<pre><code>git clone ${REPO}.git
cd shotly
pnpm install
pnpm build      # → .output/chrome-mv3
pnpm zip        # → .output/shotly-${VERSION}-chrome.zip</code></pre>
<p>Then load it: <code>chrome://extensions/</code> → enable <strong>Developer mode</strong> → <strong>Load unpacked</strong> → pick <code>shotly/.output/chrome-mv3</code>.</p>

<h2>Permissions, and why</h2>
<table>
  <tr><th>Permission</th><th>Why it is needed</th></tr>
  <tr><td><code>activeTab</code></td><td>Reads the current tab only when you click the extension</td></tr>
  <tr><td><code>scripting</code></td><td>Injects the region-selection overlay on demand</td></tr>
  <tr><td><code>offscreen</code></td><td>Offscreen canvas — an MV3 service worker cannot use the DOM</td></tr>
  <tr><td><code>storage</code></td><td>Your language choice, so it persists between popup opens</td></tr>
  <tr><td><code>downloads</code></td><td>Saves the file you export</td></tr>
  <tr><td><code>clipboardWrite</code></td><td>Copy-to-clipboard</td></tr>
  <tr><td><code>unlimitedStorage</code></td><td>The 50-entry history exceeds the default quota</td></tr>
  <tr><td><code>tabs</code></td><td>Reads the current tab's title and URL for the local history entry</td></tr>
  <tr><td><code>&lt;all_urls&gt;</code></td><td>A screenshot tool has to be able to reach any page you ask it to</td></tr>
</table>

<footer>
  <p>Source: <a href="${REPO}">${REPO}</a> · <a href="./support.html">Support</a> · <a href="./privacy.html">Privacy policy</a> · v${VERSION}</p>
</footer>`,
});
writeFileSync(resolve(outDir, 'index.html'), index);

// ─── privacy.html ────────────────────────────────────────────────────────────
const privacyMd = readFileSync(resolve(root, 'PRIVACY.md'), 'utf8');
const privacyBody = markdownToHtml(privacyMd);
writeFileSync(
  resolve(outDir, 'privacy.html'),
  page({
    title: 'Shotly — Privacy Policy',
    description: 'Shotly never uploads your screenshots. Everything stays on your device.',
    body: privacyBody,
  }),
);

// ─── support.html ────────────────────────────────────────────────────────────
//
// CWS 的「Support URL」是**必填项**。之前站点只有 index + privacy，
// 提审时这一栏没东西可填。
//
// 联系渠道选 GitHub Issues（不是邮箱）：域名 getshotly.com 还没注册，
// 写上去的邮箱是死地址 —— 审核员点进去发现邮箱不能用会直接退审。
// GitHub 仓库是公开的且开了 Issues，链接当场可验证。
const support = page({
  title: 'Shotly — Support',
  description: 'Get help with Shotly, report a bug, or ask a question.',
  body: `<p class="eyebrow">Shotly</p>
<h1>Support</h1>
<p class="lede">遇到问题、想报 bug、或者有疑问 —— 都在 GitHub Issues 里提。</p>

<div class="cta">
  <a class="btn primary" href="${REPO}/issues">Open an issue on GitHub</a>
  <a class="btn" href="${REPO}">Source code</a>
</div>

<h2>提 issue 之前</h2>
<p>先看一眼 <a href="${REPO}/issues">已有的 issue</a> —— 很多问题已经被提过并解决了。
搜一下关键词可能更快。</p>

<h2>报 bug 请附上这些</h2>
<ul>
  <li>你的 Chrome 版本（<code>chrome://version</code> 里能看到）</li>
  <li>Shotly 版本（扩展详情页左上角）</li>
  <li>出问题的网址</li>
  <li>截图 —— 如果是页面显示不对，直接把出问题的画面截下来</li>
  <li>复现步骤：做了什么操作、期望看到什么、实际看到什么</li>
</ul>

<h2>常见问题</h2>

<h3>整页截图在某些网站上不完整</h3>
<p>先看是不是页面太长了。Shotly 的上限是 <code>min(50 000, ⌊65 535 / DPR⌋)</code> CSS 像素
（页面上会有提示）。另一个常见原因是页面上有 <code>position: fixed</code> 的悬浮元素
（吸顶导航、悬浮按钮），它们在拼接时会重复出现 —— 这是已知限制。</p>

<h3>区域截图选不了某些区域</h3>
<p>最小 100×100 像素。另外如果选区框在 iframe 内部，浏览器不允许跨 iframe 操作，
这是浏览器的限制。</p>

<h3>截图没出现在历史列表里</h3>
<p>历史库最多存 50 条，超出自动淘汰最旧的。如果刚截图完就找不见，
先看看是不是之前已经存了 50 条。</p>

<h3>PDF 导出打不开</h3>
<p>请把问题连同导出的 PDF 一起作为 issue 附件上传。</p>

<h3>怎么确认它真的不上传截图</h3>
<p>Chrome 开发者工具 → Network 面板，跑一次截图，看有没有任何第三方请求。
Shotly 的测试套件里就有一条 E2E 专门做这件事（跑完整截图流程并拦截所有请求）。
源码在 <a href="${REPO}">${REPO}</a>。</p>

<h2>其他</h2>
<ul>
  <li>隐私相关：见 <a href="./privacy.html">隐私政策</a></li>
  <li>功能请求：直接开 issue，标上 <code>feature request</code></li>
</ul>

<footer>
  <p>Source: <a href="${REPO}">${REPO}</a> · <a href="./privacy.html">Privacy policy</a> · <a href="./support.html">Support</a> · v${VERSION}</p>
</footer>`,
});
writeFileSync(resolve(outDir, 'support.html'), support);

console.log(`pages written to ${outDir}`);
console.log('  index.html');
console.log('  privacy.html');
console.log('  support.html');
console.log('  styles.css');
