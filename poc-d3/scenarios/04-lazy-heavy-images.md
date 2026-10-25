# S4: 懒加载重图页场景（Pinterest / 瀑布流）

## 目的
验证懒加载图片在截图前正确就位（架构 §3.3 — `primeLazyImages` + 1500ms buffer）。

## 目标页面
- **在线**：https://www.pinterest.com/ （懒加载 + 瀑布流 + 200+ img）
- **本地 fixture**：`fixtures/04-pinterest-mock.html`（200 张 1x1 占位图 + `loading="lazy"`）

## 预期行为

### 懒加载处理
- [ ] `loading="lazy"` 全部改为 `loading="eager"`
- [ ] IntersectionObserver-driven 懒加载（无 native attr）通过 1.5s buffer 覆盖
- [ ] 截图前 `document.body.getBoundingClientRect()` 触发 reflow

### 拼接验证
- [ ] 所有图片位置正确渲染（无空白 placeholder）
- [ ] 图片不跨段重复出现（避免一次截图多次）
- [ ] 不存在图片跨段拼接缝（segment 边界正好在两张图之间）

## 预期性能
| 指标 | 期望 | 实际 |
|------|------|------|
| 页面总高 | 8_000 ~ 15_000px | ___ |
| img 数量 | > 200 | ___ |
| 懒加载 img 数 | > 180 | ___ |
| 单段耗时 | 1.8 ~ 3.0s（含 buffer） | ___ |
| 总耗时 | < 35s | ___ |

## 风险点

1. **图片未加载完成**：1500ms buffer 可能不够（极慢 CDN）
   - 缓解：retry 3 次（D+2 capture-fallback 集成后生效）
2. **图片在滚动后才 fetch**：scroll → 1500ms 后 capture 的 race
   - 缓解：`primeLazyImages()` 强制 eager + reflow
3. **高 DPR 下图片巨大**：每段 PNG 可能 5MB+，总输出 30MB+
   - 缓解：架构 §3 锁定 PNG，可改 JPEG（v1.1）

## 验证脚本

```js
// 截图前 console 跑
let lazyImgs = document.querySelectorAll('img[loading="lazy"]')
console.log('lazy before:', lazyImgs.length)
// 期望：> 0（页面原始 lazy 数量）

// 跑 capture 后（截图结束后 iframe 已 restore）
lazyImgs = document.querySelectorAll('img[loading="lazy"]')
console.log('lazy after:', lazyImgs.length)
// 注意：primeLazyImages 只在 capture 期间改，restore 不还原
// 所以这个数字应该接近 0
```

## 失败兜底

- 图片空白 → 增加 buffer 到 3000ms（临时改 `PER_SEGMENT_BUFFER_MS`）
- 大量图片 404 → fixture 用本地 base64 占位图代替
- scroll 后图片仍未 fetch → `primeLazyImages` 之外需要更激进的策略

## 回归用例

```json
{
  "scenario": "S4",
  "fixture": "04-pinterest-mock.html",
  "capturedAt": "<ISO timestamp>",
  "page": {
    "totalHeight": 12000,
    "totalImages": 240,
    "lazyImages": 220,
    "primedByShotly": 220
  },
  "segments": 3,
  "durationMs": 32000,
  "output": { "width": 1280, "height": 12000, "byteSize": 8200000 },
  "method": "A",
  "bufferMs": 1500
}
```