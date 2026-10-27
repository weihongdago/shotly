# D+3 PoC 预期产物清单（PASS 判定标准）

> **版本**：D+4 修订 (2026-10-27) · **作者**：开发工程师 👨‍💻
> **配套**：[README.md](./README.md) / `scenarios/*.md` / [architecture.md §3.6](../../architecture.md)
> **跑测命令**：`cd test-infra && pnpm test:e2e:poc-d3`

本文件是**判卷标准**：每个场景列出「必须成立的断言」，自动化断言全部
基于**像素**（逐横向带统计非白像素比例 / 指定颜色像素计数 / 像素签名
对比），不看 byteSize。

> ⚠️ **为什么不能只看文件大小**
> 拼接几何算错时 `drawImage` 会**静默失败**，画出一张纯白 PNG。纯白图
> 仍然有 100KB+，任何只看 byteSize 的断言都会通过 —— 2026-10-26
> 实际踩中过：E2E 全绿，产物是空白图。

---

## 📐 判定口径

| 指标 | 含义 | 判定阈值 |
|------|------|----------|
| `uniqueColors` | 整图去重后的颜色数 | > 3（否则几乎纯色） |
| `nonWhiteRatio` | 非白像素占比 | > 0.005（否则几乎全白） |
| 横向带 | 每 400px 切一条带，统计该带非白占比 | 带内 < 0.5% 判为**空带** |
| 颜色命中 | 指定颜色的像素计数 | 见各场景 |
| 像素签名 | 区域二值化后的墨迹指纹 | 见 S5d |

**空带必须为 0** —— 任何一条空带都意味着拼接漏了一段（错位、漏截或
画布比内容高出一截）。这是最灵敏的指标：2026-10-27 S2 失败时正是
它报出了「最后 3 条带是空的」，根因是画布按错误的 DPR 算高，多出
~2_900px 的白尾巴。

---

## S1 · 短页标准场景（Wikipedia）

| 项 | 值 |
|----|----|
| fixture | `fixtures/01-wikipedia.html` |
| 在线目标 | https://en.wikipedia.org/wiki/Web_browser |
| DPR | 1 |

| # | 断言 | 自动化 | 人工 |
|---|------|--------|------|
| 1 | 捕获完成，popup 显示「✅ 完成」+ 下载按钮可用 | ✅ | ☐ |
| 2 | 输出高度 = 页面总高（±1 屏） | `height > pageHeight` | ☐ |
| 3 | 输出宽度 = CSS 视口宽（× DPR） | `width ≈ 1280 × DPR` | ☐ |
| 4 | 无空带 | `emptyBands == []` | ☐ |
| 5 | 颜色数 > 3、非白占比 > 0.5% | ✅ | ☐ |
| 6 | fixed/sticky 元素只出现一次，不重复 | ✖（人工） | ☐ |
| 7 | 无 console error（SW / content / offscreen） | ✖（人工） | ☐ |

**PASS 判据**：自动化 1–5 全绿 + 人工 6–7 通过。

---

## S2 · 超长页 + 高 DPR（Notion 风格）

| 项 | 值 |
|----|----|
| fixture | `fixtures/02-notion-mock.html`（30_000 CSS px） |
| DPR | 2（独立 context，见下） |

> ⚠️ 高 DPR **必须用独立浏览器 context**：`deviceScaleFactor` 在
> `launchPersistentContext` 时定死，运行中改不了。测试代码用
> `launchShotly({ deviceScaleFactor: 2 })` 起一个独立实例。

| # | 断言 | 自动化 | 人工 |
|---|------|--------|------|
| 1 | 输出宽度 = CSS 宽度 × 2（**设备像素**，非降采样） | `width > 2400`（实测 2560） | ☐ |
| 2 | 输出高度 = 30_000 × 2 = 60_000 设备像素 | `height > 25_000`（实测 60_000） | ☐ |
| 3 | 150 条横向带**全部有内容** | `emptyBands == []` | ☐ |
| 4 | 颜色数 > 3、非白占比 > 0.5% | ✅ | ☐ |
| 5 | 高 DPR 下文字清晰（不被降采样成糊边） | ✖（人工） | ☐ |
| 6 | MV3 SW 不被 idle-kill（长任务全程存活） | ✅（任务能跑完即证明） | ☐ |
| 7 | 总耗时可接受 | 实测 ≈ 178s（自动化）/ 目标 < 60s（人工优化后） | ☐ |

**PASS 判据**：自动化 1–4 全绿 + 人工 5–6 通过。

> 📌 **实测记录 (2026-10-27)**：`outputWidth 2560 · outputHeight 60000 ·
> byteSize 37.9MB · uniqueColors 1387 · nonWhiteRatio 0.311 ·
> 150 带全有内容 · 178s`。
> 耗时高于 architecture 的 60s 目标 —— 每个视口切片固定等 1.5s buffer
> × 38 切片 ≈ 57s 是主要开销，属性能优化项（v1.1），不是正确性缺陷。

---

## S3 · 跨域 iframe 占位

| 项 | 值 |
|----|----|
| fixture | `fixtures/03-iframe-mix.html`（5 跨域 + 2 同源） |
| 辅助 | `fixtures/06-same-origin.html` |

| # | 断言 | 自动化 | 人工 |
|---|------|--------|------|
| 1 | 占位块薄荷绿左边条 `#2DD4BF` 出现在最终 PNG 里 | `colorHits['#2DD4BF'] > 50` | ☐ |
| 2 | 同源 iframe 的真实内容被保留（徽章 `#DAFBE1`） | `colorHits['#DAFBE1'] > 0` | ☐ |
| 3 | 输出高度 > 一屏 | ✅ | ☐ |
| 4 | 无空带（占位块尺寸匹配原 iframe box，不破坏文档流） | `emptyBands == []` | ☐ |
| 5 | 颜色数 > 3 | ✅ | ☐ |
| 6 | 占位文本含 `📎` + hostname + `(embedded)` | ✖（DOM 断言，见 scenario 03） | ☐ |
| 7 | 截图**后** iframe 已复原（`restoreIframes` 生效） | ✖（人工） | ☐ |

**PASS 判据**：自动化 1–5 全绿 + 人工 6–7 通过。

> 📌 跨域判定按 **URL origin** 比对，不用 `contentDocument` 抛错来判：
> 未加载完的跨域 iframe 仍暴露 `about:blank`，`contentDocument` 访问
> **成功** → 旧实现把它当同源 → 截图里留下空洞且**零报错**。

---

## S4 · 懒加载重图页（Pinterest 瀑布流）

| 项 | 值 |
|----|----|
| fixture | `fixtures/04-pinterest-mock.html`（200 块渐变砖） |

| # | 断言 | 自动化 | 人工 |
|---|------|--------|------|
| 1 | 输出高度 > 一屏 | ✅ | ☐ |
| 2 | 颜色数 > 10（渐变砖是彩色的，纯白图过不了） | ✅ | ☐ |
| 3 | **无空带**（懒加载图全部就位） | `emptyBands == []` | ☐ |
| 4 | **无弱带**（每条带的非白占比 > 2%） | `weakBands == []` | ☐ |
| 5 | 图片不跨段重复 | ✖（人工） | ☐ |

**PASS 判据**：自动化 1–4 全绿 + 人工 5 通过。

---

## S5 · 极端边界（拆成 4 个可独立判定的子场景）

### S5a · 49_500px 接近上限

| # | 断言 | 自动化 |
|---|------|--------|
| 1 | 输出高度 > 45_000（覆盖整页） | ✅ |
| 2 | 无空带 | `emptyBands == []` |
| 3 | 颜色数 > 3、非白占比 > 0.5% | ✅ |
| 4 | sticky 条在整图里只出现一次 | ✖（人工） |

### S5b · 50_001px 超限拒绝（DPR=1）

| # | 断言 | 自动化 |
|---|------|--------|
| 1 | 捕获**明确失败**（不是静默产出空白图） | `status == 'error'` |
| 2 | 错误信息含 "too long" | `/too long/i` |
| 3 | **零捕获副作用**：没有 offscreen 初始化、没有 `captureVisibleTab` | `swLogs == []` |

### S5c · dark mode

| # | 断言 | 自动化 |
|---|------|--------|
| 1 | 输出高度 > 一屏 | ✅ |
| 2 | 非白占比 > 0.5（深色背景**保持住了**，没被白底覆盖） | ✅ |
| 3 | 无空带 | `emptyBands == []` |

### S5d · web font 延迟加载

| # | 断言 | 自动化 |
|---|------|--------|
| 1 | 两行字都有墨迹 | `inkRatio > 0.01`（两行都要） |
| 2 | 两行**像素签名不同**（第一行用 webfont、第二行强制 serif） | 签名不相等 |
| 3 | 截图完成 | `status == 'done'` |

> 📌 S5d 的签名必须在 popup 还活着时取 —— blob URL 随 popup 卸载被
> `revoke`，事后取不到。

### S5 的 DPR 边界（架构 §3.6 补充）

拼接画布按**设备像素**创建，而 Chrome 单张画布最大 **65_535px**
（实测，见 `test-infra/probe-canvas-limits.mjs`）。所以页面上限是：

```
maxCssHeight = min(50_000, ⌊65_535 / DPR⌋)
```

| DPR | 页面上限（CSS px） | 说明 |
|-----|--------------------|------|
| 1 | 50_000 | 架构硬上限 |
| 2 | 32_767 | 画布尺寸上限反推 |

DPR=1 下合法的 50_000px 页，在 Retina（DPR=2）上会被**提前拒绝**，
提示里写明原因（`…would exceed Chrome's 65535px limit (max 32767px)`）。

---

## 📊 跑测记录

自动化跑完后把报告贴到 PM 群：

```
[POC-D3] 5 场景回归完成
- 报告：test-infra/reports/poc-d3/poc-d3-report.json
- 日志：test-infra/reports/poc-d3/poc-d3-logs.txt
- 结果：S1 ✅ / S2 ✅ / S3 ✅ / S4 ✅ / S5a ✅ / S5b ✅ / S5c ✅ / S5d ✅
```

`poc-d3-report.json` 每个场景一条，字段：

```jsonc
{
  "scenario": "S2",
  "fixture": "02-notion-mock.html",
  "pageHeight": 60000,      // 输出高度（设备像素）
  "outputWidth": 2560,      // 输出宽度（设备像素）
  "outputHeight": 60000,
  "byteSize": 37922838,
  "uniqueColors": 1387,
  "nonWhiteRatio": 0.311,
  "bands": 150,
  "emptyBands": [],         // 必须为空
  "durationMs": 178128,
  "notes": ["DPR=2，150 个横向带全有内容"]
}
```

**任何一条 `emptyBands` 非空 = 该场景 FAIL** —— 哪怕其他数字都好看。
