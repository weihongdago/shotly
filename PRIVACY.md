# Shotly 隐私政策 / Privacy Policy

**最后更新 / Last updated:** 2026-10-25
**适用版本 / Applies to:** Shotly v1.0 (Chrome extension)

---

## 中文

### 一句话总结
**Shotly 不会把你的截图上传到任何服务器。所有截图只存在于你自己的设备上。**

### 1. 我们收集什么
**什么都不收集。**

Shotly 没有账号体系，没有埋点 SDK，没有分析服务，没有广告。
扩展不会向任何第三方服务器发送请求。

### 2. 截图数据存在哪
| 数据 | 存储位置 | 保留时间 |
|------|---------|---------|
| 截图图片 (Blob) | 浏览器 IndexedDB (本地) | 最多 50 条，超出自动淘汰最旧一条 |
| 截图元数据（来源 URL / 标题 / 尺寸 / 时间） | 同上，与图片一起 | 同上 |
| 用户偏好（界面语言选择） | `chrome.storage` (本地) | 永久，直到你卸载扩展 |

**来源 URL 与页面标题仅用于给你自己生成文件名和历史列表，不会离开设备。**

### 3. 权限说明
| 权限 | 用途 | 为什么必需 |
|------|------|-----------|
| `activeTab` | 在你点击扩展时读取当前页面 | 只有你主动触发时才作用于当前标签页 |
| `scripting` | 注入选区脚本 | 区域截图需要 |
| `offscreen` | 离屏画布拼接长图 | MV3 后台无法访问 DOM |
| `storage` | 保存界面语言选择 | 选「自动 / English / 中文」后下次打开仍生效 |
| `downloads` | 保存截图到本地磁盘 | 你的导出操作 |
| `clipboardWrite` | 复制截图到剪贴板 | 你的复制操作 |
| `unlimitedStorage` | 扩展 IndexedDB 容量 | 50 条长截图可能超过默认配额 |
| `tabs` | 读取当前标签页标题与 URL | 生成本地历史条目标题 |
| `<all_urls>` 主机权限 | 在任意网页上执行整页截图 | 这是截图工具的核心能力 |

### 4. 卸载即删除
卸载扩展后，扩展的 IndexedDB、`chrome.storage` 数据会由 Chrome 自动清除，不留残留。

### 5. 第三方服务
**没有。** 不使用 Google Analytics、Mixpanel、Amplitude、Segment、Sentry 或任何形式的遥测。

唯一的例外是 Chrome Web Store 的付费升级（v1.1 计划中），届时会由 Google 处理的支付流程，但支付信息不会经过 Shotly。

### 6. 儿童隐私
Shotly 不收集任何个人信息，因此不涉及儿童数据。

### 7. 联系方式
问题或顾虑：请在 [GitHub 提 issue](https://github.com/weihongdago/shotly/issues)（也见 [支持页面](https://weihongdago.github.io/shotly/support.html)）

---

## English

### One-line summary
**Shotly never uploads your screenshots to any server. Everything stays on your device.**

### 1. What we collect
**Nothing.**

Shotly has no accounts, no telemetry SDKs, no analytics services, and no ads. The extension makes no requests to third-party servers.

### 2. Where your data lives
| Data | Location | Retention |
|------|----------|-----------|
| Screenshot images (Blob) | Browser IndexedDB (local) | Up to 50 entries; oldest is evicted automatically |
| Screenshot metadata (source URL / title / dimensions / timestamp) | Same store, alongside the image | Same |
| Preferences (interface language choice) | `chrome.storage` (local) | Until you uninstall |

**The source URL and page title are used only to generate local filenames and history entries. They never leave your device.**

### 3. Permissions explained
| Permission | Why |
|------------|-----|
| `activeTab` | Read the current page only when you trigger the extension |
| `scripting` | Inject the region-selection script |
| `offscreen` | Offscreen canvas for stitching long images (MV3 workers have no DOM) |
| `storage` | Save your interface language choice |
| `downloads` | Save screenshots to your disk when you ask |
| `clipboardWrite` | Copy a screenshot to your clipboard when you ask |
| `unlimitedStorage` | Expand IndexedDB quota so 50 long screenshots fit |
| `tabs` | Read the current tab's title/URL for local history labels |
| `<all_urls>` | Capture any page — this is the core capability of a screenshot tool |

### 4. Uninstall deletes everything
When you uninstall the extension, Chrome removes its IndexedDB and `chrome.storage` data. Nothing is left behind.

### 5. Third-party services
**None.** No Google Analytics, Mixpanel, Amplitude, Segment, Sentry, or any other telemetry.

The only future exception is the Chrome Web Store upgrade flow planned for v1.1, which is processed by Google; payment details never pass through Shotly.

### 6. Children's privacy
Shotly collects no personal information, so children's data is never involved.

### 7. Contact
Questions or concerns: [open an issue on GitHub](https://github.com/weihongdago/shotly/issues) (see also the [support page](https://weihongdago.github.io/shotly/support.html))
