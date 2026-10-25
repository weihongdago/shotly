# S5: 极端边界 + dark mode + web font 场景

## 目的
三合一极端场景：
- (a) 接近 50_000px 上限的页面（验证 OOM 边界）
- (b) 超 50_000px 拒绝逻辑（架构 §3.6）
- (c) dark mode 页面（薄荷绿 #2DD4BF 边框在深色背景上的对比度）
- (d) web font 加载延迟（编排缓冲覆盖）

## 子场景 5a：49_500px 极限页

### 目标
- 本地 fixture：`fixtures/05-extreme-49k.html`（49_500px 占位页）

### 预期行为
| 指标 | 期望 | 实际 |
|------|------|------|
| 页面总高 | 49_500px | ___ |
| viewport | 1280×720 (DPR=1) | ___ |
| Segment 数 | 13（49500 ÷ 4096 ≈ 12.08） | ___ |
| 总耗时 | < 60s | ___ |
| 内存峰值 OffscreenCanvas | ~242MB | ___ |
| 是否完成 | ✅ | ___ |

### 验证清单
- [ ] 不触发 Chrome OOM-kill
- [ ] 拼接完整
- [ ] popup 显示「✅ 完成」
- [ ] 控制台 `[shotly:offscreen] stitcher initialized 1280×49500 (~241.7 MB)`

## 子场景 5b：50_001px 拒绝

### 目标
- 本地 fixture：`fixtures/05-extreme-50k.html`（50_001px 占位页）

### 预期行为
- popup 显示 ❌ 错误：`Page too long: 50001px > 50000px limit`
- **不**触发任何 capture
- **不**初始化 OffscreenCanvas
- console 收到 `screenshot:too-long` 事件

### 验证清单
- [ ] popup 错误提示准确（不是 stack trace）
- [ ] 没有 chrome.tabs.captureVisibleTab 调用
- [ ] 没有 offscreen 通信
- [ ] 不会卡住（用户可重试）

### 设计意图
架构 §3.6 锁定 50_000px 是为了让 1920×50_000 RGBA = 384MB 接近 Chrome offscreen doc 的内存上限。再大必然 OOM。**主动拒绝**比 **静默失败** 更专业。

## 子场景 5c：dark mode 页面

### 目标
- 在线：GitHub Dark（https://github.com/settings/profile?theme=dark 或类似）
- 本地 fixture：`fixtures/05-dark-mode.html`

### 预期
- 截图保留页面的 dark mode 样式（`color-scheme: dark`）
- iframe placeholder 在深色背景上仍清晰可读（薄荷绿 #2DD4BF 对比度 WCAG AA）
- 拼接白色背景仅出现在 iframe 占位 + fixed 隐藏区域，正文区应是深色

### 验证清单
- [ ] 主体背景是深色（不是白）
- [ ] 占位 div 边框 + 文字可读
- [ ] 无意外的亮色填充（canvas fillStyle #FFFFFF 仅在 init 时，不覆盖后续 drawImage）

## 子场景 5d：web font 加载延迟

### 目标
- 本地 fixture：`fixtures/05-web-font-delay.html`（Google Fonts 引入 + FOIT/FOUT 触发）

### 预期
- 1.5s buffer 覆盖字体加载（架构 §3.3）
- 截图时文字是最终字体（不是 fallback）

### 验证清单
- [ ] 文字字体与未截图页面一致
- [ ] 没有字体回退（fallback）残影

## 跨子场景：失败模式清单

| 失败 | 表现 | 修复方向 |
|------|------|----------|
| OOM kill | offscreen 静默断连 | 降低 canvas 尺寸 or 警告用户 |
| 拒绝信息不清 | 报 stack trace | 提升错误文案 |
| dark mode 被覆盖 | 截图变白 | 检查 `fillRect` 时机 |
| web font fallback | 文字不是设计字体 | buffer 提升到 3s |

## 回归用例（5a）

```json
{
  "scenario": "S5a",
  "fixture": "05-extreme-49k.html",
  "capturedAt": "<ISO timestamp>",
  "page": { "totalHeight": 49500 },
  "segments": 13,
  "durationMs": 52000,
  "memoryMb": { "offscreenCanvas": 242 },
  "output": { "width": 1280, "height": 49500, "byteSize": 12000000 },
  "method": "A",
  "completed": true
}
```

## 回归用例（5b）

```json
{
  "scenario": "S5b",
  "fixture": "05-extreme-50k.html",
  "capturedAt": "<ISO timestamp>",
  "page": { "totalHeight": 50001 },
  "rejected": true,
  "errorShownToUser": "Page too long: 50001px > 50000px limit",
  "noCaptureCalled": true,
  "noOffscreenInit": true
}
```