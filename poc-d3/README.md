# D+3 PoC 验证脚本（开发交付包）

> **版本**：D+2 提交 (2026-07-12) · **作者**：开发工程师 👨‍💻
> **用途**：明天 13:00 测试工程师在真机 Chrome 跑的 5 项 PoC 场景
> **配套**：[architecture.md §3.6](../architecture.md) / [test-plan-v1.md §11](../test-plan-v1.md)

## 🎯 目标

按 architecture §3.6 验证截图 pipeline 在真实站点上的表现：

| 维度 | 验证点 |
|------|--------|
| **正确性** | 多分段拼接无错位、无重影、无遗漏 |
| **完整性** | fixed/sticky 元素被隐藏、跨域 iframe 占位、懒加载图片就位 |
| **性能** | 30_000px 高 DPR 页面在 60s 内完成 |
| **稳定性** | 计划 A 失败 3 次 → 计划 B 兜底（v1.1 占位） |
| **UX 边界** | 超长页 (>50_000px) 正确拒绝 + 提示 |

## 📦 交付物清单

```
shotly/poc-d3/
├── README.md                    ← 本文件（场景总览 + 跑测流程）
├── scenarios/
│   ├── 01-short-wikipedia.md    ← S1 标准短页 + 标准 DPR
│   ├── 02-long-notion.md        ← S2 超长页 + 高 DPR
│   ├── 03-cross-origin-iframes.md ← S3 跨域 iframe 占位
│   ├── 04-lazy-heavy-images.md  ← S4 懒加载重图页
│   └── 05-extreme-and-dark.md   ← S5 极端边界 + dark mode + web font
├── fixtures/
│   ├── 01-wikipedia.html        ← S1 本地静态副本（离线可跑）
│   ├── 03-iframe-mix.html       ← S3 本地 5 iframe 混合页
│   ├── 04-pinterest-mock.html   ← S4 200 张占位图懒加载
│   └── 05-extreme-50k.html      ← S5 50_000px 极端页 + dark mode
└── expected-results.md          ← 5 场景预期产物清单（PASS 判定标准）
```

## 🚀 跑测流程（测试工程师 onboarding）

### 0. 前置（一次性）

```bash
# 拉最新代码 + 装依赖
cd ~/.openclaw/workspace/projects/gofullpage-clone/shotly
git checkout main && git pull
pnpm install

# 构建可测版本（D+2 已构建）
pnpm build
# 产物：.output/chrome-mv3/

# 准备测试基础设施
cd ../test-infra
pnpm install
pnpm exec playwright install chrome
```

### 1. 烟雾测试（5 min）— 验证扩展可装入

```bash
cd test-infra
pnpm test:smoke
# 期望：4/4 通过，确认 .output/chrome-mv3 可装入 + 8 项权限无缺失
```

### 2. 5 项 PoC 场景（30 min）— 验证真截图功能

**两种模式**：

#### A. 自动化模式（推荐，环境稳定后用）

```bash
cd test-infra
pnpm test:e2e:poc-d3
# 内部：playwright 加载 .output/chrome-mv3 + 每个 fixture 一个 test
# 报告：reports/poc-d3-YYYYMMDD-HHMMSS/
```

#### B. 手动模式（PoC 首日，建议先用这个）

1. Chrome → `chrome://extensions/` → 开启"开发者模式"
2. "加载已解压的扩展程序" → 选 `shotly/.output/chrome-mv3`
3. 依次访问 `poc-d3/scenarios/` 下每个 fixture 或真实站点
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

## ⚠️ 已知限制（D+2 截止时）

1. **A/B 方案切换**：当前只有 A 方案真接通。B 方案（html2canvas 系）仍是 stub（D+4~5 实现）。`capture-fallback.ts` 会在 3 次 A 失败后 throw 而非走 B — D+3 PoC 不应触发 fallback。
2. **复制到剪贴板**：popup「下载」按钮可用，「复制」按钮 v1.1。
3. **区域截图**：按钮占位，无功能（v1.1）。
4. **历史库 / 编辑器 / 水印**：未实现，按钮占位。

## 📊 数据回传（自动埋点已就绪）

每次截图会触发以下事件（Cloudflare Worker 接收，无 PII）：

| 事件 | 触发时机 | payload |
|------|----------|---------|
| `screenshot.full.start` | popup 点击 | `{ tabId, viewportW, viewportH }` |
| `screenshot.full.chunk` | 每段完成 | `{ index, total, capturedMs }` |
| `screenshot.full.retry` | A 失败 | `{ attempt, reason }` |
| `screenshot.full.fallback_b` | 走 B | `{ mode }` |
| `screenshot.full.fail` | 全失败 | `{ reason }` |
| `screenshot.full.done` | 完成 | `{ durationMs, method, byteSize, w, h }` |

D+3 PoC 数据会回传到 Cloudflare Worker dashboard（架构 §5.5）。

## 🔧 调试快捷方式

```bash
# 实时看 SW 日志
cd shotly && pnpm dev
# 另开一个 Chrome: chrome://extensions/ → Service Worker → "检查视图"

# 单元测试
pnpm test          # 68 个用例
pnpm test:watch    # TDD 模式

# 类型检查
pnpm typecheck     # vue-tsc --noEmit
```

---

**下一步**：测试工程师 D+3 13:00 跑测，14:00 前回报结果。开发 D+3 起处理 PoC 暴露的缺陷。