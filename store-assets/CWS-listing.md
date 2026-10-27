# Chrome Web Store 上架材料｜Shotly v1.0

> 状态：**素材已就绪，待账号 + 提审**
> 阻塞项：开发者账号注册费 $5（需轰哥出账），域名 `getshotly.com`（不影响提审，但影响官网链接；隐私政策已用 GitHub Pages 顶上线）

---

## 1. 商品名称

**Shotly — Full Page & Region Capture**

（35 字符，Chrome Web Store 上限 45 ✅；原候选 `Shotly — Whole Page Screenshot & Region Capture` 是 47 字符，**超限**，已换）

## 2. 简短说明（Short description，132 字符上限）

```
Capture whole pages, not just the viewport. PNG, JPG & PDF export. Everything stays on your device — no upload, no tracking.
```
（124 字符，上限 132 ✅）

## 3. 详细说明（Detailed description，16000 字符上限）

```
Shotly captures what your browser window can't: the entire page, in one clean image.

▸ One click, whole page
GoFullPage-style scroll-and-stitch. Fixed headers, sticky elements and cross-origin iframes are handled automatically, so you get one continuous image instead of a repeating mess.

▸ Region capture
Drag a rectangle around exactly what you want. Minimum 100×100, up to the full page.

▸ Export your way
PNG for lossless quality, JPG for small file sizes, PDF when you need to share a document.

▸ Clipboard & history
One click to copy to your clipboard, or save into a local history library (last 50 shots, stored only on your device).

▸ Privacy is the feature
Shotly has no accounts, no analytics, no telemetry, and makes zero requests to third-party servers. Your screenshots never leave your machine. Uninstall and everything is gone — Chrome clears our IndexedDB and local storage for you.

▸ Shortcuts
Alt+Shift+S — capture the whole page

▸ Built for privacy-conscious folks
No sign-up. No upload. No tracking. Just screenshots.

Free and open source. Chrome MV3.
```

## 4. 素材清单

| 素材 | 规格 | 文件 | 状态 |
|------|------|------|------|
| 商店图标 | 128×128 PNG | `store-icon-128.png` | ✅ |
| 小宣传图 | 440×280 PNG | `promo-small-440x280.png` | ✅ |
| 大宣传图 | 1280×800 PNG | `promo-large-1280x800.png` | ✅ |
| 隐私政策 | 公开可访问 URL | https://weihongdago.github.io/shotly/privacy.html | ✅ 已上线（HTTP 200）；域名 `getshotly.com` 到手后可换自有域名 |
| **支持页面** | 公开可访问 URL | https://weihongdago.github.io/shotly/support.html | ✅ 已上线（HTTP 200）—— **CWS 后台必填项**，之前漏了 |
| **主页** | 公开可访问 URL | https://weihongdago.github.io/shotly/ | ✅ 已上线（HTTP 200）—— 后台「Homepage URL」填这个 |
| 功能截图 | 1280×800 PNG ×4 | `screenshots/01~04` | ✅ 真实浏览器运行产物（2026-10-27 重拍，popup 为英文，与 listing 一致） |
| 分类 | — | `Productivity` | ✅ |
| 语言 | — | English (Primary), 中文（简体） | ✅ v1.0 只交这 2 份 listing 文本（界面只有 en/zh，虚假声明 4 语种反而有审核风险） |

### ✅ 语言一致性缺口（已解决，2026-10-27 D+4）

**原问题**：扩展 UI 全中文（popup 写死“整页截图 / 区域截图 / 准备截图…”），
但 manifest 没有 `default_locale`，也没有 `public/_locales/`。
后果：Chrome 商店把扩展认定为 “English”，后台单独提交的「中文（简体）」
listing **永远不会展示给中文用户**——商店按扩展自己声明的 locale 选 listing。

**原两条路（做完了 B + A 的加强版）**：

| 方案 | 做法 | 代价 | 适合 |
|------|------|------|------|
| ~~A. 声明中文 locale~~ | ~~`default_locale: 'zh_CN'`~~ | ~~商店主 listing 语言变中文~~ | ~~~~ |
| ~~B. UI 改英文~~ | ~~popup 文案全部改英~~ | ~~文案改造成本~~ | ~~~~ |

**实际做法（2026-10-27 落地）**：

1. **manifest 声明 locale**：`wxt.config.ts` 加 `manifest.default_locale: 'en'`，
   新建 `public/_locales/en/messages.json` + `public/_locales/zh_CN/messages.json`
   （`extensionName` / `extensionDescription` / `actionTitle`）。
   → 商店认得这是多语言扩展，中文 listing 会被展示给中文用户。
2. **界面跟随浏览器语言**：新增 `shotly/utils/i18n.ts`（en/zh 双语字典 +
   `{placeholder}` 插值 + 未知 key 回显 key 本身），popup 全部文案走 `i18n.t()`。
   浏览器语言是 `zh*` → 中文界面，否则英文界面。**英文用户不再看到看不懂的按钮。**
3. **用户可手动切换**：popup 头部 `EN` / `中` 按钮，override 落
   `chrome.storage.local`，下次打开仍生效。
4. **区域框选浮层也跟随语言**：浮层是 content script 画在**网页上**的，
   不走 popup 的 Vue 渲染 —— 之前就是漏在这条路径上（英文用户拖框时看到
   中文提示条）。现在 `selectRegion()` 收 `tooSmallMessage` 参数，
   content script 按 locale 传入。

> 两条路不互斥——原文档把它们当成二选一是错的：**A 解决“商店能不能展示中文 listing”，
> B 解决“界面语言跟 listing 对不对得上”。** 两个问题同时存在，就两个都修。

**回归锁定**：`test-infra/e2e/playwright-i18n.spec.ts`（5 用例，真实浏览器）——
manifest 声明 / en-US→英文 / zh-CN→中文 / 手动切换并持久化 / 区域浮层跟随语言。

**v1.0 范围决定**：只交 **English + 中文（简体）** 两份 listing。
PRD 里提到的日语 / 西班牙语留到 v1.1——界面都还没做那两种语言，
先在商店声明 4 语种只会让用户点进去发现是英文。


## 5. 功能截图（4 张，已产出）

拍摄方式：`test-infra/e2e/playwright-store-screenshots.spec.ts`，真实 Chrome 加载
构建产物后运行，**画面里的每一个产品像素都是实拍的**，版式里只有文字说明。

| # | 文件 | 内容 |
|---|------|------|
| 1 | `01-full-page-capture.png` | Shotly 抓出来的整页长图（真实产物） |
| 2 | `02-region-selection.png` | 真实网页上的区域框选浮层 |
| 3 | `03-capture-progress.png` | popup 采集中的真实进度条 |
| 4 | `04-result-and-formats.png` | popup 完成态：真实预览图 + PNG/JPG/PDF |

> 拍摄时统一用浅色主题 + 薄荷绿品牌色，与大宣传图风格一致。
> **2026-10-27 重拍**：popup 原先是中文的，与英文 listing 对不上；i18n 落地后
> 截图统一用 `locale: 'en-US'` 重拍，现在界面与 listing 一致。

## 6. 权限理由（CWS 审核必填）

| 权限 | 提交的用途说明 |
|------|--------------|
| `activeTab` | Access the current tab only when the user clicks the extension icon, to capture the page they are viewing. |
| `scripting` | Inject the region-selection overlay into the active tab when the user starts a region capture. |
| `offscreen` | Use an offscreen document with a canvas to stitch multi-screen captures into a single full-page image. Required because MV3 service workers have no DOM access. |
| `storage` | Store your language choice (auto / English / 中文) locally via chrome.storage, so it persists between popup opens. |
| `downloads` | Save exported screenshots (PNG/JPG/PDF) to the user's disk when the user clicks Download. |
| `clipboardWrite` | Copy the captured screenshot to the clipboard when the user clicks the Copy button. |
| `unlimitedStorage` | Store up to 50 full-page screenshots in a local IndexedDB history library. Default quota (~100KB–10MB) is insufficient for high-resolution captures. |
| `tabs` | Read the current tab's title and URL to label local history entries. Never transmitted off-device. |
| `<all_urls>` | Required for a screenshot extension: capture must work on any site the user chooses. |

## 7. 数据使用声明（CWS 新版必填）

- **用户数据收集**：**不收集**（No collection or transmission of user data）
- **单一用途声明**：截图内容仅在用户设备本地处理与存储；扩展不向任何服务器发送截图、URL、标题或遥测数据
- **远程代码**：不执行远程代码；所有逻辑打包在扩展包内（无 `eval`，无远程脚本）
- **加密**：不适用（无数据离开设备）

## 8. 提审前检查清单

- [x] `pnpm build` 通过 + `pnpm typecheck` 无错误 + `pnpm test` 全绿（234/234）
- [x] `pnpm zip` 产出包已验证（`.output/shotly-0.1.0-chrome.zip`，230 KB，16 个文件，含 `_locales/`）
- [x] **打包产物本身**已测（`playwright-packaged-zip.spec.ts`：从 zip 解压出来装进 Chrome 跑真实截图）
- [x] CI 直接产出可提审的 zip artifact（`shotly-chrome-zip`）—— 提审时直接下，不用本地重新打包
- [x] manifest 权限与第 6 节完全一致（不多不少，有测试锁住）
- [x] manifest 有 `default_locale: 'en'` + `_locales/en` `_locales/zh_CN` 齐备
- [x] 隐私政策 URL 可公开访问（https://weihongdago.github.io/shotly/privacy.html）
- [x] **支持 URL 可公开访问**（https://weihongdago.github.io/shotly/support.html）—— CWS 后台必填项
- [x] 主页 URL 可公开访问（https://weihongdago.github.io/shotly/）
- [x] 4 张功能截图补齐（1280×800，真实浏览器产出）
- [x] 2 份 listing 文本补齐（English + 中文（简体）→ 见第 9 节）
- [x] listing ↔ 实现 一致性守卫（vitest 版在 CI 每次 push 都跑，15 用例；另有 Playwright 版 4 用例）
- [x] 隐私承诺运行时断言（`test-infra/e2e/playwright-privacy-no-network.spec.ts`，2 用例）——「不上传不追踪」是被测的，不是被声称的
- [ ] 开发者账号 $5 注册费到账
- [x] 版本号 = 0.1.0，商店描述写「Free & open source」

---

## 9. 中文（简体）listing 文本

> 2026-10-27 补齐。**不是机翻**：按中文用户的阅读习惯重写，句子更短、
> 术语用国内习惯说法（“整页截图” 而不是 “全页捕获”，“卡贴板” 而不是 “剪贴板”）。
> 结构与英文版一一对应，审图时能一一对上。
>
> ⚠️ 商店的「中文（简体）」listing 文字是**独立的一份**（在后台切换语言标签填写），
> 不是自动翻译。没有它，中文用户看到的就是英文页——而我们声明了 `zh_CN`，
> 不填等于浪费这个 locale。

### 9.1 商品名称

```
Shotly — 整页截图与区域截图
```

（18 字符，上限 45 ✅）

### 9.2 简短说明（上限 132 字符）

```
不只截屏，一键截下整页。PNG / JPG / PDF 导出，截图不离开你的设备——不上传、不追踪。
```

（50 字符 ✅）

### 9.3 详细说明

```
浏览器窗口装不下的长页面，Shotly 一张图给你。

▸ 一键截整页
自动滚动、分段截图、拼接成一张完整长图。固定头部、悬浮元素、跨域 iframe 都会自动处理，
拼出来的是一张连续的图，不是乱码似的一堆重复片段。

▸ 区域截图
拖一个框，只要你要的那一块。最小 100×100，大到整个页面都行。

▸ 想怎么存就怎么存
PNG 无损画质，JPG 体积小，PDF 适合当文档发出去。

▸ 卡贴板与历史库
一键复制到卡贴板，或存进本地历史库（最近 50 张，只存在你自己的设备上）。

▸ 隐私不是附加项，是卖点
没有账号、没有统计、没有遥测，不向任何第三方服务器发一个请求。
你的截图不出你的电脑。卸载就彻底干净——Chrome 会帮你清掉 IndexedDB 和本地存储。

▸ 快捷键
Alt+Shift+S —— 截取整页

▸ 给在意隐私的人
不用注册、不上传、不追踪。就只是截图而已。

免费且开源。Chrome MV3。
```

### 9.4 权限理由（中文版，逐条对应第 6 节）

| 权限 | 提交的用途说明 |
|------|--------------|
| `activeTab` | 仅在用户点击扩展图标时访问当前标签页，用于截取用户正在看的页面。 |
| `scripting` | 用户发起区域截图时，向当前标签页注入区域框选浮层。 |
| `offscreen` | 使用离屏文档与 canvas 把多分屏截图拼接成一张整页图。MV3 的 Service Worker 访问不到 DOM，所以必须用离屏文档。 |
| `storage` | 通过 chrome.storage 在本地保存你的语言选择（自动 / English / 中文），下次打开 popup 仍然生效。 |
| `downloads` | 用户点击「下载」时，把导出的截图（PNG/JPG/PDF）保存到本地磁盘。 |
| `clipboardWrite` | 用户点击「复制」时，把截到的图写入卡贴板。 |
| `unlimitedStorage` | 在本地 IndexedDB 历史库里保存最多 50 张整页截图。默认配额（约 100KB–10MB）装不下高分辨率长图。 |
| `tabs` | 读取当前标签页的标题与 URL，用于给本地历史记录命名。绝不上传。 |
| `<all_urls>` | 截图类扩展的必需项：用户想截哪个网站就得能截哪个网站。 |

### 9.5 数据使用声明（中文版）

- **用户数据收集**：**不收集**（不收集、不传输任何用户数据）
- **单一用途声明**：截图内容仅在用户设备本地处理与存储；扩展不向任何服务器发送截图、URL、标题或遥测数据
- **远程代码**：不执行远程代码；所有逻辑打包在扩展包内（无 `eval`，无远程脚本）
- **加密**：不适用（无数据离开设备）

---

## 已知风险

| 风险 | 缓解 |
|------|------|
| 审核被拒：权限过大 | `host_permissions: <all_urls>` 对截图类扩展是标准做法，理由充分；准备好第 6 节的说明 |
| 审核被拒：隐私政策不匹配 | 政策里明确写了「不收集」，与实际行为一致；提审前自查 manifest 无任何网络请求 |
| 域名未注册 → 隐私政策 URL 挂空 | **已解**：GitHub Pages 已上线（HTTP 200）。域名到手后可换自有域名 |
| 支持 URL 缺失被退审 | **已解**：新增 support.html（GitHub Issues 渠道 + 常见问题 + 报 bug 模板）。CWS 后台「Support URL」是**必填**的 |
| 隐私政策里的联系邮箱是死地址 | **已修**：原写 `privacy@getshotly.com`，但域名未注册（whois: No match）——审核员点进去发现邮箱不可用会退审。改为 GitHub Issues（仓库公开且开了 Issues，链接当场可验证） |
| listing 吹了没有的功能 | **已修**：D+4 发现 listing 吹了 `Alt+Shift+V` 视口截图（实际给的是整页），已移除该命令；并加了一致性测试锁住快捷键/权限/功能三类漂移 |
| 商店名超限 | **已修**：原名 47 字符 > 45 上限 → `Shotly — Full Page & Region Capture`（35） |
