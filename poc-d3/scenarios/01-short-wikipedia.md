# S1: 短页标准场景（Wikipedia 主页）

## 目的
验证 pipeline 在最常见场景下稳定工作：~5_000px 标准 DPR 页面，单 segment 完成。

## 目标页面
- **在线**：https://en.wikipedia.org/wiki/Web_browser
- **本地**：`fixtures/01-wikipedia.html`（离线副本，D+3 用此测）

## 预期性能
| 指标 | 期望 | 实际 |
|------|------|------|
| 页面总高 | 4_500 ~ 5_500px | ___ |
| viewport | 1280×720 (DPR=1) | ___ |
| Segment 数 | 2（5000 ÷ 4096） | ___ |
| 总耗时 | < 15s | ___ |
| 输出尺寸 | ~1280 × 5000px | ___ |
| 文件大小 | 200 ~ 800KB PNG | ___ |

## 验证清单

- [ ] **拼接正确**：从顶到底完整无错位，无横向条纹
- [ ] **fixed 元素隐藏**：顶部导航条、悬浮目录不重复出现
- [ ] **图片完整**：所有 `<img>` 渲染完成（无 placeholder）
- [ ] **背景色**：白色背景连续，无透明条纹
- [ ] **首尾像素**：顶/底 1px 行内容正确
- [ ] **下载按钮**：popup 显示「✅ 完成」+ 下载可用
- [ ] **无 console error**：SW / content / offscreen 无红色错误

## 失败兜底（如果失败）
1. 打开 SW 控制台：`chrome://extensions/` → Shotly → Service Worker → 检查
2. 关键日志：
   ```
   [shotly:bg] service worker booted
   [shotly:content] script injected
   [shotly:offscreen] script booted
   [shotly:offscreen] offscreen document ready
   [shotly:offscreen] stitcher initialized 1280×4920 (~24.0 MB)
   [shotly:content] capture done: 2 chunks
   ```
3. 缺哪行 → 看对应模块 README 排查

## 回归用例
跑测同时记录以下数据用于回归 baseline：

```json
{
  "scenario": "S1",
  "url": "https://en.wikipedia.org/wiki/Web_browser",
  "capturedAt": "<ISO timestamp>",
  "tab": { "width": 1280, "height": 720, "dpr": 1 },
  "page": { "totalHeight": 4920, "scrollHeight": 4920 },
  "segments": 2,
  "durationMs": 12500,
  "output": { "width": 1280, "height": 4920, "byteSize": 458000 },
  "method": "A",
  "retries": 0,
  "events": ["screenshot.full.start", "screenshot.full.chunk", "screenshot.full.chunk", "screenshot.full.done"]
}
```