#!/usr/bin/env node
/**
 * 守门：仓库里所有 Markdown 的相对链接必须能解析。
 *
 * 为什么需要（2026-11-10 发现）：
 *   `docs/test-plan-v1.md` 和 `docs/ui-style-guide-v1.md` 都链接到 `./PRD-v1.md`，
 *   但 PRD 是**内部文档**（含竞品分析与定价策略），**故意没有**放进这个公开仓库。
 *   ⇒ GitHub 上点进去就是 404。
 *
 *   这类死链 CI 不会报 —— Markdown 链接不校验，仓库里也没有链接检查器。
 *   而「配套文档」是读者（贡献者、审核员）最先点的东西。
 *
 * 判据：
 *   - 相对链接（`./x` / `x` / `../x`）对应的文件必须存在
 *   - 锚点链接（`#xxx`）、外链（http/https/mailto）不检查
 *   - 图片也一起查（`![](...)`）
 *
 * 退出码：0 = 全部存活；1 = 有死链（硬失败）
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'dist-pages', '.output', '.wxt', 'coverage', 'e2e', 'poc-d3']);

// ── 收集所有 .md 文件 ───────────────────────────────────────────────────
function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.github') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, out);
    } else if (entry.name.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

// ── 提取链接 ───────────────────────────────────────────────────────────
// 匹配 Markdown 链接与图片： [text](target) 或 [text](target "title")
const LINK_RE = /!?\[[^\]]*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g;

function isExternal(target) {
  return /^(https?:|mailto:|tel:|data:|#)/i.test(target);
}

const mdFiles = walk(repoRoot);
const dead = [];
let checked = 0;

for (const file of mdFiles) {
  const src = readFileSync(file, 'utf8');
  const dir = dirname(file);
  for (const m of src.matchAll(LINK_RE)) {
    const target = m[1];
    if (isExternal(target)) continue;

    // 去掉锚点部分：file.md#section → file.md
    const clean = decodeURIComponent(target.split('#')[0]);
    if (!clean) continue;

    // 目录链接：末尾斜杠 → 补 index.md / README.md
    let resolved = resolve(dir, clean);
    checked++;

    if (existsSync(resolved)) {
      // 是目录 → 看有没有可读的入口文件
      if (statSync(resolved).isDirectory()) {
        const hasEntry = ['index.md', 'README.md'].some((f) => existsSync(join(resolved, f)));
        if (!hasEntry) {
          dead.push({ file: relative(repoRoot, file), target, why: '目录里没有 index.md / README.md' });
        }
      }
      continue;
    }

    // 试着补常见扩展名（链接可能省略 .md）
    const withExt = extname(resolved) ? resolved : resolved + '.md';
    if (existsSync(withExt)) continue;

    dead.push({ file: relative(repoRoot, file), target, why: '目标文件不存在' });
  }
}

console.log(`检查了 ${mdFiles.length} 个 Markdown 文件、${checked} 条相对链接`);
if (dead.length === 0) {
  console.log('✅ 所有相对链接都能解析');
  process.exit(0);
}

console.error('\n❌ 有死链：\n');
for (const d of dead) {
  console.error(`   • ${d.file} → ${d.target}\n     ${d.why}`);
}
console.error('\n   修法：');
console.error('     · 内部文档不要在公开仓库里做链接 —— 改成纯文本 + 一句说明');
console.error('     · 确实要公开的，就把文件放进仓库');
process.exit(1);
