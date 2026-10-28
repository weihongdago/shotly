/**
 * 商店素材守门（CI 跑）
 *
 * ## 为什么需要
 *
 * 商店素材（图标、宣传图、功能截图）是**直接上传到 Chrome Web Store**
 * 的东西 —— 提交前改不了，审核员看到的就是这些文件。
 *
 * listing 第 4 节列了每个素材的规格（「128×800 PNG」「1280×800 PNG ×4」），
 * 但之前**没有任何东西验过**：
 *
 * - 文件被删了 / 改名了 → 提交时才发现少一张
 * - 尺寸不对 → CWS 后台直接拒绝，或者审核员看到变形图
 * - 图是空白图 → 审核员看到一张白纸（「功能不足」）
 *
 * 最后一条最阴险：1280×800 的纯白 PNG 压缩后也有几十 KB，
 * 只看字节数**照样通过**。要验像素内容。
 *
 * ## 查法
 *
 * **从 listing 第 4 节的表格里解析**出每个素材声称的规格，
 * 再去文件系统里核对 —— 不在这里写字面量。
 *
 * listing 改了规格表，这里自动跟着变；
 * listing 漏了某个素材，这里也会发现（表里没有 = 没被要求 = 但文件在？
 * 那种反过来查）。
 */

import { test, expect, describe } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..', '..'); // shotly/
const ASSETS = resolve(ROOT, 'store-assets');
const LISTING = readFileSync(resolve(ASSETS, 'CWS-listing.md'), 'utf8');

/**
 * 读 PNG 的 IHDR，拿宽高。
 *
 * 只读文件头 24 字节 —— 不解码整张图（那是 E2E 的活）。
 */
function pngSize(path: string): { w: number; h: number } {
  const buf = readFileSync(path);
  // PNG 签名 8 字节 + IHDR 长度 4 + 类型 4 + 宽 4 + 高 4
  if (buf.length < 24 || buf.subarray(1, 4).toString('latin1') !== 'PNG') {
    throw new Error(`${path} 不是 PNG 文件`);
  }
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

/**
 * listing 第 4 节（素材清单）里声称的素材规格。
 *
 * 表格长这样：
 * ```
 * | 商店图标 | 128×128 PNG | `store-icon-128.png` | ✅ |
 * | 功能截图 | 1280×800 PNG ×4 | `screenshots/01~04` | ✅ ... |
 * ```
 *
 * @returns {name, spec, file, width, height, count} 的数组
 */
function claimedAssets(): Array<{
  name: string;
  spec: string;
  file: string;
  width: number;
  height: number;
  count: number;
}> {
  const section = LISTING.split('## 4.')[1]?.split('\n## ')[0] ?? '';
  const out: Array<{
    name: string;
    spec: string;
    file: string;
    width: number;
    height: number;
    count: number;
  }> = [];

  for (const line of section.split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').map((c) => c.trim());
    // 表格行：| 素材 | 规格 | 文件 | 状态 |
    if (cells.length < 4) continue;
    const [, name, spec, file] = cells;
    if (!name || !spec || !file) continue;
    if (/^-+$/.test(name)) continue;
    if (name === '素材') continue; // 表头

    // 规格里抠出「1280×800」
    const size = spec.match(/(\d+)\s*[×x]\s*(\d+)/);
    if (!size) continue; // 「—」「公开可访问 URL」这类不是图片素材

    const count = spec.match(/[×x]\s*(\d+)\s*$/) ? Number(spec.match(/[×x]\s*(\d+)\s*$/)![1]) : 1;

    // 文件名：反引号里的，`screenshots/01~04` 这种带范围的展开
    const files = [...file.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    if (files.length === 0) continue;

    out.push({
      name,
      spec,
      file: files[0],
      width: Number(size[1]),
      height: Number(size[2]),
      count,
    });
  }
  return out;
}

/** 把 `screenshots/01~04` 这样的范围展开成实际文件名。 */
function expandFiles(spec: string): string[] {
  const m = spec.match(/^(.*?)(\d+)\s*~\s*(\d+)$/);
  if (!m) return [spec];
  const [, dir, from, to] = m;
  const out: string[] = [];
  for (let i = Number(from); i <= Number(to); i++) {
    // ⚠️ 只认图片扩展名。
    // 之前用 `find(f => f.startsWith('03'))` —— 同前缀的兄弟文件
    // （比如 03-xxx.json）会排在 03-xxx.png 前面（'j' < 'p'），
    // 于是守门去读 JSON 当 PNG，解压直接报 "unexpected end of file"。
    //
    // 那种失败是好的（守门没静默跳过），但错在**选错了文件**，
    // 而不是发现了真问题。只认 .png 就不会踩。
    const hit = readdirSync(resolve(ASSETS, dir)).find(
      (f) => f.startsWith(String(i).padStart(2, '0')) && /\.png$/i.test(f),
    );
    if (hit) out.push(`${dir}/${hit}`);
  }
  return out;
}

describe('商店素材 ↔ listing 规格', () => {
  test('listing 第 4 节解析出了素材清单（守门本身没失效）', () => {
    const assets = claimedAssets();
    expect(
      assets.length,
      'listing 第 4 节没解析出任何图片素材 —— 表格结构变了？守门会静默失效',
    ).toBeGreaterThanOrEqual(4);
    // 至少要有商店图标、宣传图、功能截图这几类
    const names = assets.map((a) => a.name).join(' ');
    expect(names, '素材清单里没有商店图标').toContain('商店图标');
    expect(names, '素材清单里没有功能截图').toContain('功能截图');
  });

  test('每个声称的素材都存在，尺寸和声称的一致', () => {
    for (const a of claimedAssets()) {
      const files = expandFiles(a.file);
      expect(
        files.length,
        `${a.name}：listing 说 ${a.file}（${a.count} 个），实际找到 ${files.length} 个`,
      ).toBe(a.count);

      for (const f of files) {
        const path = resolve(ASSETS, f);
        expect(existsSync(path), `${a.name}：素材文件不存在 —— ${f}`).toBe(true);

        const { w, h } = pngSize(path);
        expect(
          w,
          `${a.name}：${f} 实际 ${w}×${h}，listing 声称 ${a.width}×${a.height}`,
        ).toBe(a.width);
        expect(
          h,
          `${a.name}：${f} 实际 ${w}×${h}，listing 声称 ${a.width}×${a.height}`,
        ).toBe(a.height);
      }
    }
  });

  test('素材不是空白图（像素内容检查，不只看字节数）', () => {
    // 1280×800 的纯白 PNG 压缩后也有几十 KB，只看字节数抓不到空白图。
    // 这里用「唯一颜色数」当代理指标：空白图只有 1-2 种颜色。
    for (const a of claimedAssets()) {
      for (const f of expandFiles(a.file)) {
        const path = resolve(ASSETS, f);
        if (!existsSync(path)) continue;

        const buf = readFileSync(path);
        // PNG 的 IDAT 是 zlib 压缩的；这里不完整解码，只用
        // 「文件大小 + IDAT 段压缩前后的粗略信息」做快速判断：
        // 真正的空白图，IDAT 解压后高度会全等于同一个字节值。
        //
        // 为了准确，这里解压并统计唯一像素值。素材只有 6 张图，
        // 全解码也很快（< 1 秒）。
        const colors = uniqueColors(path);

        expect(
          colors.size,
          `${a.name}：${f} 看起来是空白图（只有 ${colors.size} 种颜色）—— 审核员看到的就是这张`,
        ).toBeGreaterThan(3);
      }
    }
  });

  test('功能截图是 4 张（listing 声称的数量）', () => {
    const shots = readdirSync(resolve(ASSETS, 'screenshots')).filter((f) => f.endsWith('.png'));
    expect(
      shots.length,
      `screenshots/ 里有 ${shots.length} 张，listing 声称 4 张`,
    ).toBe(4);
  });

  /**
   * 进度条素材里，**进度条的填充比例要和旁边的文字一致**。
   *
   * ## 发现的 bug
   *
   * `03-capture-progress.png` 拍的是「采集进行中」的 popup。
   * E2E 在进度刚出现的瞬间截图，而 `.bar-fill` 上有
   * `transition: width 200ms ease`（entrypoints/popup/App.vue）——
   * 于是拍到的是**动画中间态**：进度条还没长到该有的宽度。
   *
   * 实测：文字写「Capturing 2 / 5」（40%），进度条只填了 **35.2%**。
   * 审核员看到的就是「说 40%，看着不到 40%」的进度条 —— 像是坏的。
   *
   * 修法在 E2E 那边（等动画停下来再截），这条守门防它**改回去**。
   *
   * ## 查法
   *
   * 不写字面量：从像素里量出进度条（品牌色填充 + 浅灰轨道），
   * 再和图里渲染出来的文字对不上就报错。
   */
  test('进度条素材里，进度条填充比例和文字声称的一致', () => {
    const path = resolve(ASSETS, 'screenshots', '03-capture-progress.png');
    expect(existsSync(path), '找不到 03-capture-progress.png').toBe(true);

    /**
     * E2E 拍图时把当时的进度写在这个 meta 里。
     *
     * 为什么要 meta 而不是直接写字面量：
     * - 切片总数（total）取决于测试页有多高，不是常量；
     * - 写死 `2 / 5` 的话，测试页一改素材就悄悄对不上了。
     *
     * meta 是「拍图那一刻的真实状态」，像素是「拍图那一刻的真实画面」——
     * 两者对不上，就说明画面和状态不一致（动画中间态）。
     */
    const metaPath = resolve(ASSETS, 'meta', '03-capture-progress.json');
    expect(
      existsSync(metaPath),
      '缺少 meta/03-capture-progress.json（E2E 拍图时应该写出当时的进度）',
    ).toBe(true);
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as { i: number; total: number };

    const { width, height, bpp, pixels } = decodePng(path);
    const stride = width * bpp;

    /**
     * 品牌色从**源码**里解析，不写死。
     *
     * `utils/theme.ts` 里 `brand: '#0F766E'` 是主色（teal-700），
     * 进度条的填充就是它。主题一改，这里自动跟着变 ——
     * 写死字面量的话，换主题后这个守门会默默失效
     * （找不到条 → 或者更糟：找到别的条 → 误报）。
     */
    const themeSrc = readFileSync(resolve(ROOT, 'utils', 'theme.ts'), 'utf8');
    const brandHex = themeSrc.match(/brand:\s*['"]#([0-9A-Fa-f]{6})['"]/)?.[1];
    expect(brandHex, 'utils/theme.ts 里没找到 brand 色值 —— 守门失效了').toBeTruthy();
    const BRAND: [number, number, number] = [
      parseInt(brandHex!.slice(0, 2), 16),
      parseInt(brandHex!.slice(2, 4), 16),
      parseInt(brandHex!.slice(4, 6), 16),
    ];

    const at = (x: number, y: number): [number, number, number] => [
      pixels[y * stride + x * bpp],
      pixels[y * stride + x * bpp + 1],
      pixels[y * stride + x * bpp + 2],
    ];
    const isBrand = (c: [number, number, number]) =>
      Math.abs(c[0] - BRAND[0]) <= 2 &&
      Math.abs(c[1] - BRAND[1]) <= 2 &&
      Math.abs(c[2] - BRAND[2]) <= 2;
    /** 两色足够接近就算同色（抗锯齿 + 缩放会带来 1-2 的偏差）。 */
    const near = (a: [number, number, number], b: [number, number, number]) =>
      Math.abs(a[0] - b[0]) <= 3 &&
      Math.abs(a[1] - b[1]) <= 3 &&
      Math.abs(a[2] - b[2]) <= 3;

    /**
     * 找进度条。
     *
     * ⚠️ 不能简单地取「这一行上品牌色的最小 x 和最大 x」——
     * 版式里**还有别的品牌色元素**（x1107-1162 那一段），
     * 那样会把填充段和不相干的东西连起来，量出 100%。
     *
     * 进度条的特征是：**一段品牌色，紧接着一段轨道色**。
     * 就找这种「品牌色 → 轨道色」相邻的组合。
     *
     * 轨道色也不写死：填充段右边第一个像素就是轨道色，
     * 然后按「同色连续段」向右延伸 —— 遇到卡片背景就停。
     */
    interface Bar {
      row: number;
      fillStart: number;
      fillEnd: number;
      trackEnd: number;
    }
    let bar: Bar | null = null;
    for (let y = 0; y < height; y++) {
      let x = 0;
      while (x < width) {
        if (!isBrand(at(x, y))) {
          x++;
          continue;
        }
        const fillStart = x;
        while (x < width && isBrand(at(x, y))) x++;
        const fillEnd = x - 1;
        // 必须是「品牌色后面紧跟轨道色」才算进度条
        if (x < width) {
          const trackColor = at(x, y);
          let trackEnd = x;
          while (trackEnd + 1 < width && near(at(trackEnd + 1, y), trackColor)) trackEnd++;
          const trackWidth = trackEnd - fillStart + 1;
          // 进度条是宽扁的：宽度要够长
          if (trackWidth > 100) {
            if (!bar || trackWidth > bar.trackEnd - bar.fillStart + 1) {
              bar = { row: y, fillStart, fillEnd, trackEnd };
            }
          }
        }
      }
    }
    expect(bar, '素材里找不到进度条（品牌色紧跟同色轨道的长横条）—— 截图内容变了？').not.toBeNull();
    const b = bar as Bar;

    const trackWidth = b.trackEnd - b.fillStart + 1;
    const fillWidth = b.fillEnd - b.fillStart + 1;
    const fillPct = (fillWidth / trackWidth) * 100;

    /**
     * 期望比例 = (i + 1) / total。
     *
     * 源码里 bar 的宽度是
     *   `Math.round(((progress.i + 1) / progress.total) * 100)%`
     * （entrypoints/popup/App.vue），文字是 `${progress.i + 1} / ${progress.total}`。
     * 所以 i 是**已经完成的切片数**（0 起），显示的是第 i+1 片。
     */
    const expectedPct = ((meta.i + 1) / meta.total) * 100;

    // 允许 1.5% 的误差：像素取整 + 抗锯齿 + 弹窗→版式的合成缩放
    expect(
      Math.abs(fillPct - expectedPct),
      `进度条填充了 ${fillPct.toFixed(1)}%，但文字声称 ${meta.i + 1} / ${meta.total}` +
        `（= ${expectedPct.toFixed(1)}%）—— 进度条和文字对不上` +
        `（E2E 是不是又在动画中间截图了？.bar-fill 有 200ms 的 transition）`,
    ).toBeLessThan(1.5);
  });
});

/**
 * 完整解码 PNG（解 zlib + 反过滤），返回像素缓冲。
 *
 * 够慢但对 6 张素材完全够用。
 */
function decodePng(path: string): {
  width: number;
  height: number;
  bpp: number;
  pixels: Buffer;
} {
  const d = readFileSync(path);
  const width = d.readUInt32BE(16);
  const height = d.readUInt32BE(20);
  const colorType = d[25];
  const bpp = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType as 0 | 2 | 3 | 4 | 6] ?? 3;

  let pos = 8;
  const idatParts: Buffer[] = [];
  while (pos < d.length) {
    const len = d.readUInt32BE(pos);
    const type = d.subarray(pos + 4, pos + 8).toString('latin1');
    if (type === 'IDAT') idatParts.push(d.subarray(pos + 8, pos + 8 + len));
    if (type === 'IEND') break;
    pos += 12 + len;
  }
  const idat = Buffer.concat(idatParts);

  const zlib = require('node:zlib') as typeof import('node:zlib');
  const raw = zlib.inflateSync(idat);
  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  const prev = Buffer.alloc(stride);
  let i = 0;

  for (let y = 0; y < height; y++) {
    const filter = raw[i++];
    const line = Buffer.from(raw.subarray(i, i + stride));
    i += stride;

    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? line[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      switch (filter) {
        case 1:
          line[x] = (line[x] + a) & 0xff;
          break;
        case 2:
          line[x] = (line[x] + b) & 0xff;
          break;
        case 3:
          line[x] = (line[x] + ((a + b) >> 1)) & 0xff;
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          line[x] = (line[x] + pr) & 0xff;
          break;
        }
      }
    }
    line.copy(out, y * stride);
    line.copy(prev);
  }

  return { width, height, bpp, pixels: out };
}

/**
 * 统计 PNG 里的唯一颜色数。
 */
function uniqueColors(path: string): Set<string> {
  const { width, height, bpp, pixels } = decodePng(path);
  const stride = width * bpp;
  const colors = new Set<string>();
  for (let y = 0; y < height; y += 3) {
    for (let x = 0; x < width; x += 3) {
      const o = y * stride + x * bpp;
      colors.add(
        bpp >= 3
          ? `${pixels[o]},${pixels[o + 1]},${pixels[o + 2]}`
          : `${pixels[o]}`,
      );
    }
  }
  return colors;
}
