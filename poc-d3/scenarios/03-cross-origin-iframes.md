# S3: 跨域 iframe 占位场景

## 目的
验证架构 §3.2 — 跨域 iframe 被替换为占位 div（mint 左条 + 📎 + hostname）。

## 目标页面
- **在线**：嵌入 5+ 跨域 iframe 的文章（如：含 YouTube + Vimeo + Twitter embed 的 blog post）
- **本地 fixture**：`fixtures/03-iframe-mix.html`（5 跨域 iframe + 2 同源 iframe 混合）

## 预期行为

### iframe 处理
| 类型 | 处理方式 | 验证 |
|------|----------|------|
| 跨域 iframe（YouTube, Vimeo 等） | 替换为 placeholder div | [ ] |
| 跨域 placeholder 文本 | `📎 {hostname} (embedded)` | [ ] |
| placeholder 样式 | mint 左条 `#2DD4BF` 4px | [ ] |
| placeholder 尺寸 | ≥ 120×60px | [ ] |
| 同源 iframe | 保留原样（不替换） | [ ] |
| 空 src iframe | hostname 回退到 `inline-frame` 或 location.hostname | [ ] |

### 拼接验证
- [ ] 占位 div 周围无空白（尺寸匹配 iframe 原 box）
- [ ] 占位 div 不破坏文档流（后续内容位置正确）
- [ ] 占位 div 边框 + 圆角在 PNG 中可见
- [ ] 同源 iframe 内容在最终图中可见（递归拼接，v1.1 才做完全递归）

## 预期性能
| 指标 | 期望 | 实际 |
|------|------|------|
| 页面总高 | 3_000 ~ 6_000px | ___ |
| 跨域 iframe 数 | 5 | ___ |
| 同源 iframe 数 | 2 | ___ |
| 总耗时 | < 12s | ___ |

## 验证脚本（DevTools）

```js
// 在 content script 控制台跑，确认 placeholder 已安装
document.querySelectorAll('[data-shotly-placeholder]').length
// 期望：5

// 检查某个 placeholder 内容
document.querySelector('[data-shotly-placeholder]').innerHTML
// 期望：含 hostname + "📎" + "(embedded)"
```

## 关键日志
```
[shotly] capture start: N segments, 0 lazy images primed
[shotly] capture done: N chunks
```

注意：iframe placeholder 在 capture 前 install，capture 后 restore。所以截图**中**有 placeholder，截图**后**iframe 复原。

## 失败兜底
- iframe 没被替换 → `iframe-placeholder.ts` 安装失败，检查：
  ```js
  document.querySelectorAll('iframe').forEach(f => {
    try { void f.contentDocument } catch (e) { console.log('cross:', f.src) }
  })
  ```
- 跨域判定错误（happy-dom 下 `contentDocument` 行为可能不一致）→ fixture 用真跨域 URL

## 回归用例

```json
{
  "scenario": "S3",
  "fixture": "03-iframe-mix.html",
  "capturedAt": "<ISO timestamp>",
  "page": { "totalHeight": 4500, "iframes": 7, "crossOrigin": 5, "sameOrigin": 2 },
  "placeholders": {
    "expected": 5,
    "actual": 5,
    "styleCheck": { "borderLeft": "4px solid #2DD4BF", "bg": "#F4F4F5" }
  },
  "durationMs": 9800,
  "output": { "width": 1280, "height": 4500, "byteSize": 380000 },
  "method": "A"
}
```