/**
 * Publish the built site to the `gh-pages` branch and enable GitHub Pages.
 *
 * The Chrome Web Store needs a publicly reachable privacy policy URL.
 * getshotly.com is not registered yet, so GitHub Pages stands in.
 *
 * ⚠️ Every git command that touches the branch must run INSIDE the
 * throwaway worktree. The first version of this script ran them in the
 * main checkout (shared `cwd`) and left the main branch switched to an
 * orphan branch with node_modules staged — hence the explicit `gitIn`.
 *
 * Usage: node tools/build-pages.mjs && node tools/publish-pages.mjs
 */

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const outDir = resolve(root, 'dist-pages');
const branch = 'gh-pages';

if (!existsSync(resolve(outDir, 'index.html'))) {
  console.error('dist-pages/ is empty — run `node tools/build-pages.mjs` first.');
  process.exit(1);
}

// ─── proxy detection ─────────────────────────────────────────────────────────
//
// ⚠️ git/curl **不读** macOS 的系统代理设置（只有浏览器和大部分 App 读）。
//    所以「系统代理开着」≠「命令行走得通」—— `git push` 会卡 75 秒然后
//    报 Failed to connect to github.com port 443。
//
//    这里主动读 scutil，把系统代理显式传给 git。
function proxyArgs() {
  if (process.platform !== 'darwin') return [];
  try {
    const out = execFileSync('scutil', ['--proxy'], { encoding: 'utf8' });
    const port = /HTTPSPort\s*:\s*(\d+)/.exec(out)?.[1];
    if (!port) return [];
    const host = /HTTPSProxy\s*:\s*(\S+)/.exec(out)?.[1] || '127.0.0.1';
    // 只有真的在监听才用（代理 App 可能没开）
    try {
      execFileSync('nc', ['-z', host, port], { stdio: 'ignore' });
    } catch {
      return [];
    }
    const proxy = `http://${host}:${port}`;
    console.log(`→ using system proxy ${proxy} for git`);
    return ['-c', `http.proxy=${proxy}`, '-c', `https.proxy=${proxy}`];
  } catch {
    return [];
  }
}

// ⚠️ `-c` 必须排在**子命令前面**：`git -c http.proxy=… push …`。
//    所以代理参数统一由这两个 helper 注入，调用处不用操心顺序。
const proxy = proxyArgs();

const git = (...args) =>
  execFileSync('git', [...proxy, ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

/** Same, but inside the throwaway worktree. */
const gitIn = (cwd, ...args) =>
  execFileSync('git', [...proxy, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

// ─── 1. worktree for the pages branch ────────────────────────────────────────
//
// 上一次运行如果中途报错，worktree 会残留并**占住 gh-pages 分支**——
// 下次 `git worktree add -B gh-pages` 会报
// "cannot force update the branch 'gh-pages' used by worktree at ..."。
// 所以开跑前先清掉本脚本留下的残留 worktree。
try {
  const listed = execFileSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: root,
    encoding: 'utf8',
  });
  for (const line of listed.split('\n')) {
    const m = /^worktree (.+)$/.exec(line);
    if (!m) continue;
    const p = m[1];
    if (!p.includes('shotly-pages-')) continue;
    try {
      execFileSync('git', ['worktree', 'remove', '--force', p], {
        cwd: root,
        stdio: 'ignore',
      });
      console.log(`→ removed stale worktree ${p}`);
    } catch {
      /* already gone */
    }
  }
  execFileSync('git', ['worktree', 'prune'], { cwd: root, stdio: 'ignore' });
} catch {
  /* worktree list failed — continue and let the add below report */
}

const wt = resolve(tmpdir(), `shotly-pages-${Date.now()}`);
mkdirSync(wt, { recursive: true });

// ⚠️ 必须先 fetch，并且**基于远端分支**建 worktree。
//
//    旧版本用的是本地分支，而且「要不要发布」是拿 worktree 的 status
//    跟**本地**分支比。两个问题叠加：
//      1. 上一次 push 失败（网络）时，本地分支已经提交了，远端还没有
//      2. 下一次跑，status 相对本地分支是干净的 → 判定「nothing to publish」
//         → **永远不 push**，远端就一直停在旧内容
//
//    这就是「静默跳过比硬失败危险」的又一个实例：脚本打印 "done"，
//    但站点上根本没有新内容。
//
//    现在：先 fetch，基于 origin/gh-pages 建 worktree，
//    「有没有变化」也比远端。
try {
  git('fetch', 'origin', branch);
} catch (err) {
  console.warn(`fetch origin/${branch} 失败（分支可能还不存在）：${String(err.stderr || '').trim()}`);
}

const remoteExists = (() => {
  try {
    git('rev-parse', '--verify', `refs/remotes/origin/${branch}`);
    return true;
  } catch {
    return false;
  }
})();

if (remoteExists) {
  // 基于**远端**分支建 worktree（而不是本地分支）——本地可能比远端旧
  // （别人推过）或比远端新（上次 push 失败）。
  git('worktree', 'add', '--force', '-B', branch, wt, `origin/${branch}`);
} else {
  git('worktree', 'add', '--detach', wt);
  gitIn(wt, 'checkout', '--orphan', branch);
  // Empty the INDEX but keep the files on disk — `git rm -rf .` would
  // delete .gitignore too, and then `git add --all` would happily stage
  // node_modules (1.1M files, 40MB) into the pages branch.
  gitIn(wt, 'rm', '-rf', '--cached', '--quiet', '.');
  // Drop everything from the working tree except .git.
  for (const entry of readdirSync(wt)) {
    if (entry === '.git') continue;
    rmSync(resolve(wt, entry), { recursive: true, force: true });
  }
}

cpSync(outDir, wt, { recursive: true });

// ─── 2. commit + push ────────────────────────────────────────────────────────
gitIn(wt, 'add', '--all');
const status = gitIn(wt, 'status', '--porcelain');
if (status.trim() === '') {
  console.log('内容与远端一致 — 无需重新发布');
} else {
  gitIn(
    wt,
    'commit',
    '--quiet',
    '-m',
    'docs: 更新公开站点（首页 / 隐私政策 / 支持页）\n\n由 tools/build-pages.mjs 生成，勿手改。',
  );
  console.log(`committed ${branch}`);
}

// ⚠️ push 放在 if 外面 —— 即使工作区没变化也要确认远端拿到的是最新内容。
//    上个版本把 push 放在 else 里，于是「push 失败过一次」就变成永久不发。
gitIn(wt, 'push', '--force', 'origin', branch);
console.log(`pushed ${branch}`);

// ─── 3. enable GitHub Pages ──────────────────────────────────────────────────
try {
  execFileSync(
    'gh',
    [
      'api',
      '--method',
      'POST',
      'repos/weihongdago/shotly/pages',
      '-f',
      'source[branch]=gh-pages',
      '-f',
      'source[path]=/',
    ],
    { encoding: 'utf8' },
  );
  console.log('GitHub Pages enabled (source: gh-pages /)');
} catch (err) {
  const msg = String(err.stderr || err.stdout || err.message);
  if (msg.includes('already exists') || msg.includes('409') || msg.includes('422')) {
    console.log('GitHub Pages already enabled');
  } else {
    console.error('could not enable Pages:', msg.trim());
  }
}

// ─── 4. cleanup ──────────────────────────────────────────────────────────────
try {
  git('worktree', 'remove', '--force', wt);
} catch {
  /* worktree may already be gone */
}
rmSync(wt, { recursive: true, force: true });

console.log('done — https://weihongdago.github.io/shotly/');
