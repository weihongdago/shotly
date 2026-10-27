# S2: 超长页 + 高 DPR 场景（Notion 风格工作区）

## 目的
验证 pipeline 在高 DPR + 多 segment 场景下的性能与稳定性。

## 目标页面
- **在线**：https://www.notion.so/examples（≈ 25_000 ~ 35_000px）
- **本地 fixture**：`fixtures/02-notion-mock.html`（30_000px 占位页，DPR 模拟 2）

## 预期性能
| 指标 | 期望 | 实际 |
|------|------|------|
| 页面总高 | 25_000 ~ 35_000px | ___ |
| viewport | 1280×720 (DPR=2) | ___ |
| Segment 数 | 7 ~ 9（30000 ÷ 4096） | ___ |
| 单段耗时 | 1.8 ~ 2.5s（scroll + 1.5s buffer + capture） | ___ |
| 总耗时 | < 30s（MV3 SW idle 阈值内） | ___ |
| 输出尺寸 | ~2560 × 60000 **设备像素**（CSS 页面 1280×30000，DPR=2 已内嵌到 dataUrl） | ___ |
| 文件大小 | 1 ~ 4 MB PNG | ___ |
| 内存峰值 | ~25MB OffscreenCanvas | ___ |

## 验证清单

- [ ] **不触发 SW idle-kill**：> 30s 仍存活（心跳工作）
- [ ] **进度条更新**：popup 进度条 1/8 → 2/8 → ... → 8/8 流畅
- [ ] **拼接正确**：高 DPR 文字清晰，无锯齿加重
- [ ] **图片不重复**：lazy 图片在对应段一次渲染（不跨段重复）
- [ ] **无 OOM**：DevTools Memory 不爆，OffscreenCanvas 不被 kill
- [ ] **完成时心跳**：popup 关掉后 SW 在 30s 内仍存活（验证用）

## 风险点
- **SW idle kill**：30s 不活动会被 Chrome 杀掉。我们的 20s 心跳（bg + popup）+ 25s（content）必须正确发包。
- **大 Canvas OOM**：30_000 × 1280 × 4 bytes ≈ 147 MB。架构 §3.1 已锁定 ≤50_000px 上限，本场景远低于上限。
- **PNG 编码慢**：convertToBlob 可能耗时 5-10s。这是正常现象，不要误判为失败。

## 监控埋点
```js
// 应该在 SW 看到至少 1-2 次心跳（如果是 30s 任务）
[shotly:bg] port screenshot-port (content) disconnected
```

## 失败兜底
- 如果 30s 内未完成 → 看 SW 是否被 kill：
  ```bash
  chrome://extensions/ → Shotly → "Service Worker" 状态
  ```
- 如果 OOM → 降低 DPR 测试（用 DPR=1 看是否能跑通）
- 如果某段卡住 → 在 console 执行：
  ```js
  chrome.runtime.sendMessage(extensionId, {type: 'screenshot:cancel'})
  ```

## 回归用例

```json
{
  "scenario": "S2",
  "url": "https://www.notion.so/examples",
  "capturedAt": "<ISO timestamp>",
  "tab": { "width": 1280, "height": 720, "dpr": 2 },
  "page": { "totalHeight": 30000 },
  "segments": 8,
  "durationMs": 27500,
  "output": { "width": 2560, "height": 60000, "byteSize": 2400000 },
  "method": "A",
  "retries": 0,
  "events": [
    "screenshot.full.start",
    "screenshot.full.chunk",  // ×8
    "screenshot.full.done"
  ]
}
```