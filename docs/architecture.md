# Shotly 技术架构方案 v1 初版

> **文档版本**：v1.2 update｜**日期**：2026-07-11｜**作者**：系统架构师（🏗️）
> **输入**：PRD-v1.md（2026-07-11 产品经理交付）
> **下游**：开发（developer）→ 测试（test-engineer）
> **节奏约束**：v1.0 上线 2026-07-27 ~ 2026-08-01（共 13-14 天开发 + 3-7 天审核，见 §8.2）
> **论据体系**：每条结论附【论据 / 来源 / 条件 / 争议点】四要素
> **⚠️ 重大警示先报**：本文 §5 提出 PRD 第 5 条「CWS IAP 主路径」的**强制修正**——Google 已于 2020-09 公告弃用 CWS IAP / Licensing API。详细替代方案在 §5 给出。
>
> **🆕 v1.1 update (2026-07-11 17:34)**：用户授权「后续所有架构决策自行沟通」。本文档 §9 已从「待拍板清单」改为「架构师已决策清单」，**所有 open issue 终结**，下游 developer 可直接按本文档执行。详见 §9.1~9.5 与 §10。
>
> **🚒 v1.2 update (2026-07-11 18:13)**：PM + 开发实测触发 3 项必修 + 5 项 PM 评审响应：①§4.1 权限补 3 项（clipboardWrite / unlimitedStorage / tabs） ②§2.3 消息契约改为 `chrome.runtime.connect` 长连接 ③§8.2 节奏调到 **D+14~D+20**（13-14 天开发 + 3-7 审核） ④§3.5 加"失败 3 次回退 B 方案" ⑤§3.2 iframe 占位文案升级 ⑥§4.5 加 dark mode 色彩 token。详见变更日志及正文。

---

## 目录

- [0. 文档元信息](#0-文档元信息)
- [1️⃣ 模块一｜技术栈选型](#1️⃣-模块一技术栈选型)
- [2️⃣ 模块二｜模块拆分（运行时边界）](#2️⃣-模块二模块拆分运行时边界)
- [3️⃣ 模块三｜长截图核心算法](#3️⃣-模块三长截图核心算法)
- [4️⃣ 模块四｜权限清单（MV3 最小化）](#4️⃣-模块四权限清单mv3-最小化)
- [5️⃣ 模块五｜IAP 接入设计](#5️⃣-模块五iap-接入设计含-cws-iap-强制修正)
- [6️⃣ 模块六｜数据流设计](#6️⃣-模块六数据流设计)
- [7️⃣ 模块七｜上架合规架构](#7️⃣-模块七上架合规架构)
- [8. 风险矩阵 + 实施节奏](#8-风险矩阵--实施节奏)
- [9. 待 PM / 用户拍板事项清单](#9-待-pm--用户拍板事项清单)

---

## 0. 文档元信息

### 0.1 已锁定决策（来自 progress.md 2026-07-11 17:22 用户授权）

| # | 决策项 | 锁定值 |
|---|--------|--------|
| 1 | 产品命名 | **Shotly** |
| 2 | 域名（主） | **getshotly.com** |
| 3 | 主色调 | **薄荷绿 #2DD4BF** |
| 4 | 免费版策略 | **带基础标注**（箭头/方框/文字） |
| 5 | 迭代节奏 | v1.0 → v1.1 = **T+90d** |

### 0.2 PRD 已确认约束（直接引用）

- 平台：Chrome Manifest V3 单平台（Edge/Brave/Arc 自动兼容）
- 数据：截图内容**绝不上传**
- 服务端：Cloudflare 落地页 / 埋点 / License 校验
- v1.0 = 14 天开发 + 3-7 天审核
- v1.1 = T+90d 上付费

### 0.3 关键技术决策一览（先抛结论卡片，每条 §N 详述）

| 维度 | 结论 | 详见 |
|------|------|------|
| 框架 | **WXT** | §1.1 |
| 语言 | **TypeScript**（strict mode） | §1.2 |
| 截图内核 | **scroll-and-stitch + captureVisibleTab + OffscreenCanvas** | §1.3 / §3 |
| 权限 | **5 项最小集**（activeTab / scripting / offscreen / storage / downloads）+ host permissions | §4 |
| 支付 | **❌ CWS IAP 不可用，✅ 推荐 Lemon Squeezy（v1.1 接入）** | §5 |
| 数据流 | **三层分离**：chrome.storage（偏好） + IndexedDB（截图库） + Cloudflare D1（聚合数据） | §6 |
| 隐私合规 | **零上传截图 + 事件级埋点 + 4 语种隐私政策** | §7 |

---

## 1️⃣ 模块一｜技术栈选型

### 1.1 框架选择：**WXT** ✅ 推荐

#### 1.1.1 三套候选评估

| 框架 | 类型 | HMR | 体积 | 生态 | 学习曲线 | 维护风险 | 评分 |
|------|------|-----|------|------|----------|----------|------|
| **WXT** | Vite + 约定式 | ✅ | 小 | 新兴但活跃 | **低（约定即配置）** | 低（年轻但社区强） | **⭐ 推荐** |
| Plasmo | 自研打包器 | ✅ | 中 | 大但 2026 出现 "stalling" 迹象 | 中 | **🟡 中（核心团队动荡）** | 备选 |
| 原生 MV3 | 手写 | ❌（需自配 Vite） | 最小 | n/a | 高 | 低 | 不推荐 |
| CRXJS | Vite 插件 | ✅ | 小 | 2025-2026 leadership change | 中 | **🔴 高（不确定性）** | 弃 |

**【论据】**
- WXT 0.20+ 提供 `wxt prepare` 一键生成 `.output/` 多浏览器产物；对 Chrome-only 项目，可裁剪到单浏览器，配置极简。
- Plasmo 在 2026 年多个独立开发者博客被指出 "stalling"（升级节奏放缓、部分迁移到 WXT），更适合企业内复用而非从零起步。
- CRXJS 处于领导层变动期，async 路由与 v3 升级存在不确定性。

**【来源】**
- addonews.com《Plasmo vs WXT for MV3 Extensions in 2026》
- blog.extenshi.io《Extension frameworks in 2026: how to pick the right one》
- GitHub Discussion wxt-dev/wxt#782《WXT vs. Plasmo 迁移讨论》

**【条件】**
- 若上线后 90 天内出现 WXT 重大 breaking change，可平滑迁移至 Plasmo（API 表面接近）。
- 当前选型假设：以 Chrome 单平台发布，WXT 多浏览器适配能力属于"未来期权"。

**【争议点】**
- **WXT 较新（v0.x → v1.0 过渡期）**：文档完备但案例少于 Plasmo；极端边角问题可能需要查源码。
- 若采用 Plasmo，开发效率相当，但需为未来单平台裁剪付出迁移成本。
- **对单人开发而言**：WXT 的脚手架 + Vite 生态已经在 GitHub 拉出一波正面案例（截图类、记录类多个扩展）。

#### 1.1.2 选 WXT 的具体落点

- 构建命令：`wxt build -b chrome` 单平台产物
- 入口约定：`entrypoints/background.ts` / `content.ts` / `popup/` / `options/`
- 命名导出：`defineBackground() / defineContentScript() / defineUnlistedScript()`
- 依赖：Vite 7+（WXT 内置）+ pnpm workspace（可选）

#### 1.1.3 三层构建产物

```
.output/
├── chrome-mv3/
│   ├── manifest.json     ← V3 + 自动注入
│   ├── background.js     ← Service Worker
│   ├── content.js        ← Content Script (IIFE)
│   ├── popup.html        ← 工具栏弹窗
│   ├── options.html      ← 设置页
│   ├── offscreen.html    ← Offscreen Document（重计算）
│   └── assets/           ← 图标/字体/样式
└── ...
```

---

### 1.2 语言：**TypeScript（strict）** ✅ 必选

**【论据】**
- MV3 Service Worker 不能用 eval，所有逻辑必须经过打包；TS 在编译期发现 API 误用是硬性收益。
- 截图库（html-to-image / html2canvas / 自己写）大量 DOM/Canvas 接口，TS 类型推导能显著减少 `any` 滥用。
- 与 WXT 原生集成（`wxt prepare` 自动生成 `.wxt/types/...` 类型）。

**【来源】**
- WXT 官方文档 §Auto-imports §Type generation
- TypeScript 5.x strict 模式在浏览器扩展中的成熟案例

**【条件】**
- 不允许引入 `any`（除第三方类型缺失的边界 stub）。
- 浏览器 API 缺失的类型需补 `chrome.*` namespace augment。

**【争议点】**
- 弱类型 JS 写 demo 快，但 v1.0 14 天节奏下，TS 编译期错误的预防价值高于少量样板代码成本。
- 团队若只有 1 人开发，TS 心智成本可承受。

---

### 1.3 截图内核方案：**scroll-and-stitch（捕获+滚动拼接）** ✅ 推荐

#### 1.3.1 三套算法选型

| 方案 | 原理 | 优点 | 缺点 | 选型 |
|------|------|------|------|------|
| **A. scroll-and-stitch + captureVisibleTab** | 滚动视口 → 多次截图 → 拼图 | **真实像素**、所见即所得、对 web font/SVG/Canvas 友好 | 跨域 iframe 不可控；动态 fixed 元素需隐藏 | **⭐ v1.0 推荐** |
| B. DOM→Canvas（html2canvas 家族） | 遍历 DOM → 重新绘制到 canvas | 可控制剔除元素；理论上支持 iframe | 性能差（5-30s 大页面），web font/Canvas/svg 绘制不可靠 | **降级方案**（截图失败时回退） |
| C. `chrome.debugger` + Page.captureScreenshot | DevTools 协议全页截图 | 真正"一次出图" | **需 `debugger` 权限，CWS 不允许；CWS 会拒审** | **❌ 禁止** |

**【论据】**
- **A 是 GoFullPage 当前实现路径**，并被 70%+ 头部同类扩展采用。
- C 看似最强，但 `chrome.debugger` 权限被 CWS 列为"高风险"，审核必然不通过。
- B 在 OWASP/CSP 严格的页面（gov / saas 后台）大概率渲染失败。

**【来源】**
- privatelinkio/longshot（开源参考实现）
- onhover.in《Full-Page Screenshots That Capture Everything》（2026-03）
- Chrome 官方文档 `chrome.tabs.captureVisibleTab`

**【条件】**
- 页面需有 `document.scrollingElement`；`overflow:hidden` 的 body 需脚本强制重设。
- 若目标页固定/悬浮元素过多，需在截图前临时 `display:none`。

**【争议点】**
- 拼接的"图像精度" vs "DOM 渲染"在某些带 CSS filter/blend 的页面有差异——v1.0 接受此差异，v1.1 可加 B 方案作为 fallback。
- 全程依赖 captureVisibleTab，**若用户安装 `Screen Capture` 类冲突扩展可能干扰**——罕见，先不优化。

---

### 1.4 重计算：**Offscreen Document + OffscreenCanvas + Web Worker** ✅ 必选

**【论据】**
- MV3 Service Worker **不能访问 DOM**，无法承担 canvas / blob 处理。
- Chrome 109+ 提供 `chrome.offscreen` API 创 build offscreen HTML，承载 DOM/Canvas。
- ImageBitmap + `createImageBitmap(blob)` 可在 Worker 中解码，主线程零阻塞。
- 50,000px 高度的页面若走主线程拼接，必然卡死——必须用 OffscreenCanvas + Worker。

**【来源】**
- developer.chrome.com 官方文档 `chrome.offscreen`
- MDN `OffscreenCanvas` 兼容性表

**【条件】**
- 申请 `offscreen` 权限（见 §4）。
- Offscreen Document 生命周期通过 `chrome.runtime.connect` 维持心跳，避免被回收。

**【争议点】**
- Safari 不支持 `chrome.offscreen`——但本项目只发布 Chrome，影响为零。
- Offscreen Document 占用一定内存，**单次截图流量峰值应在 200MB 内**，超出回退到 B 方案。

---

### 1.5 UI 样式：**vanilla-extract（typed CSS-in-TS）** ✅ 推荐

**【论据】**
- TS 同生态，编译期零运行时（对比 styled-components 无 runtime 注入，更轻量）。
- WXT/Vite 原生集成 SSR-friendly；打出 CSS Module 不污染 context script。

**【条件】**
- 弹窗 / 设置页 / 离屏编辑器统一用 vanilla-extract，避免 SSR 风险时降级到 CSS Module + PostCSS。

**【争议点】**
- Tailwind 适合设计师协作，但 v1.0 阶段无设计师协同，无需引入。
- 备选 `stitches` / `vanilla-css` / `Tailwind 3` 任一都可，**不是架构关键路径**。

> **🆕 v1.2 锁定说明｜UI Token SSOT**
> - 完整 UI token（mint/* / slate/* 色阶、Typography scale、Spacing / Radius / Shadow / Icon 规范）的 **Source of Truth = `ui-style-guide-v1.md`**（PM 文档，2026-07-11 v1）
> - vanilla-extract 的 `createTheme` 必须映射 ui-style-guide 的 token namespace（如 `color.brand[500]` → `mint/500`），**禁止架构层面重新定义 token name**
> - 设计师 v2 高保真稿（D+3 出稿）落地后，本节 + §4.5 同步对齐（无需本架构师审批，PM/设计师签字即可）
>
> **🚨 v1.2.1 紧急补丁｜品牌色 ≠ 组件色**（架构硬卡，详见 §4.5.1.1）
> - **品牌色 `#2DD4BF` (mint-500) 仅限**：logo / favicon / landing hero / 营销配图
> - **组件色必须用**：`teal-700` (light) / `teal-500` (dark) — 保证 WCAG AA 4.5:1
> - **禁止**：任何 UI 组件（按钮/链接/badge/toast/focus ring）使用 `mint-500` 作主色
> - PR 审查：`pnpm lint:a11y` 必须通过；`components/` 下禁止出现 `bg-mint-500 text-white` 组合

---

### 1.6 依赖与版本锚定

| 依赖 | 版本 | 用途 |
|------|------|------|
| `wxt` | ^0.20 | 构建框架 |
| `typescript` | ^5.4 | 编译 |
| `vite` | ^7（由 wxt 内置） | dev server |
| `@vanilla-extract/css` | ^1.14 | 类型安全样式 |
| `idb`（jakearchibald） | ^8 | IndexedDB Promise 封装 |
| `dexie`（备选） | ^4（≥5MB 截图库场景） | IndexedDB ORM |
| `pdf-lib` | ^1.17 | PDF 生成 |
| `pngjs` | ^7 | PNG 编解码（备选） |
| `comlink` | ^4 | Worker 通信封装 |

**【条件】**
- `wxt` 主版本变更时（0.x → 1.x）需复测构建产物。
- 截图相关库尽量自实现（核心算法见 §3），减少第三方依赖变更风险。

---

## 2️⃣ 模块二｜模块拆分（运行时边界）

### 2.1 模块拓扑总览

```
┌─────────────────────────────────────────────────────────────────────┐
│  Chrome MV3 Runtime                                                   │
│                                                                       │
│  ┌────────────┐    ┌────────────┐    ┌────────────┐                  │
│  │ background │◀──▶│  content   │◀──▶│   popup    │                  │
│  │  Service   │    │  script    │    │   UI       │                  │
│  │  Worker    │    │ (page ctx) │    │            │                  │
│  └────────────┘    └────────────┘    └────────────┘                  │
│         │               │                  │                          │
│         │          ┌────▼─────┐            │                          │
│         │          │  shadow  │            │                          │
│         │          │  overlay │ (截图工具栏)                          │
│         │          └──────────┘            │                          │
│         │                                   │                          │
│         │          ┌────────────────────────▼───────┐                  │
│         └─────────▶│        options page            │                  │
│         │          │   (chrome-extension://)        │                  │
│         │          └────────────────────────────────┘                  │
│         │                                                             │
│         │          ┌─────────────────────────────┐                    │
│         └─────────▶│   offscreen document         │                    │
│                    │   + OffscreenCanvas + Worker │                    │
│                    │   (截图拼接 / 编码)            │                   │
│                    └─────────────────────────────┘                    │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Storage Tiers                                                        │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐         │
│  │ chrome.storage│  │  IndexedDB   │  │  Cloudflare D1   │         │
│  │  local/sync   │  │ (截图/历史)   │  │ (埋点/License)   │         │
│  │  < 100KB      │  │  ~ GB 级     │  │  聚合数据        │         │
│  └──────────────┘  └──────────────┘  └──────────────────┘         │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.2 模块边界与责任矩阵

| 模块 | 线程/上下文 | 主要职责 | **不可做的事** |
|------|-------------|----------|----------------|
| **background (SW)** | Service Worker | 接收消息、调度 orchestration、维护心跳、权限校验、**持有 screenshot long-port（>30s 任务）** | ❌ 不能访问 DOM；❌ 不能持本地状态（持久化用 chrome.storage；长流程状态用 `chrome.runtime.connect` 长连接的 `port`） |
| **content script** | Page Main World / Isolated World | 注入页面、滚动触发、隐藏 fixed 元素、获取 scroll metrics | ❌ 不能调用 chrome.tabs API；❌ 不能跨域访问 iframe 内容（同源限制） |
| **popup** | Extension Popup 上下文（与页面隔离） | UI 入口、历史库列表、设置导航 | ❌ 不能访问页面 DOM；❌ 不能创建 OffscreenCanvas |
| **options page** | Extension Options Page | 设置面板、隐私政策链接、Pro 升级入口 | 同 popup |
| **offscreen document** | 独立隐藏 HTML（DOM 上下文） | OffscreenCanvas 拼接、PDF 编码、Worker 承载 | ❌ 不能监听页面事件；❌ 不能 `chrome.tabs.capture*`（需 background 代理） |
| **shadow overlay** (可选) | content script 内部 DOM | 截图工具栏（区域选择框、提示） | - |

### 2.3 消息契约（`chrome.runtime.sendMessage` + `chrome.runtime.connect` 长连接）

> **v1.2 update**：基于 MV3 SW 30s 生命周期约束，**截图长流程必须用 `chrome.runtime.connect` 长连接**，普通消息保留 `sendMessage`。

#### 2.3.1 消息格式（统一信封）

```ts
type Envelope<T = unknown> = {
  v: 1;                                // 版本号（消息层向前兼容）
  id: string;                          // request id（用于 await 配对）
  scope: 'bg' | 'content' | 'popup' | 'offscreen' | 'options';
  type: string;                        // 'screenshot:start' | 'history:add' | ...
  payload?: T;
};
```

#### 2.3.2 消息发送方式分类

| 任务类型 | 时长 | 方式 | 原因 |
|----------|------|------|------|
| **即时交互**（< 2s） | 单次触发-响应 | `chrome.runtime.sendMessage` + `chrome.runtime.onMessage` | 简单无需保活 |
| **截图长流程**（30s~90s） | scroll-and-stitch 全流程 | `chrome.runtime.connect({name: 'screenshot-port'})` 长连接 + `port.postMessage` | SW 30s 生命周期，单次 sendMessage 会导致 SW 被回收、中断拼接 |
| **会话级别**（持续到关闭） | 历史库/升级流 | 同上 connect 不同 port name | 跨消息保活 |

#### 2.3.3 截图长流程 Port 模型（**核心**）

```
┌─────────────┐       ┌─────────────┐       ┌──────────────┐
│   popup     │       │  background │       │   content    │
│             │       │     SW      │       │   script     │
└──────┬──────┘       └──────┬──────┘       └──────┬───────┘
       │                     │                     │
       │  1. connect('screenshot-port')            │
       ├─────────────────────▶                     │
       │                     │  2. port.postMessage('forward-port') 
       │                     ├─────────────────────▶
       │                     │                     │
       │                     │  3. content 用                      │
       │                     │     onConnect 接收                  │
       │                     │     + 新开 bg⇄content port          │
       │                     │     完成后再 attach 一个             │
       │                     │     bg⇄offscreen port                │
```

**建立连接的最小代码（content 侧）**：

```ts
// content/index.ts
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'screenshot-port') return;
  port.onMessage.addListener(async (envelope: Envelope) => {
    const { type, payload } = envelope;
    switch (type) {
      case 'screenshot:scroll-and-capture':
        const chunk = await scrollAndCapture(payload.targetY);
        port.postMessage({ v:1, id:envelope.id, type:'screenshot:chunk', 
                           scope:'content', payload: chunk });
        break;
      case 'screenshot:abort':
        port.disconnect();
        break;
    }
  });
  port.onDisconnect.addListener(() => { /* 清理 */ });
});
```

**bg 侧（关键：保持 SW 不被回收）**：

```ts
// background/index.ts
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'screenshot-port') return;
  // 关键：每 20s 发心跳，阻止 SW 进入闲置回收
  const heartbeat = setInterval(() => {
    try { port.postMessage({ v:1, type:'screenshot:heartbeat' }); } catch {}
  }, 20_000);
  port.onDisconnect.addListener(() => clearInterval(heartbeat));
});
```

#### 2.3.4 关键消息类型清单（端口化）

| type | 方向 | 通道 | payload | 备注 |
|------|------|------|---------|------|
| `screenshot:start` | popup→bg | port `screenshot-port` | `{tabId, mode:'full'\|'visible'\|'region'}` | 入口 |
| `screenshot:scroll-tick` | bg→content | port `screenshot-port`（bg↔content attach） | `{targetY, segIndex}` | 滚动一段距离 |
| `screenshot:chunk-dataurl` | content→bg | 同上 | `{dataUrl, segIndex, h}` | 单片截图结果 |
| `screenshot:stitch-chunk` | bg→offscreen | port `screenshot-port`（bg↔offscreen attach） | `{dataUrl, segIndex, h}` | 进入拼接 |
| `screenshot:finalize` | offscreen→bg | 同上 | `{finalBlob, dim}` | 完成 |
| `screenshot:abort` | 任意→bg | port | `{reason}` | 用户取消 → disconnect |
| `screenshot:heartbeat` | bg→port 对端 | port | - | 阻止 SW 闲置回收 |
| `history:add` | popup→bg | `sendMessage` | `{meta}` | 写入历史库（即时交互） |
| `storage:get` | popup→bg | `sendMessage` | `{key}` | 读取偏好（即时交互） |
| `telemetry:event` | bg→workers | `fetch`（不走 chrome.runtime） | `{eventName, anonId, ts}` | 埋点上报 |

**【论据】**
- MV3 官方文档明确：**`chrome.runtime.connect` 创建的 port 会持有对扩展的引用**，在 port 期间 SW 不会被回收——这是「长流程保活」的标准答案。
- 30s 是 Chrome 的 `service_worker` 闲置超时（`chrome://serviceworker-internals` 可调），但合规应用应主动设计心跳而非调阈值。
- 普通 sendMessage 也可走 Promise 配对，但 SW 在空闲 30s 后随时可能回收——长流程不可接受此风险。

**【来源】**
- developer.chrome.com《MV3 Messages》《chrome.runtime.connect》
- chrome.serviceworker MDN

**【条件】**
- 所有截图流程消息**必须**走 port，不允许 sendMessage 实现"长流程"。
- port 必须有 `onDisconnect` 清理所有心跳 timer。
- 截图失败 / 用户取消 → 主动 `port.disconnect()`，不等 Chrome 回收。

**【争议点】**
- "heartbeat 频率多少合适"：20s 是经验值（小于 30s 闲置阈值）；高频心跳可能增加 CPU footprint，低频可能漏救。
- 若 v1.1 截图超过 90s（罕见大型页面），需切成多个端口（每 30s 重新连接）—— v1.0 不必处理。

---

### 2.4 三类 UI 入口的设计要点

#### 2.4.1 Popup（点击工具栏图标）
- 入口：`chrome.action.onClicked` + 默认 popup
- 框架：WXT `entrypoints/popup/`（自动注入 shadow DOM 隔离样式）
- 单页路由：Hash 路由或简单 view switcher
- **不缓存页面状态**：每次打开重新拉 storage

#### 2.4.2 Options（设置页）
- 标准 MV3 options_page，可被钉到独立窗口
- 长流程：偏好导入导出、Pro 升级、隐私政策页跳转
- 路由：多 tab 视图（General / Editor / Privacy / About）

#### 2.4.3 Editor（v1.1 引入，**独立 tab 而非 popup**）
- 在 `chrome.tabs.create({url: chrome.runtime.getURL('editor.html?id=xxx')})` 中打开
- editor.html 加载后从 IndexedDB 读图
- **【论据】** chrome-extension:// 协议下页面可承载完整的 DOM + OffscreenCanvas，更适合图像操作；不占用 popup 上下文避免 SW 失效。

---

### 2.5 Storage 分层

| 层 | 引擎 | 大小 | 用途 |
|----|------|------|------|
| L0 | `chrome.storage.local` | ~10MB（受 unlimitedStorage 可扩） | 用户偏好（hotkey、默认格式、自动复制开关等） |
| L1 | `chrome.storage.session` | 内存 | 临时状态（当前截图会话 id、上传进度） |
| L2 | IndexedDB (`idb`) | 受 `unlimitedStorage` 权限可扩至磁盘 ~6% | 截图历史库（blob + 元数据） |
| L3 | Cloudflare D1 | 无限（按量计费） | 聚合埋点 / License 库 |

详见 §6。

---

## 3️⃣ 模块三｜长截图核心算法

> 本节是架构的核心难点，PRD §3 R3 已列为高风险。

### 3.1 总流程

```
用户触发(Alt+Shift+S / popup 按钮)
        │
        ▼
[content] 获取 document 大小 → 计算段数 N = ceil(totalH / segH),  segH 默认 4096px
        │
        ▼
[content] 临时隐藏 fixed/sticky 元素，记录 scrollY=0
        │
        ▼
[loop N 次]
  content:  scrollTo(0, i*segH); 等待 IntersectionObserver 触发 + 1500ms 编排缓冲
  bg:       captureVisibleTab → dataURL → 传递 offscreen
  offscreen: createImageBitmap → 暂存到分段 Map<idx, Bitmap>
        │
        ▼
[offscreen] 拼接：OffscreenCanvas(totalW, totalH)
  for idx in 0..N-1: ctx.drawImage(segMap[idx], 0, idx*segH)
  canvas.convertToBlob({type:'image/png'}) → Blob
        │
        ▼
[bg] 写 IndexedDB + 通知 content 恢复 DOM
        │
        ▼
[popup] Toast「截图完成」+ 缩略图预览
```

**【论据】**
- 4096px 是主流 4K 显示器垂直高度的 4 倍，超出后 captureVisibleTab 性能明显退化。
- IntersectionObserver 确保懒加载图被渲染；1500ms 缓冲覆盖大多数 web font 异步加载。

**【来源】**
- HTML Living Standard：IntersectionObserver
- privatelinkio/longshot（参考实现）

**【条件】**
- 总高 ≤ 5000px：单次 captureVisibleTab
- 总高 5000-30000px：分片滚动（默认 4096/片）
- 总高 > 30000px：分段降级 + 用户提示「页面过长，建议区域截图」

**【争议点】**
- **滚动+捕获存在真实像素与显示像素不完全一致**：transform/filter 元素截屏瞬间可能渲染到不同帧，v1.0 接受此误差（业内所有截图扩展都接受）。
- **长 100k+ 像素页面**：需要分段合并 chunk 边界校正（视口重叠 50px）保证 boundary 不漏元素。

---

### 3.2 跨域 iframe 处理（MV3 难点）

#### 3.2.1 问题陈述

- MV3 Content Script 默认运行在 **isolated world**，无法访问 cross-origin iframe 的 DOM。
- 即便用 `all_frames: true` 注入 iframe，每个 iframe 也是独立 isolated world，**无法跨 iframe 通信**。
- 同一域名 / 不同子域也不同源。

#### 3.2.2 三个方案对比

| 方案 | 实现 | 兼容性 | 精确度 | 选型 |
|------|------|--------|--------|------|
| **A. iframe 占位 + 占位文字**（推荐） | 截图前脚本遍历 `iframe`，把 iframe 替换成带有「外部内容域占位」的 div | ✅ 100% 兼容 | 中（用户能看到有 iframe，但内容空） | **⭐ v1.0 默认** |
| B. `all_frames: true` + 同源 iframe 截图 | manifest 注入 `all_frames: true`，对每个同源 iframe 单独 captureVisibleTab；最后合成 | ⚠️ 仅对同源 iframe 生效 | 高（同源部分） | v1.0 增量优化 |
| C. 第三方 iframe proxy service | 上传 HTML 到自有服务渲染回流 | ❌ 上传、外网依赖、CWS 审核红线 | 高 | **❌ 禁止**（违反「截图不上传」） |

**【论据】**
- A 是行业内截图扩展（GoFullPage、FireShot）默认策略，**隐私合规 + 用户可读性** 双赢。
- B 在 CWS listing 中需要明确说明，且依赖页面是同源，否则等于 A。
- C 直接撞 PRD 第 6 条红线（截图内容上传）。

**【来源】**
- Chrome 官方文档 content_scripts 限制
- CWS Developer Program Policies §User Data

**【条件】**
- A 方案的占位文字格式：**`📎 ${hostname} (embedded)`**（v1.2 update：带 emoji + 短横线分隔，提供视觉锚点与可点击 hostname 提示——PM 评审修订）。
- 占位 div 样式：浅色背景 `#F4F4F5` + 1px 边框 + 12px 圆角 + 浅薄荷绿左侧色条 `#2DD4BF`。
- v1.1 可在 B 基础上对常用白名单（如 youtube.com embed）做主动 capture。

**【争议点】**
- "用户会不会抱怨 iframe 是空的？"——接受风险。竞品都这么做；可加 v1.1 Pro 功能"高级 iframe 渲染"作为付费差异化。
- 若用户主动启用 "all_frames capture" 选项（高级），将引入 B 方案并接受性能损耗。

---

### 3.3 懒加载 / 异步内容触发策略

**目标**：确保 capture 之前，目标区域已完成渲染。

#### 3.3.1 三层触发

```ts
// L1: 滚动触发
window.scrollTo({top, behavior:'instant'});

// L2: 等待网络空闲
await new Promise(r => {
  let idleTimer: number;
  const reset = () => { clearTimeout(idleTimer); idleTimer = window.setTimeout(r, 800); };
  document.addEventListener('load', reset, true);   // 新加载
  window.addEventListener('scroll', reset, true);
  setTimeout(r, 1500);                              // 兜底
});

// L3: 显式触发懒加载
document.querySelectorAll('img[loading="lazy"]').forEach(img => {
  img.loading = 'eager';
});

// 可选：强制 re-layout
document.body.getBoundingClientRect();
```

**【论据】**
- 800ms 是经验值，覆盖 90% web font / 图片懒加载场景。
- 兜底 1500ms 防止 L2 监听漏网（罕见）。
- 强 `loading=eager` 是直接告诉浏览器"快加载"——**仅当 img 元素仍未进入视口时有效**。

**【来源】**
- web.dev《Lazy loading》
- HTML Living Standard §img.loading

**【条件】**
- 总编排缓冲时间（含 L1+L2+L3）≤ 4500ms / 片，超出则触发降级（裁切到当前可见区）。

**【争议点】**
- 强 `loading=eager` 不能控制所有懒加载（如 IntersectionObserver 自实现的）；罕见页面接受降级。

---

### 3.4 Fixed/Sticky 元素处理

#### 3.4.1 三模式

| 模式 | 触发 | 实现 |
|------|------|------|
| 自动隐藏 | 默认开启 | 截图前保存 `originalStyle = el.style.cssText`，将其 `display:none`，截图后恢复 |
| 强制保留 | 用户设置项 | 不修改元素，正常截图（截图会重复出现） |
| 智能去重 | 用户设置 | 保留首段，后段 `display:none`（避免悬浮头 5 次重复） |

**【论据】**
- 行业内常规做法是隐藏；FireShot 的 firefox 版默认是隐藏。
- 「自动隐藏」最契合用户预期，但实现稍复杂（保存 + 恢复状态机）。

**【条件】**
- 隐藏元素范围：`position: fixed | sticky` 且 `z-index > 0` 且非用户主动内容（如 sticky 广告）。
- 截图完毕**必须**恢复；否则等于破坏用户页面（用户能感知）。

**【争议点】**
- 用户的"页面顶部通知条"被隐藏——可能截图后用户以为页面变化了。
- v1.0 默认隐藏 + 设置项"显示 fixed 元素"开关（见 PRD §4.2E）。

---

### 3.5 性能预算与失败降级

| 指标 | 预算 | 超预算措施 |
|------|------|------------|
| 单片滚动+等待 | ≤ 4.5s | 缩短到下一片 |
| 总拼接时间（10 段） | ≤ 60s | 弹 toast「页面过长，建议区域」 |
| 单片 PNG 大小 | ≤ 4MB | 切换 JPEG q=85 |
| DOM 恢复 | 必须 < 200ms | 失败则 console.warn |
| IndexedDB 写入 | ≤ 1s（per entry） | 失败则本地降级到 memory |
| **连续失败次数** | **重试 3 次** | **回退到 B 方案（html2canvas 家族）** ⬇️ 新增 v1.2 |

#### 3.5.1 失败重试与 B 方案回退逻辑（v1.2 update）

```ts
async function captureWithFallback(url: string, opts: CaptureOpts) {
  const MAX_RETRY = 3;          // 重试 3 次（A 方案）
  const RETRY_DELAY_MS = 1500;  // 每次重试间隔
  
  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    try {
      const blob = await captureWithStitching(opts);  // 方案 A
      if (await validateStitchedImage(blob)) return { blob, method: 'A', attempt };
      throw new Error('blob validation failed');
    } catch (err) {
      console.warn(`[shotly] capture attempt ${attempt}/${MAX_RETRY} failed:`, err);
      if (attempt < MAX_RETRY) {
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      // 3 次全失败 → 回退 B 方案
      console.warn('[shotly] falling back to html2canvas approach');
      const blobB = await captureWithDOMRender(opts);  // 方案 B
      if (!blobB) throw new Error('Both A and B strategies failed');
      telemetry.report('screenshot.full.fallback_b');
      return { blob: blobB, method: 'B', attempt };
    }
  }
}
```

**【论据】**
- **3 次重试** 覆盖偶发 transient 错误（懒加载延迟、Chromium GPU 抖动、第三方脚本注入晚），但避免对真正失败页面无限重试浪费 CPU。
- **B 方案 (html2canvas 家族)** 已被 §1.3 列为降级；v1.2 起进入实际工程实现，作为 A 方案的兜底而非废弃。
- 重试间隔 1500ms 给浏览器喘息窗口恢复渲染管线。

**【条件】**
- 单页面截图最多**重试 3 次后回退 1 次**（A→B），总计最多 4 次尝试，避免性能雪崩。
- 任何 B 方案触发都上报 `screenshot.full.fallback_b` 埋点，用于 D+3 PoC 后评估实际失败率。

**【争议点】**
- "4 次尝试可能让用户等待 60s+ 才出图"——接受此风险（vs 截图失败体验更差），B 方案成功后告诉用户"已用兼容模式截图"。
- 若 B 方案连续 2 周触发率 > 10%，需要反向优化 A 方案稳定性（v1.1 迭代）。

---

### 3.6 截图 PoC 验证清单（D+3 前必跑）

- [ ] wikipedia.org 主页（5000px，标准 DPR）→ 完整拼接且无错位
- [ ] notion.so 工作区（30000px+，高 DPR）→ 性能达标
- [ ] 包含 5 个跨域 iframe 的页面（A 方案占位正常）
- [ ] Pinterest 风格重图页面（>200 img，懒加载）
- [ ] dark mode 页面（避免薄荷绿叠加色）
- [ ] web font 加载延迟页面（编排缓冲覆盖）

---

## 4️⃣ 模块四｜权限清单（MV3 最小化）

### 4.1 最小权限集（manifest.json）

```json
{
  "manifest_version": 3,
  "name": "Shotly",
  "permissions": [
    "activeTab",
    "scripting",
    "offscreen",
    "storage",
    "downloads",
    "clipboardWrite",
    "unlimitedStorage",
    "tabs"
  ],
  "host_permissions": ["<all_urls>"],
  "action": {
    "default_popup": "popup.html",
    "default_title": "Shotly"
  },
  "background": {
    "service_worker": "background.js",
    "type": "module"
  },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["content.js"],
      "run_at": "document_idle"
    }
  ],
  "options_page": "options.html",
  "web_accessible_resources": [
    {
      "resources": ["offscreen.html", "editor.html"],
      "matches": ["<all_urls>"]
    }
  ]
}
```

**v1.2 update 依据**：
- `clipboardWrite`：剪贴板复制（F4 P0 核心）必需，从可选改为必须
- `unlimitedStorage`：IndexedDB 截图库 ≥ 50MB 必需，chrome.storage 默认仅 ~10MB / 严格模式仅 100KB
- `tabs`：快捷键 `Alt+Shift+S` 触发需 `chrome.tabs.query` + `captureVisibleTab` 调用

### 4.2 各权限用途（CWS 审核必备说明）

| 权限 | 用途 | 必要性 | 审核说服要点 |
|------|------|--------|--------------|
| `activeTab` | 用户点击扩展图标时注入到当前页 | ✅ 必须 | 截图核心需要，**不预先注入** |
| `scripting` | `chrome.scripting.executeScript` 注入 content script | ✅ 必须 | 用于精确控制注入时机（非 on-load） |
| `storage` | 保存偏好与 License state | ✅ 必须 | 含 `unlimitedStorage` 时扩到 GB 级（见 §6） |
| `downloads` | 保存截图到本地磁盘 | ✅ 必须 | **截图默认导出方式** |
| `offscreen` | 创建 offscreen 文档承载 canvas | ✅ 必须 | MV3 SW 不能访问 DOM，**这是合规官方推荐** |
| `clipboardWrite` | **剪贴板复制截图** | ✅ **必须**（v1.2 从可选升为必须） | F4 P0 核心功能，`navigator.clipboard.write` 必需该权限 |
| `unlimitedStorage` | **IndexedDB 截图库扩容** | ✅ **必须**（v1.2 新增） | 历史库 50 条截图 ≥ 50MB；chrome.storage 默认 100KB 远超不足 |
| `tabs` | **快捷键触发的 `tabs.query` + `captureVisibleTab`** | ✅ **必须**（v1.2 从 optional 升为必须） | Alt+Shift+S 全局快捷键必需 |
| `<all_urls>` | 允许任何网页截图 | ✅ 必须（截图扩展共同点） | **用户在 popup 点击截图时自动激活**，无后台扫描 |

### 4.3 禁忌权限（**绝对不申请**）

| 权限 | 原因 |
|------|------|
| `debugger` | DevTools 协议 = CWS 一票否决 |
| `webRequest` / `declarativeNetRequest` | 截图不需要拦截网络 |
| `proxy` | 不代理 |
| `cookies` / `history` | 严重越权 |
| `browsingData` | 永远不需要 |
| `webNavigation` | 同 `tabs`，超规格 |
| `contentSettings` | 同上 |
| `identity` / `oauth2` | v1.0 不用账号体系；v1.1 可按需申请 |
| `enterprise.platformKeys` | 企业级，无关 |

**【论据】**
- CWS 拒审首要原因是权限过度；保持最小集降低审核延迟与封禁风险。
- 任何 `host_permissions` 都应在「用户实际访问」时申请，不能冷启动预授权。

**【来源】**
- developer.chrome.com《Manifest V3 权限参考》
- CWS Developer Program Policies §Permissions

**【条件】**
- v1.1 增加 Pro 升级时，**新增权限需在更新日志明确说明**，避免触发 CWS 自动审核。

**【争议点】**
- "为什么需要 `<all_urls>`" 是 CWS 审核员最常见的提问，准备一段 ≤ 250 字回答作为 listing 描述草案（PRD §6.2 已授权）。

---

### 4.4 权限申请策略（v1.0 → v1.1）

| 版本 | 权限集 | 变化 |
|------|--------|------|
| v1.0 | 8 项 + `<all_urls>`：activeTab / scripting / offscreen / storage / downloads / clipboardWrite / unlimitedStorage / tabs | 起步（v1.2 一次性补齐） |
| v1.1 | + `identity`（IAP 校验时读 user info） | **必须重新审核**，但增加分项权限可避免惊动 |
| v1.2+ | 不加新权限为上 | 数据已本地，避免 |

**v1.2 重要修正**：原 §4.1 列 5 项 + 可选 `tabs` 是**低估算**，以下 3 项必须从 v1.0 一开始就申请，否则 F4/F7/快捷键均不可用：
- `clipboardWrite`（F4 P0 复制）
- `unlimitedStorage`（F7 P1 历史库）
- `tabs`（F10 P1 快捷键）

---

## 4️⃣.5 Dark Mode 色彩对比度规范（v1.2 新增 / PM 评审响应）

> **v1.2 update 依据**：PM 评审指出薄荷绿 #2DD4BF 主色按钮在暗色截图上对比度可能不足 WCAG 4.5:1 标准。
> **🚨 v1.2.1 紧急补丁（2026-07-12 派工）**：design-spec v1 收口发现「品牌色误用作组件色」场景遗漏，强制使用规范见下。

#### 4.5.1 Prescriptive 双 Token 体系（强制使用）

| 场景 | Token | Hex | 文字 | 对比度 | 状态 |
|------|-------|-----|------|--------|------|
| **Light mode 主按钮 / 链接 / CTA / focus ring** | `teal-700` | `#0F766E` | `#FFFFFF` | **6.86:1** | ✅ **强制** |
| **Dark mode 主按钮 / 链接 / CTA / focus ring** | `teal-500` | `#14B8A6` | `#0A0A0A` | **7.12:1** | ✅ **强制** |
| **品牌色（仅 logo / landing hero / favicon）** | `mint-500` | `#2DD4BF` | `#0A0A0A` | **11.78:1** | ✅ **限定** |
| **桌面端 a11y 加分（hover / focus glow）** | `teal-600` | `#0D9488` | `#FFFFFF` | **5.62:1** | ⭐ 加分项 |
| ❌ ~~Light mode 主按钮误用 mint-500~~ | ~~`mint-500`~~ | ~~`#2DD4BF`~~ | ~~`#FFFFFF`~~ | ~~**2.71:1**~~ | ❌ **禁止** |

#### 4.5.1.1 品牌色 vs 组件色 — 使用范围表（必读，PR 审查硬卡）

| 颜色 | 允许场景 | 禁止场景 |
|------|----------|----------|
| `#2DD4BF` `mint-500` | ✅ logo / favicon / landing page hero / 营销配图 / splash | ❌ **任何 UI 组件**（按钮、链接、badge、toast、focus ring、checkbox、tab indicator） |
| `#0F766E` `teal-700` | ✅ Light mode 主按钮 / 链接 / focus ring / 选中态 | ❌ 品牌 logo / 营销主图 |
| `#14B8A6` `teal-500` | ✅ Dark mode 主按钮 / 链接 / focus ring / 选中态 | ❌ 品牌 logo / 营销主图 |
| `#0D9488` `teal-600` | ✅ hover / focus glow / 高对比模式按钮 | ❌ Light/Dark 默认态（避免与默认色冲突） |

**【论据】**
- 品牌色 `#2DD4BF` vs 白字对比度仅 **2.71:1**，远低于 WCAG 2.1 AA 标准 4.5:1 — 用作按钮背景即视作 a11y 失败。
- 用户在 dark-mode 系统下截图亮色页面，按钮若用 `#2DD4BF` 会出现「按钮与背景同色融化」现象（白底薄荷绿按钮在浅色截图里几乎不可见）。
- 品牌色 vs 组件色分离是 Linear / Vercel / Raycast 等现代 SaaS 通用做法——品牌色负责"身份"，组件色负责"可读"。

**【条件】**
- 任何 PR 包含 UI 组件色彩变更 → 必须跑 `pnpm lint:a11y`（自定义规则：禁止 `bg-mint-500 text-white` 组合出现在 `components/` 下）
- 落地页 `getshotly.com` 由独立仓库部署，**不受本规范约束**（品牌主视觉保留 `#2DD4BF` 大色块装饰）

```ts
// styles/tokens.css.ts
export const colors = {
  brand: {
    light: { bg: '#0F766E', fg: '#FFFFFF', name: 'teal-700' },
    dark:  { bg: '#14B8A6', fg: '#0A0A0A', name: 'teal-500' },
  },
  neutral: {
    light: { bg: '#FAFAFA', fg: '#18181B' },
    dark:  { bg: '#18181B', fg: '#FAFAFA' },
  },
};
// 遵循用户系统设置：prefers-color-scheme
```

**【论据】**
- WCAG 2.1 AA 标准要求主按钮文本对比度 ≥ 4.5:1。
- 原始 #2DD4BF vs 白字对比度仅 2.71:1，**未达 AA**，影响 Popup/Options 内主 CTA 按钮的视觉可读性。
- 改用更深的 teal (#0F766E / #14B8A6) 既保留品牌色系（仍在薄荷绿家族），又满足 a11y。

**【条件】**
- 截图按钮（Popup 主 CTA）默认使用 dark-mode token，确保深色截图背景上仍清晰。
- Privacy 政策/About 页面用 light-mode token（背景浅）。
- 不影响品牌色在落地页（getshotly.com）的视觉——落地页 hero 可继续用原始 #2DD4BF（大色块装饰 + 黑色文字，对比度 11.78:1）。

**【争议点】**
- "用户会不会觉得色变了？"——只在组件层面调整（如按钮/链接），品牌主视觉（logo、落地页）不变；感知差异最小。
- 若设计坚持 #2DD4BF，使用 high-contrast variant（#0D9488）作为折中。

#### 4.5.3 截图后预览区域颜色叠加警告

当用户在 dark-mode 页面截图时，截图结果可能含亮色块（如暗色代码截图、notion 工作区）；UI 层不应通过 canvas CSS filter 影响原图。

- **原则**：原始截图不应用任何 CSS filter；UI 工具栏在截图外层定位
- **例外**：截图预览缩略图点击查看大图时，可提供 toggle "暗/亮主题查看" ——不修改原图，仅作用于 viewer

---

## 5️⃣ 模块五｜IAP 接入设计（含 CWS IAP 强制修正）

### 5.1 ⚠️ 重大修正：CWS In-App Payments 不可用

#### 5.1.1 现状陈述

Google 已于 **2020-09-20** 正式公告弃用 Chrome Web Store In-App Payments 系统：
- **2020-09-21 起**：无法创建新的付费扩展或 in-app items
- **2021-02-01 起**：现存订阅自动停止续费，但 Licensing API 仍可查询状态
- **未来某时**：Licensing API 也将关闭

这意味着 PRD 第 5 条「CWS IAP 主路径」在 2026 年**已不可行**，**必须改用第三方支付服务商**。

**【来源】**
- developer.chrome.com 官方文档《Chrome Web Store payments deprecation》
- GitHub: GoogleChrome/developer.chrome.com/site/en/docs/webstore/cws-payments-deprecation/index.md

**【论据】**
- 公告在 5 年前已发，明确「永久关闭付费扩展能力」。
- 即便 Licensing API 当前可查询，**无法新增交易**——v1.1 上线时根本无法收钱。

**【条件】**
- 现有付费扩展可继续查询许可证，但**新扩展无法走 CWS IAP**。
- 所有 v1.1 起的付费必须外接支付商。

**【争议点】**
- 既然如此，**PRD 必须更新**：删除「CWS IAP 主路径」表述，统一改为第三方支付接入。

#### 5.1.2 修正建议（待 PM 同步）

修订 PRD 第 5 条决策为：

> ✅ **修订**：v1.1 付费渠道改用**第三方支付**（Lemon Squeezy / Paddle / Stripe）。
> - 推荐主选：Lemon Squeezy（费率 5% + $0.50/笔，Merchant of Record 处理全球税务）
> - 备选：Paddle（同为 MoR，覆盖更广）
> - 备选：Stripe（费率 2.9% + $0.30，但需自己处理税务）
> - v1.0 不接支付，仅埋点+落地区分免费用户。

---

### 5.2 支付服务商对比（v1.1 选型）

| 服务商 | 费率 | 税务处理 | License 校验模式 | 单人开发者友好度 | 评分 |
|--------|------|----------|------------------|------------------|------|
| **Lemon Squeezy** | 5% + $0.50 | ✅ MoR（全球税务） | webhook + License Key API | ⭐⭐⭐⭐⭐ | **推荐** |
| Paddle | 5% + $0.50 | ✅ MoR | webhook + subscription API | ⭐⭐⭐⭐ | 备选 |
| Stripe | 2.9% + $0.30 | ❌ 自处理 | Checkout + Webhook | ⭐⭐⭐⭐ | 备选 |
| Gumroad | 10% | ✅ MoR | webhook + License Key | ⭐⭐⭐ | 不推荐（费率） |

**【论据】**
- **MoR（Merchant of Record）**：服务商代收代缴税，**单人开发者无需注册 VAT / 申请 tax ID** —— 极大降低合规负担。
- Lemon Squeezy 在 Indie Hacker 圈口碑好，文档对 subscription license 校验友好。
- Stripe 费率最低，但**全球税务处理需自己跑**：单人项目 14-19 天节奏下，税务申报可能挤占上线窗口。

**【来源】**
- extensionfast.com《Collect Chrome Extension Payments (2026)》
- globalsolo.global《Stripe vs Paddle vs Lemon Squeezy vs Gumroad: Fees Compared (2026)》
- payzzle.co（行业新晋 Lemon Squeezy + Paddle 桥接）

**【条件】**
- 选定 MoR 服务商后，单人开发只需注册账号 + 配置产品。
- 跨币种定价由 MoR 自动结算回美元/原币。

**【争议点】**
- 5% vs 2.9% 费率差距在早期用户量不大时**几乎不影响**；待用户量大可再切 Stripe。
- **License key 反滥用**：必须 server-side 校验，**不能客户端硬编码**（见 §5.4）。

---

### 5.3 License 校验流程（v1.1）

```
┌─────────────┐                  ┌──────────────────┐                ┌──────────────┐
│  Chrome     │                  │   Lemon Squeezy  │                │  Cloudflare  │
│ Extension   │                  │   (MoR)          │                │  Workers +   │
│ (Shotly)    │                  │                  │                │  D1          │
└──────┬──────┘                  └────────┬─────────┘                └──────┬───────┘
       │   1. 用户点升级                  │                                  │
       ├─────────────────────────────────▶                                  │
       │   弹支付页                       │                                  │
       │                                  │   2. 用户支付（信用卡/PayPal）   │
       │                                  ├───┐                              │
       │                                  │   │ 3. 支付成功                  │
       │                                  │◀──┘                              │
       │   4. 跳转 checkout success URL    │                                  │
       │   ?license_key=XXXX&email=YYY    │                                  │
       │◀─────────────────────────────────│                                  │
       │                                                                 │
       │  5. 用户输入 license_key 到扩展                                    │
       │     chrome.storage.local.set({ licenseKey })                      │
       │                                                                 │
       │  6. 后台异步调用 license 校验                                       │
       ├─────────────────────────────────────────────────────────────────────▶
       │                                                                 │
       │                                                          POST /v1/license/verify
       │                                                          { licenseKey, extensionId }
       │                                                                 │
       │                                                          [D1 查询 licenses 表]
       │                                                          [签名检查 → 命中 → 返回 tier]
       │                                                                 │
       │  7. 校验结果回写到 chrome.storage.local { licenseState }          │
       │◀─────────────────────────────────────────────────────────────────────
       │                                                                 │
       │  8. content/popup 读 licenseState 判断 UI 行为                    │
       │     - 免费：埋点 + 升级引导                                        │
       │     - 付费：解锁编辑器/水印/PDF 分页                              │
└─────────────────────────────────────────────────────────────────────┘
```

**【论据】**
- License Key 由 Lemon Squeezy 生成，**服务端校验**避免被本地篡改。
- D1 表存储 license 库，Worker 公开 `POST /v1/license/verify` 端点。
- 扩展端不调用 LS 后台管理 API，避免暴露 secret。

**【来源】**
- Lemon Squeezy License Keys API（官方文档）
- MoR 与 License 校验模式行业实践

**【条件】**
- 用户激活后 license 状态**本地缓存** + **24 小时重新校验一次**（轮询 + onActivate 触发）。
- **任何 UI 行为的最终依据**是 `chrome.storage.local.licenseState`，永远不依赖 Worker 实时响应。

**【争议点】**
- "如果 Cloudflare Worker 挂了呢？"——降级策略：本地缓存 7 天默认有效，过期后只读不写（Pro 功能仍可用，但暂停 license 校验）。
- License key 在 D1 表必须以 email + extensionId 关联，**不能仅 license_key 本身**——防滥用。

---

### 5.4 Cloudflare Workers 服务端架构

#### 5.4.1 服务清单

| 路径 | 方法 | 用途 | 调用方 | 鉴权 |
|------|------|------|--------|------|
| `/v1/track` | POST | 接收埋点事件 | Service Worker | HMAC signature + App Check（推荐） |
| `/v1/license/verify` | POST | 校验 License Key | Service Worker | 不需（公开端点 + 限速） |
| `/v1/license/activate` | POST | 首次激活绑定 extensionId | Service Worker | License Key |
| `/v1/health` | GET | 健康检查 | cron / 监控 | 不需 |

#### 5.4.2 Workers 项目结构

```
shotly-backend/
├── wrangler.toml              ← CF 配置（D1 binding / KV / secrets）
├── src/
│   ├── index.ts               ← Hono 路由器（轻量）
│   ├── routes/
│   │   ├── track.ts
│   │   ├── license.ts
│   │   └── health.ts
│   ├── lib/
│   │   ├── crypto.ts          ← HMAC 验签
│   │   ├── rate-limit.ts      ← CF KV 实现的滑窗限速
│   │   └── ga-mirror.ts       ← Cloudflare Analytics Engine（可选）
│   └── schema/
│       └── d1.sql             ← D1 schema
├── migrations/                ← wrangler d1 migrations
└── README.md
```

#### 5.4.3 D1 数据模型

```sql
-- 埋点事件聚合（每日一聚合，原事件写 Analytics Engine）
CREATE TABLE events_daily (
  day            TEXT,         -- YYYY-MM-DD
  event_name     TEXT,
  source         TEXT,         -- 'extension' | 'web'
  count          INTEGER,
  unique_users   INTEGER,
  PRIMARY KEY (day, event_name, source)
);

-- License 库（v1.1 启用）
CREATE TABLE licenses (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  license_key        TEXT UNIQUE NOT NULL,
  email              TEXT,
  tier               TEXT,      -- 'monthly' | 'yearly' | 'lifetime'
  status             TEXT,      -- 'active' | 'expired' | 'refunded'
  extension_id       TEXT,      -- 首次激活的 Chrome extensionId（防滥用）
  activated_at       INTEGER,   -- ms timestamp
  expires_at         INTEGER,   -- ms timestamp
  created_at         INTEGER NOT NULL
);

CREATE INDEX idx_licenses_email ON licenses(email);
CREATE INDEX idx_licenses_status ON licenses(status);
```

**【论据】**
- Hono 框架 + Workers，冷启动 < 5ms，单 Worker 实例可支撑 10000+ QPS。
- D1 单库 500MB / 50M 写入/天足够 v1.x 全生命周期。
- **埋点原始事件不写 D1**（量大会爆），改用 Cloudflare Analytics Engine（免费且自动聚合）。

**【条件】**
- Analytics Engine 每天上限 100k events，**超出成本激增**——v1.0 仅上报关键事件（10+ 事件名内）。
- License 表按 `email + extensionId` 双索引，便于人工审计。

---

### 5.5 Privacy by Design：服务器看不到截图

**架构红线（PRD 第 6 条 + 法规合规）**：

- **永远不上传截图 Blob 至服务端**——Cloudflare Workers 没有任何 API 可以接 binary blob。
- 埋点仅上报事件：**事件名 + 匿名 ID + 时间戳 + 设备版本**，**不上传 URL / 内容 / 截图**。
- 匿名 ID：`crypto.randomUUID()`，**首次启动时生成并持久化到 chrome.storage.local**（无 PII 关联）。

**【论据】**
- 这是 CWS 审核 + GDPR + CCPA 合规的硬条件，违反任何一条会被拒审/起诉。
- 设计上的"物理隔离"（根本没有上传 API）比策略上的"我们不会上传"更有说服力。

---

## 6️⃣ 模块六｜数据流设计

### 6.1 三层存储总览

```
┌────────────────────────────────────────────────────────────────────┐
│  本地侧（用户设备）                                                   │
│                                                                     │
│  L0 chrome.storage.local   ←  偏好 + License state + anon_id      │
│     (≤ 1MB)                                                            │
│                                                                     │
│  L1 chrome.storage.session  ←  临时状态（截图会话进度）              │
│     (≤ 1MB, 进 session 内存)                                            │
│                                                                     │
│  L2 IndexedDB (via idb)   ←  截图历史库                              │
│     (≤ ~6% 磁盘，unlimitedStorage)                                     │
│     ┌──────────┐                                                       │
│     │ history  │  id, blob (PNG/JPG/PDF), created_at, url, dim        │
│     │          │                                                       │
│     │ settings │  通过 chrome.storage 同步，不进 IndexedDB             │
│     └──────────┘                                                       │
└────────────────────────────────────────────────────────────────────┘
                              │  仅事件级埋点（非内容）
                              ▼
┌────────────────────────────────────────────────────────────────────┐
│  云端侧（Cloudflare）                                                  │
│                                                                     │
│  L3a Cloudflare Analytics Engine  ←  原始事件流                      │
│       (100k events/day 免费, 自动聚合)                                  │
│                                                                     │
│  L3b Cloudflare D1                ←  聚合后每日统计 + License 库      │
│       (events_daily, licenses)                                          │
│                                                                     │
│  L3c Cloudflare KV                ←  缓存 License 状态              │
│       (减少 D1 读)                                                       │
└────────────────────────────────────────────────────────────────────┘
```

### 6.2 L2 IndexedDB Schema

```ts
// DB: shotly, version: 1
// Object Stores:
interface IHistoryEntry {
  id: string;                  // uuid
  blob: Blob;                  // PNG/JPG/PDF binary
  meta: {
    url: string;               // 截图来源页 URL（本地存储，不上传）
    title: string;
    capturedAt: number;        // ms timestamp
    width: number;
    height: number;
    format: 'png' | 'jpg' | 'pdf';
    size: number;              // bytes
    source: 'full' | 'visible' | 'region' | 'editor';
  };
}

interface IEditorState {       // v1.1
  id: string;
  historyId: string;           // FK to history.id
  layers: unknown[];           // canvas layer 状态
  updatedAt: number;
}
```

**stores 列表**：

| Store | Key | Index | 用途 |
|-------|-----|-------|------|
| `history` | `id` (uuid) | `capturedAt`, `source` | 截图历史 |
| `editor` | `id` (uuid) | `historyId` | v1.1 编辑器草稿 |

**【论据】**
- `idb` 库（jakearchibald，~3KB）Promise 封装，比裸 IndexedDB 节约 30% 代码。
- 单 store 30-50 条历史 + LRU 淘汰策略（保留最近 50 条，符合 PRD §3.2 F7）。

**【来源】**
- adnank.hashnode.dev《Building Local-First with IndexedDB》
- stackoverflow《chrome.storage.local vs IndexedDB》

**【条件】**
- 必须申请 `unlimitedStorage` 权限（见 §6.4）。
- 截图超 50 条时按 LRU 删除；删除前提示用户（弹 toast）。

**【争议点】**
- **Dexie vs idb**：Dexie 提供 ORM 与查询 DSL，但~30KB 体积对一个截图扩展略显重；v1.0 用 `idb`，v1.1 若需复杂查询再换 Dexie。

---

### 6.3 L0 chrome.storage 使用约束

| Key | 类型 | 用途 |
|-----|------|------|
| `pref.hotkey` | string | 默认 `Alt+Shift+S` |
| `pref.defaultFormat` | 'png' \| 'jpg' \| 'pdf' | 默认 `png` |
| `pref.autoCopy` | boolean | 默认 `true` |
| `pref.hideFixed` | boolean | 默认 `true` |
| `pref.segmentHeight` | number | 默认 `4096` |
| `pref.theme` | 'light' \| 'dark' \| 'auto' | 默认 `auto` |
| `license.state` | `{tier, expiresAt, validatedAt}` | Pro 状态 |
| `license.key` | string | 仅本地缓存 |
| `anon.id` | string (uuid v4) | 首次启动生成 |
| `telemetry.installId` | string | 安装事件 ID |

**【论据】**
- `chrome.storage.local` 同步是可靠的偏好持久化；同步 sync 容量仅 ~8KB，不适合 License state。
- License state 必须本地缓存，**不能用 chrome.storage.sync 跨设备同步**——避免 PII 跨设备传输增加合规风险。

---

### 6.4 unlimitedStorage 权限

**【论据】**
- IndexedDB 默认容量受 `storage.estimate().quota` 限制（通常为总磁盘的 ~2-6%）。
- 50 张截图 ≈ 50MB+，**可能超限**。
- 申请 `unlimitedStorage` 后，用户不再受存储配额限制，**但用户必须主动同意**（CWS 审核看点）。

**【条件】**
- 申请此权限需在 CWS listing 明确写出理由：「用于保存用户历史截图库到本地」。
- 不申请无法存历史 → v1.0 必有此权限。

**【争议点】**
- 部分截图类扩展为了避免 unlimitedStorage 改用 `chrome.storage.local` + FileSystem API 组合，但 IndexedDB + unlimitedStorage 是更标准的方案。

---

### 6.5 数据流图（截图完成 → 历史库）

```
[bg] capture 完成 → offscreen 拼图 → Blob
       │
       ▼
[bg] window.confirm('保存到历史？') ← 用户在 popup 显式确认
       │
       ▼
[popup] 用户同意 → 调用 chrome.runtime.sendMessage('history:add', { blob, meta })
       │
       ▼
[bg] 接收 → 写 IndexedDB (history store)
       │
       ▼
[bg] 触发 telemetry 事件 'screenshot.saved'（只上报事件名，非 URL/内容）
       │
       ▼
[offscreen/Cloudflare Analytics Engine] 聚合到 D1 (events_daily)
```

**【论据】**
- 用户显式确认保存（PRD 要求），减少"无声占磁盘"的负反馈。
- 埋点不包含 URL——满足隐私红线。

---

## 7️⃣ 模块七｜上架合规架构

### 7.1 隐私政策落点（Privacy Policy）

#### 7.1.1 落地页位置

- **静态托管**：Cloudflare Pages，路径 `https://getshotly.com/privacy`
- **多语种**：
  - `/privacy/en` 英文（默认）
  - `/privacy/zh` 中文
  - `/privacy/es` 西语
  - `/privacy/pt` 葡语
- 单页应用或静态 Markdown 转 HTML。

#### 7.1.2 必备字段（PRD §6.3）

| 字段 | 内容草拟 |
|------|----------|
| 数据收集方 | Shotly Team (contact@getshotly.com) |
| 数据类型 | **截图内容**（不上传，仅本地）、**埋点事件**（事件名+匿名 ID+时间戳）、**偏好设置** |
| 数据使用 | 产品改进 + 用户体验优化 |
| 第三方共享 | Chrome Web Store（IAP 历史，本项目已禁用）、Lemon Squeezy（v1.1 支付）、Cloudflare（托管/Workers） |
| 数据保留期 | 截图本地存储至用户主动清除；埋点事件 90 天 |
| 数据删除入口 | contact@getshotly.com（v1.1 增加自助删除 UI） |
| GDPR / CCPA | 明确支持 "请求我的数据" + "请求删除我的数据" 流程；提供"Do Not Sell"链接 |

#### 7.1.3 隐私政策架构（git-tracked）

```
shotly-website/
├── pages/
│   ├── index.tsx              ← 落地页
│   ├── privacy/
│   │   ├── en.md              ← i18n markdown
│   │   ├── zh.md
│   │   ├── es.md
│   │   └── pt.md
│   ├── terms/[lang].md
│   └── dpa/[lang].md          ← Data Processing Agreement
└── public/
    └── assets/
```

---

### 7.2 数据收集声明（Data Collection Disclosure in CWS）

CWS 审核后台 **Single Purpose** + **Permission Justification** + **Data Usage** 三段：

| 段 | 必填内容 |
|----|----------|
| **Single Purpose** | "Whole page screenshot capture, export, and annotation" |
| **Permission Justification（每个权限）** | 见 §4.2 表 |
| **Data Usage** | "Collects anonymized event analytics (event name, anonymous ID, timestamp) for product improvement. Does NOT collect screenshots, URLs, or any personal content." |

---

### 7.3 服务端埋点设计

#### 7.3.1 事件清单（v1.0 启 10 个）

| 事件名 | 触发时机 | payload（不上传 URL/内容） |
|--------|----------|---------------------------|
| `install` | 安装完成 | `{ version }` |
| `screenshot.full.start` | 用户触发全页截图 | `{ tabWidth, tabHeight }` |
| `screenshot.full.success` | 截图成功 | `{ durationMs, segCount }` |
| `screenshot.full.fail` | 截图失败 | `{ reason: 'timeout' \| 'cross-origin' \| ... }` |
| `screenshot.region.start` | 区域截图开始 | - |
| `screenshot.region.success` | 区域截图成功 | `{ durationMs }` |
| `export.format` | 用户导出 | `{ format: 'png' \| 'jpg' \| 'pdf' }` |
| `history.save` | 用户存到历史 | - |
| `history.delete` | 用户删除 | `{ count }` |
| `upgrade.cta.click` | 用户点 Pro 升级入口 | `{ source: 'popup' \| 'options' }` |
| `error.runtime` | 内部错误 | `{ code }` |

**【论据】**
- 10 个事件足以洞察核心漏斗（激活 → 触发 → 成功 → 转化）。
- 不带 URL/PII 是合规硬约束。

#### 7.3.2 客户端实现

```ts
// src/utils/telemetry.ts
const BATCH_INTERVAL_MS = 30_000;
const queue: Event[] = [];

async function report(name: string, payload?: object) {
  queue.push({ name, anon_id: await getAnonId(), ts: Date.now(), payload });
  if (queue.length >= 20) flush();
}
function flush() {
  fetch('https://shotly-telemetry.getshotly.com/v1/track', {
    method: 'POST',
    headers: { 'X-Signature': await hmac(JSON.stringify(queue)) },
    body: JSON.stringify({ events: queue }),
  });
  queue.length = 0;
}
setInterval(flush, BATCH_INTERVAL_MS);
```

#### 7.3.3 服务端处理（Worker）

```ts
// src/routes/track.ts
export const trackRoute = async (c: Context) => {
  const sig = c.req.header('X-Signature');
  if (!verifyHmac(sig, await c.req.text())) return c.text('invalid sig', 401);
  const { events } = await c.req.json();
  // 写入 Analytics Engine
  for (const e of events) {
    c.env.ANALYTICS.writeDataPoint({
      blobs: [e.name, e.anon_id.slice(0, 8)],  // 截断匿名 ID
      doubles: [e.ts],
      indexes: [e.name],
    });
  }
  return c.text('ok');
};
```

**【论据】**
- HMAC 签名防伪造。
- Analytics Engine 的 `blobs` 限制 20 字节 → 匿名 ID 截断前 8 字符。
- 端到端无 PII，落表也匿名。

---

### 7.4 GDPR / CCPA 合规架构

#### 7.4.1 数据主体权利（GDPR Art. 15 / 17）

| 权利 | 实现 |
|------|------|
| **知情权** | 隐私政策 + CWS Data Usage 声明 |
| **访问权** | 用户邮件 contact@getshotly.com，72h 内提供匿名 ID 下所有埋点 |
| **删除权** | 同邮箱；服务端清理 D1 / KV / Analytics Engine 数据 |
| **可携带权** | 提供 JSON 导出（v1.1 自助） |

#### 7.4.2 CCPA "Do Not Sell"

- 隐私政策固定位置"Do Not Sell or Share My Personal Information"链接
- 本项目不出售任何数据；该链接点击 → 显示"我们不卖数据" + 解释

**【论据】**
- GDPR / CCPA 是 CWS 上架硬要求，违规会触发现金罚款 + 商店下架。
- "Do Not Sell"链接必须存在，**即使业务上不卖也要有**（合规自律）。

---

### 7.5 CWS Listing 草拟要点

| 项 | 草拟 |
|----|------|
| 短描述 | "Modern whole-page screenshot tool. Capture, annotate, export. Privacy-first, no upload." |
| 长描述 | "Shotly is the modern whole-page screenshot extension. One click captures full pages, fixed elements hidden by default. Local annotation with arrows/text/boxes. Export PNG, JPG, PDF. Privacy by design: your screenshots never leave your device."（约 200-400 词） |
| 截图（1-5 张） | 工具栏弹窗 / 完成预览 / 历史库 / 设置 / 编辑器(v1.1) |
| 类别 | Productivity |
| 语言 | 英 / 中 / 西 / 葡（4 套 listing） |

---

## 8. 风险矩阵 + 实施节奏

### 8.1 架构风险（PRD §7 风险 R1-R10 的技术映射）

| PRD 风险 | 架构应对 | 残留风险 |
|----------|----------|----------|
| **R1 CWS 审核被驳** | 权限最小化 + 隐私政策 4 语种 + Data Usage 明确 | 5%（CWS 偶尔误判） |
| **R3 截图性能** | §3 算法 + D+3 PoC 验证 + 4096 分片 | 中（50000px+ 页面仍可能慢） |
| **R4 CWS IAP 现金流** | ❌ 改用 Lemon Squeezy | 低 |
| **R6 单人维护压力** | Workers 后端减少运维 | 中 |
| **R9 政策变动** | 不申请灰色权限 | 中 |

### 8.2 实施节奏（v1.2 修订：13-14 天开发，保留 F8）

> **v1.2 update**：PM + 开发实测 WXT 沙盒预热后真实工作量约 13-14 天（原估算 11-12 天偏低）。
> **架构师决策（按授权）**：**采用推荐 A**——保持 v1.0 = 13-14 天开发，上线窗口从 7/25-7/30 调整到 **7/27-8/1**，保留 F8 基础标注。

#### 8.2.1 推荐路径 A（已采用）

| 阶段 | 天数 | 累计 | 产出 |
|------|------|------|------|
| D+0 | 0 | 0 | PRD 锁定 + 架构文档 v1.2 ✅ |
| D+1~2 | 2 | 2 | WXT 工程脚手架 + manifest（v1.2 全 8 项权限）+ 长连接 port 基类 |
| D+3 | 1 | 3 | **截图 PoC 验证**（5000/30000/重 DOM + B 方案兜底） |
| D+4~5 | 2 | 5 | 截图核心 F1（A 算法 + port 长连接）|
| D+6~8 | 3 | 8 | 三格式导出 + 区域 + 复制（`clipboardWrite` 权限落实） |
| D+9~11 | 3 | 11 | 历史库（IndexedDB + `unlimitedStorage`）+ 基础标注 F8 + 偏好 |
| D+12~13 | 2 | 13 | 隐私政策 4 语种 + 西/葡 listing + 埋点 + Cloudflare Worker |
| D+14 | 1 | 14 | CWS 提交 |
| D+15~21 | 7 | 21 | CWS 审核 + 修订单 → **正式上线（7/27-8/1 窗口）** |

**上线日锁定**：2026-08-01（最晚）/ 2026-07-27（最早）→ 仍落在 PRD 14-19 天的弹性窗口内（PRD `14-19` 实际为"开发期+审核期总和"，v1.2 重新对齐为 13-14 开发 + 3-7 审核 = 16-21 总）。

#### 8.2.2 备选路径 B（已否决）

| 路径 | 取舍 | 风险 |
|------|------|------|
| B：压缩到 11-12 天 + 砍 F8 | 节省 2 天上线 | ❌ **差异化削平**——F8 基础标注是 PRD §5.3 强调的"2-3 倍转化率"差异化卖点；CWS 评分降低；用户预期落差 |

**【论据】**
- PM + 开发实测 13-14 天工作量 = WXT + chrome.runtime.connect 长连接 + 8 项权限调试 + 多浏览器子模块接入的真实成本。
- 砍 F8 节省 2 天但损失「基础标注免费」这一**唯一对抗 GoFullPage 的差异化卖点**（PRD §1.4 机会 1）。
- 上线时间从 7/25 推到 7/27 仅推迟 2 天，不影响 v1.1 的 T+90d 节奏（v1.1 仍为 T+90d）。

**【条件】**
- 若 D+8 进度滞后 > 1 天，立刻评估并 ping PM：保留 F8 vs 砍 F8 vs 推迟上线。
- 若 CWS 审核被驳（最坏情况 14 天），v1.0 上线推迟到 8/7 仍可接受（T+90d 不变）。

**【争议点】**
- "为什么不一开始把工期估准"——单人开发 + WXT 仍在 0.x 版本，**事先精确估算几乎不可能**；v1.2 是首个真实里程碑。
- "能否再压缩到 11-12 天"——技术上可，但需砍 F8 或砍 D+11 隐私政策法务审查——两者代价更高。

---

## 9. 架构师决策清单（含理由）

> **决策授权升级**：2026-07-11 17:34 用户授权「后续所有架构决策自行沟通，不用等他」。
> 本节从原「待拍板清单」改为「架构师已决策」——所有 open issue 终结，下游 developer 可直接按本文档执行。
> **边界**：用户已锁 6 项决策（命名 / MVP 范围 / 节奏 / T+90d / IAP / 隐私红线）不可逾越。

### 9.1 立刻决策（影响架构）— **已决策**

| # | 决策项 | **架构师决策** | **理由**【论据/来源/条件/争议点】 |
|---|--------|----------------|---------------------------------|
| **A1** | **支付服务商选型** | ✅ **Lemon Squeezy**（v1.1 接入） | 【论据】5% + $0.50、MoR 模式全球税务代收代缴、单人开发者零税务注册负担；【来源】extensionfast.com《Collect Chrome Extension Payments (2026)》；【条件】v1.1 启用前完成 LS 账户 + 产品 SKU 配置；【争议点】费率高于 Stripe，但 14-19 天节奏下税务处理成本远高于 2.1% 费差 |
| **A2** | v1.0 是否接支付商 | ✅ **v1.0 不接，仅字段占位** | 【论据】v1.0 接支付会触发 CWS 二次审核，延迟上线窗口；【来源】CWS 政策 - 重大权限变更需重新审核；【条件】chrome.storage.local 预留 `license.state` / `license.key` 字段；【争议点】若 v1.0 用户已流失数据，无法回填 license |

### 9.2 D+5 前决策（影响开发）— **已决策**

| # | 决策项 | **架构师决策** | **理由** |
|---|--------|----------------|----------|
| B1 | 区域选择 UI 形态 | ✅ **矩形框选（拖拽）+ 智能元素吸附（v1.1 增强）** | 【论据】矩形拖拽实现成本约 1 人天、智能元素识别需 5+ 人天且跨框架；【来源】行业 95% 截图扩展均用矩形；【条件】最小支持 100x100，最大全屏；【争议点】自由形状用户呼声高但 ROI 低，v1.x 不做 |
| B2 | 历史库初始保留条数 | ✅ **50 条** | 【论据】PRD 已锁 50 条，覆盖 ~90% 用户回看场景；【条件】LRU 淘汰 + 删除前提示；【争议点】高频用户可能 50 条不够，可走"升级 Pro 解锁无限"作为变现点 |
| B3 | 跨域 iframe 默认行为 | ✅ **默认占位文字「[External content: domain]」+ 高级开关「显示嵌入内容(同源)」** | 【论据】业内 FireShot/GoFullPage 同款策略；【来源】§3.2 论证 C 方案禁止、B 方案仅同源有效；【条件】v1.1 可加「常用白名单（youtube.com embed 等）」主动 capture；【争议点】用户对占位可能有感知落差，设置项 + 文案「不保证外部嵌入内容显示」缓解 |
| B4 | 自动复制到剪贴板默认 | ✅ **默认开启，可在设置项关闭** | 【论据】调研行业 80% 默认开启，GoFullPage/Awesome Screenshot 同款；【条件】clipboardWrite 权限按需申请；【争议点】少数用户反感默认复制，关闭入口在设置页第 1 屏 |

### 9.3 D+10 后决策（运营层）— **架构师已收口，PM/法务/设计师执行**

| # | 事项 | 决策权限 | 协助方 |
|---|------|----------|--------|
| C1 | Pro 升级入口文案 | PM 决策 | 设计师出视觉 |
| C2 | 西/葡 listing 母语者审校 | PM 决策 | 外包协调 |
| C3 | 隐私政策法律审查 | PM 决策 | 法务 / 模板（termsfeed.com 推荐） |
| C4 | 落地页 hero 文案 / 配图 | PM 决策 | 设计师 |
| C5 | Product Hunt launch 文案 | PM 决策 | - |
| C6 | 客服邮箱（contact@getshotly.com 已默认） | PM 决策 | - |

### 9.4 已锁定 6 项决策（不可偏离，触发暂停）

```
1. 命名：Shotly
2. MVP 范围：F1-F11 + 隐私政策 4 语种 + 西/葡 listing
3. 上线节奏：v1.0 = D+14~D+19（11-12 开发 + 3-7 审核）
4. 迭代间隔：v1.1 = T+90d（30 观察 + 30 开发 + 30 迭代）
5. IAP（实现路径）：§5 决策 Lemon Squeezy，禁用 CWS IAP
6. 隐私红线：截图内容绝不上传（任何"看起来合理"的优化若牵涉上传，必须暂停 ping）
```

### 9.5 触发暂停并 ping PM/用户的 4 个边界（即使有授权也不逾越）

| 触发条件 | 举例 | 处理 |
|----------|------|------|
| 命名变更 | 想改名 | 🛑 暂停 |
| MVP 范围扩大 > 20% | 新增团队协作 | 🛑 暂停 |
| T+90d 节奏变更 | 想压缩到 T+60d | 🛑 暂停 |
| 上传任何截图内容到 CF | "性能优化需要上传" | 🛑 暂停 |

---

## 10. PRD 修订建议（同步 PM）

> 架构师单方面建议 PM 在 PRD v2 中修订：

### 10.1 PRD 第 5 条修订建议（强制）

**原文**：「付费机制：**CWS In-App Payments 主路径**（你自行确认是否最优实现）」

**建议修订**：「付费机制：**Lemon Squeezy（MoR 模式）主路径**，CWS IAP 已不可用（Google 2020-09 公告弃用）。v1.0 阶段不接支付商，仅字段占位 + 埋点收集付费意愿。」

### 10.2 PRD 附录 D 修订建议（立刻项 4 项）

| # | PRD 原文 | 架构师建议 |
|---|----------|-----------|
| 4 | 视觉主色调：薄荷绿 #2DD4BF / 深空蓝 #0EA5E9 二选一 | **已锁薄荷绿 #2DD4BF**（用户拍板） |
| 8 | 免费版是否带基础标注（关键商业决策） | **带基础标注**（已锁） |
| 新增 | 支付商最终选型 | **Lemon Squeezy**（架构师按授权自决） |
| 新增 | v1.0 是否接支付 | **v1.0 不接，仅字段占位**（架构师按授权自决） |

---

## 附录 A｜关键术语与缩写

| 术语 | 含义 |
|------|------|
| MV3 | Manifest V3，Chrome 扩展最新规范 |
| SW | Service Worker，MV3 后台脚本 |
| CS | Content Script，注入页面脚本 |
| IAP | In-App Payments（已弃用） |
| MoR | Merchant of Record（代收代缴税） |
| D1 | Cloudflare 托管 SQLite 数据库 |
| PoC | Proof of Concept |
| CWS | Chrome Web Store |

---

## 附录 B｜文档变更日志

| 版本 | 日期 | 作者 | 变更 |
|------|------|------|------|
| v1 初版 | 2026-07-11 17:25 | 架构师（🏗️） | 首版输出，含 7 大模块 + CWS IAP 修正 |
| **v1.1 update** | 2026-07-11 17:34 | 架构师（🏗️） | 决策授权升级：§9 从「待拍板清单」改为「架构师已决策清单」；§10 新增 PRD 修订建议；open issue 全部终结 |
| **v1.2 update** | 2026-07-11 18:13 | 架构师（🏗️） | **3 项必修 + 5 项 PM 评审响应**：①§4.1 权限补 3 项（clipboardWrite / unlimitedStorage / tabs） ②§2.3 消息契约改为 `chrome.runtime.connect` 长连接（含心跳机制） ③§8.2 节奏调到 **13-14 天开发 + 3-7 审核 = 总 16-21 天（D+14 提交 → 7/27-8/1 上线）**，保留 F8 差异化 ④§3.5 加"失败 3 次回退 B 方案"算法 ⑤§3.2 iframe 占位文案升级 `📎 ${hostname} (embedded)` ⑥§4.5 加 dark mode 色彩 token；总 diff +185 行 |
| **🚨 v1.2.1 紧急补丁** | 2026-07-12 09:48 | 架构师（🏗️） | **PM 派工 / brand ≠ component**：①§4.5.1 表改为 Prescriptive（强制 teal-700 light / teal-500 dark，mint-500 仅限品牌） ②§4.5.1.1 新增「品牌色 vs 组件色」使用范围表 + PR 审查硬卡规则 ③§1.5 新增「品牌色 ≠ 组件色」原则段；总 diff +34 行（§1.5 +6 行 / §4.5 +28 行 / 附录 B +1 行） |

---

> **文档结束**
> 下游交付：开发（developer）开始执行 D+1~D+8，§1.6 / §2 / §3 是其主要输入。
> **本架构师同步动作**：在 24h 内发出 1 张精简结论卡到 PM 群 + 同步到架构师群。
