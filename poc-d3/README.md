# D+3 PoC 验证脚本（开发交付包）

> **版本**：D+4 修订 (2026-10-27) · **作者**：开发工程师 👨‍💻
> **用途**：测试工程师在真实 Chrome 上跑的 5 项 PoC 场景
> **配套**：[architecture.md §3.6](../../architecture.md) / [test-plan-v1.md §11](../../test-plan-v1.md)

## 🎯 目标

按 architecture §3.6 验证截图 pipeline 在真实站点上的表现：

| 维度 | 验证点 |
|------|--------|
| **正确性** | 多分段拼接无错位、无重影、无遗漏 |
| **完整性** | fixed/sticky 元素被隐藏、跨域 iframe 占位、懒加载图片就位 |
| **分辨率** | 高 DPR 设备上输出**设备像素**（不是被降采样的 CSS 像素） |
| **性能** | 30_000px 高 DPR 页面在 60s 内完成 |
| **稳定性** | MV3 SW idle-kill 不打断长任务 |
| **UX 边界** | 超长页按 DPR 正确拒绝 + 提示可读 |

## 🔒 隐私红线

**本扩展不做任何埋点、不上报、不上传、不发第三方请求。**

没有 Cloudflare Worker，没有 analytics，没有遥测端点。构建产物里的
`fetch(` 全部是对本地 `blob:` URL 的读取；`pdf-lib` / `vuejs.org` 两个
URL 是库自带的元数据与错误提示链接，不是网络请求。

审查方式：

```bash
cd shotly && pnpm build
grep -rn "fetch(" .output/chrome-mv3/ | grep -v "blob:"   # 应无外部请求
grep -rn "https\?://" .output/chrome-mv3/ | grep -vE "vuejs.org|github.com/Hopding/pdf-lib"  # 应无外部请求
```

## 📦 交付物清单

```
shotly/poc-d3/
├── README.md                    ← 本文件（场景总览 + 跑测流程）
├── expected-results.md          ← 5 场景预期产物清单（PASS 判定标准）
├── scenarios/
│   ├── 01-short-wikipedia.md    ← S1 标准短页 + 标准 DPR
│   ├── 02-long-notion.md        ← S2 超长页 + 高 DPR
│   ├── 03-cross-origin-iframes.md ← S3 跨域 iframe 占位
│   ├── 04-lazy-heavy-images.md  ← S4 懒加载重图页
│   └── 05-extreme-and-dark.md   ← S5 极端边界 + dark mode + web font
└── fixtures/
    ├── 01-wikipedia.html        ← S1 本地静态副本（离线可跑）
    ├── 02-notion-mock.html      ← S2 30_000px 长页
    ├── 03-iframe-mix.html       ← S3 本地 iframe 混合页
    ├── 04-pinterest-mock.html   ← S4 200 张占位图懒加载
    ├── 05-extreme-49k.html      ← S5 49_000px 页（DPR=1 合法上界）
    ├── 05-extreme-50k.html      ← S5 50_000px 页（DPR=1 拒绝 / DPR=2 必然超限）
    ├── 05-dark-mode.html        ← S5 dark mode
    ├── 05-web-font-delay.html   ← S5 延迟加载的 web font
    ├── 05-webfont-latin.woff2   ← S5 web font 本地文件（不外链）
    └── 06-same-origin.html      ← S3 同源 iframe（不应被占位）
```

## 🚀 跑测流程（测试工程师 onboarding）

### 0. 前置（一次性）

```bash
# 拉最新代码 + 装依赖
cd ~/.openclaw/workspace/projects/gofullpage-clone/shotly
git checkout main && git pull
pnpm install

# 构建可测版本
pnpm build
# 产物：.output/chrome-mv3/

# 准备测试基础设施
cd ../test-infra
pnpm install
pnpm exec playwright install chromium
```

### 1. 烟雾测试（5 min）— 验证扩展可装入

```bash
cd test-infra
pnpm test:smoke
# 期望：确认 .output/chrome-mv3 可装入 + 权限无缺失
```

### 2. 5 项 PoC 场景（30 min）— 验证真截图功能

**两种模式**：

#### A. 自动化模式（推荐，环境稳定后用）

```bash
cd test-infra
pnpm test:e2e:poc-d3
# 内部：playwright 加载 .output/chrome-mv3 + 每个 fixture 一个 test
# 报告：reports/poc-d3/poc-d3-report.json + poc-d3-logs.txt
```

断言**全部基于像素**（逐横向带统计非白像素比例），不看 byteSize ——
拼接几何算错时 `drawImage` 静默失败会画出纯白图，而纯白 PNG 仍有
100KB+，只看数字的断言会全部通过。

#### B. 手动模式（PoC 首日，建议先用这个）

1. Chrome → `chrome://extensions/` → 开启"开发者模式"
2. "加载已解压的扩展程序" → 选 `shotly/.output/chrome-mv3`
3. 依次访问 `poc-d3/fixtures/` 下每个 fixture 或真实站点
4. 点击 Shotly 图标 → 「整页截图」
5. 等 popup 显示「✅ 完成 · XX KB · WxHpx」+ 下载按钮
6. 对照 `expected-results.md` 逐项打勾

### 3. 异常上报

发现任何不符合 `expected-results.md` 的行为，截图 + 控制台日志贴到 PM 群：

```
[POC] S2 长页报错
- 场景：notion.so 工作区（实测 28_400px）
- 期望：6 segments @ DPR=2 → ~25s 完成
- 实际：卡在 segment 3 → SW idle-killed @ 30s
- 日志：[shotly:content] port disconnected
- 截图：reports/screenshots/s2-fail-XXX.png
```

## ⚠️ 已知限制（截至 2026-10-27）

1. **A/B 方案切换**：当前只有 A 方案真接通。B 方案（html2canvas 系）仍是 stub（D+4~5 实现）。`capture-fallback.ts` 会在 3 次 A 失败后 throw 而非走 B。
2. **历史库 / 编辑器 / 水印**：未实现，按钮占位。
3. **画布上限受 DPR 影响**：Chrome 单张画布最大 **65_535px**（实测，见
   `test-infra/probe-canvas-limits.mjs`），而拼接画布按**设备像素**创建。
   所以页面上限是 `min(50_000, ⌊65_535 / DPR⌋)` CSS px：DPR=1 → 50_000，
   DPR=2 → 32_767。DPR=1 下的 50_000px 页在 Retina 上会被**提前拒绝**，
   提示里会写明原因。

## 📐 已验证的关键事实（D+4 实测，非推测）

| 事实 | 证据 |
|------|------|
| `chrome.tabs.captureVisibleTab` 抓的是**窗口 widget 的光栅**，不是渲染层的 DPR | Playwright `deviceScaleFactor: 2` 单独设置时抓回仍是 1280px 宽；加 `--force-device-scale-factor=2` 后才是 2560px（`test-infra/probe-dpr-capture.mjs`） |
| 画布上限是**尺寸** 65_535px，不是面积 | `2560×60_000` 成功、`2560×70_000` 失败、`1920×80_000` 失败（面积与前者相同）；报错 `IndexSizeError … The size of "OffscreenCanvas" is zero.` |
| 设备比例由 **content script 统一解析**（`resolveDeviceScale`），拼接端只管用 | 拼接端若自己从位图反推，浏览器 widget 超出布局视口时（实测 2564×1678 位图 vs 1280×800 视口）Y 轴会多算 ~5% → 整图纵向拉伸 + 底部多出 ~2_900px 白边（S2 实测 `outputHeight 62_926` vs 应为 60_000） |
| 跨域 iframe 必须按 **URL origin** 判定 | 未加载完的跨域 iframe 仍暴露 `about:blank`，`contentDocument` 访问**成功** → 旧实现把它当同源 → 截图里留下空洞且零报错 |

## 🔧 调试快捷方式

```bash
# 实时看 SW 日志
cd shotly && pnpm dev
# 另开一个 Chrome: chrome://extensions/ → Service Worker → "检查视图"

# 单元测试
pnpm test          # 152 个用例
pnpm test:watch    # TDD 模式

# 类型检查
pnpm typecheck     # vue-tsc --noEmit
```

---

**下一步**：测试工程师跑 5 场景自动化回归 + 人工抽检；开发按
`expected-results.md` 逐条核对，缺陷回流到 D+4 修复队列。
