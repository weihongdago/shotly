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

const git = (...args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** Same, but inside the throwaway worktree. */
const gitIn = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// ─── 1. worktree for the pages branch ────────────────────────────────────────
const wt = resolve(tmpdir(), `shotly-pages-${Date.now()}`);
mkdirSync(wt, { recursive: true });

const branchExists = (() => {
  try {
    git('rev-parse', '--verify', `refs/heads/${branch}`);
    return true;
  } catch {
    return false;
  }
})();

if (branchExists) {
  git('worktree', 'add', '--force', wt, branch);
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
  console.log('nothing to publish — gh-pages is already up to date');
} else {
  gitIn(
    wt,
    'commit',
    '--quiet',
    '-m',
    'docs: 更新公开站点（隐私政策 + 首页）\n\n由 tools/build-pages.mjs 生成，勿手改。',
  );
  gitIn(wt, 'push', '--force', 'origin', branch);
  console.log(`pushed ${branch}`);
}

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
