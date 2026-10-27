# Shotly 提审操作手册

> 目标：**$5 到账后，30 分钟内提交完，不需要再查文档。**
>
> 本手册的所有字段约束都对着 Chrome 官方文档核过（2026-10-27），
> 链接见每节末尾。所有素材都已备好并被测试锁住 —— 这里只讲「点哪里、填什么」。

---

## 0. 前置状态（已全部就绪，不用重做）

| 项 | 状态 | 位置 |
|---|---|---|
| 代码 | ✅ 全绿 | https://github.com/weihongdago/shotly |
| 打包产物 | ✅ 已测 | CI artifact `shotly-chrome-zip` |
| 商店文案 | ✅ 已写（中英各一份） | `store-assets/CWS-listing.md` |
| 功能截图 | ✅ 4 张 1280×800 | `store-assets/screenshots/` |
| 图标 / 宣传图 | ✅ 尺寸合规 | `store-assets/*.png` |
| 隐私政策 | ✅ 已上线 | https://weihongdago.github.io/shotly/privacy.html |
| 权限理由 | ✅ 9 条逐条对应 manifest | `CWS-listing.md` 第 6 / 9.4 节 |

**唯一还没做的：注册 CWS 开发者账号（一次性 $5）。**

### 关于「本地能跑」≠「提交能跑」

所有 E2E 测的是 unpacked 目录，但 CWS 收的是 zip。zip 本身也有独立测试
（`test-infra/e2e/playwright-packaged-zip.spec.ts`：从 zip 解压出来装进
Chrome 跑真实截图）。**提审时用 CI 产出的那个 zip，别用本地重打的。**

---

## 1. 注册开发者账号（约 3 分钟 + $5 出账）

1. 打开 https://developer.chrome.com/docs/webstore/register
2. 用 **Google 账号**登录（建议用专门账号，发布者身份和这个账号绑定）
3. 填开发者信息 → 付一次性 $5 注册费
4. 账号创建后，进 Dashboard 的 **Account** 页填：
   - 公开的**支持网站**（可以是 https://weihongdago.github.io/shotly/）
   - **隐私政策 URL**（https://weihongdago.github.io/shotly/privacy.html）
   - 开发者联系邮箱

> 💡 这两个 URL 在 **Account 页**填一次；listing 页还会再要一遍隐私政策。
> 填一样的，别填错地方。

> ⚠️ **新发布者最多只能上架 2 个扩展**。Shotly 是第 1 个，不受影响。

---

## 2. 创建条目 + 上传 zip（约 3 分钟）

1. Dashboard → **Add new item**
2. **Choose file** → 选 zip → **Upload**
3. 官方文档明确要求：**manifest.json 必须在 zip 根目录**，不能在子文件夹里。
   ✅ 我们的 zip 已验证（`manifest.json` 在根）
4. 上传成功后进入条目编辑页

> ⚠️ **上传后 manifest 里的元数据改不了了**（name / description / version / icons）。
> 发现错别字只能改代码 → 升版本号 → 重新打包 → 重新上传。
> **上传前请再核对一遍第 3 节的字段。**

---

## 3. Store Listing 标签页（最花时间，认真填）

> 文档：https://developer.chrome.com/docs/webstore/cws-dashboard-listing

### 3.1 Product details

| 字段 | 填什么 | 字数 | 上限 |
|---|---|---|---|
| Detailed description | `CWS-listing.md` **第 3 节**代码块内容（英文） | 1079 | 16000 |
| Primary category | **Productivity**（或 Screenshots） | — | — |
| Language | English | — | — |

### 3.2 Graphic assets（尺寸已验证）

| 字段 | 用哪个文件 | 尺寸 | 必填 |
|---|---|---|---|
| Store icon | `store-assets/store-icon-128.png` | 128×128 | ✅ 必填 |
| Screenshots | `store-assets/screenshots/01~04-*.png` | 1280×800 | ✅ 至少 1 张 |
| Small promo tile | `store-assets/promo-small-440x280.png` | 440×280 | 可选 |
| Marquee promo tile | — | 1400×560 | 可选（**我们没做，别硬塞 1280×800 的那张**） |
| Promo video | — | YouTube 链接 | 可选 |

> 📌 4 张截图是**同一个扩展**的 4 个功能状态（整页 / 区域 / 进度 / 结果），
> 展示顺序按编号排。商店会缩到 640×400 显示，所以别放小字。

### 3.3 本地化（关键，别漏）

在 Store Listing 页面顶部下拉框切语言，**每个 locale 都要单独填一遍**：

| Locale | 详细说明用哪段 | 截图 |
|---|---|---|
| **English** | 第 3 节代码块 | 4 张（英文界面） |
| **中文（简体）** | **第 9.3 节代码块** | 4 张（英文界面，见下） |

> ⚠️ **locale 必须和扩展里的 `_locales/` 目录一一对应**。
> 我们声明了 `default_locale: 'en'` + `_locales/en` + `_locales/zh_CN`，
> 所以后台**只应该**出现 English 和 中文（简体）两个选项。
> 出现第三个选项 → 说明 `_locales/` 打包有问题 → 别往下走，回头查。

> 📌 **中文 listing 的截图**：商店允许每个 locale 单独传截图，也可以共用。
> 我们的截图是**英文界面**（商店页整体是英文的），建议**两个 locale 用同一套截图**，
> 避免用户看到中文描述配英文截图的割裂感。
>
> 📌 **一致性检查**：CWS 会自动分析不同 locale 的元数据是否描述了同一组功能，
> 不一致会弹警告（不阻断提交）。我们的中英两版是**逐节对应**的（7 个小节一一对应），
> 应该不会被标记。⚠️ 但中文版是重写的、不是机翻 —— 如果真的弹了警告，
> 别硬扛，检查是否漏了某个功能点。

### 3.4 Additional fields（可选，但建议填）

| 字段 | 填什么 |
|---|---|
| Homepage URL | https://weihongdago.github.io/shotly/ |
| Support URL | https://weihongdago.github.io/shotly/ |
| Support email | （用注册开发者账号那个邮箱） |

> 💡 想让发布者显示 **Verified publisher** 徽章，需要在 Google Search Console
> 里验证 `weihongdago.github.io` 站点归属。不做也不影响提审。

---

## 4. Privacy 标签页（审核最容易卡的地方）

> 文档：https://developer.chrome.com/docs/webstore/cws-dashboard-privacy

### 4.1 Single purpose（单一用途）

> 填这段（英文）：

```
Shotly captures full-page or region screenshots of the current tab and saves them locally as PNG, JPG or PDF files.
```

> 官方要求：用途必须**狭窄且易懂**。这段只说一件事：截图 + 本地保存。
> ⚠️ 别在这里提「隐私」「不上传」——那是数据处理声明，不是用途。
> 写多了反而会让审核觉得你在混淆用途。

### 4.2 Permissions justification（9 条逐条填）

> 后台会列出 manifest 里的**全部**权限，每条都要给理由。
>
> ⚠️ **以 `CWS-listing.md` 第 6 节的表格为唯一权威源**（SSOT）。
> 下表是它的副本，已由测试锁住一致 —— 改了一处另一处会被守门测出来。

| 权限 | 理由（照抄） |
|---|---|
| `activeTab` | Access the current tab only when the user clicks the extension icon, to capture the page they are viewing. |
| `scripting` | Inject the region-selection overlay into the active tab when the user starts a region capture. |
| `offscreen` | Use an offscreen document with a canvas to stitch multi-screen captures into a single full-page image. Required because MV3 service workers have no DOM access. |
| `storage` | Store your language choice (auto / English / 中文) locally via chrome.storage, so it persists between popup opens. |
| `downloads` | Save exported screenshots (PNG/JPG/PDF) to the user's disk when the user clicks Download. |
| `clipboardWrite` | Copy the captured screenshot to the clipboard when the user clicks the Copy button. |
| `unlimitedStorage` | Store up to 50 full-page screenshots in a local IndexedDB history library. Default quota (~100KB–10MB) is insufficient for high-resolution captures. |
| `tabs` | Read the current tab's title and URL to label local history entries. Never transmitted off-device. |
| `<all_urls>` | Required for a screenshot extension: capture must work on any site the user chooses. |

> ⚠️ **后台多列出来的每一条权限都必须在这里给理由**。
> 官方原文：「If there are permissions listed here that you don't require,
> remove them from your manifest and upload a new version」。
> 我们 9 条权限**全部有实际用途**，且已被测试锁住（`store-listing-consistency.test.ts`
> 断言 listing 的权限表 ⟷ manifest 权限**不多不少**）。
> 如果后台出现第 10 条 → **停下来**，说明 manifest 变了但 listing 没跟上。

### 4.3 Remote code

```
No, I am not using remote code.
```

> 我们是 MV3，本来就不允许远程代码。构建产物里无 `eval`、无远程脚本
> （由 `store-listing-consistency.test.ts` 的静态扫描保证）。

### 4.4 Data usage（数据使用声明）

第一组勾选框（收集哪些数据）：**全部不勾**（我们不收集任何用户数据）

第二组认证勾选框：
- ✅ 与「有限使用」政策一致
- ✅ 不出售用户数据
- ✅ 不用于广告 / 信用评估 / 目的外使用

> ⚠️ 官方提醒：**这里的声明必须和隐私政策页的内容一致**。
> 我们的隐私政策写的就是「不收集」——已经对齐。
> 而且这不是口头声明：`playwright-privacy-no-network.spec.ts` 在运行时
> 验证扩展跑完整截图流程时**零第三方请求**。

### 4.5 Privacy policy URL

```
https://weihongdago.github.io/shotly/privacy.html
```

✅ 已上线（HTTP 200）。域名 `getshotly.com` 到手后可替换，替换要同步改
Account 页和这里两处。

---

## 5. Distribution 标签页

| 字段 | 填什么 |
|---|---|
| Visibility | **Public** |
| Countries | 全部（不限制） |
| Paid item | **No**（v1.0 免费版） |
| Install events / 用户群体 | 默认 |

---

## 6. 提交审核

1. 点 **Submit for review**
2. 弹窗里勾 **Publish automatically after review**（或选 deferred publishing 自己挑时间）
3. 确认提交

**审核时间**：新扩展通常几天到两周，复杂的话更久。
审核通过后有 **30 天**内手动发布的窗口，过期会退回 draft 需要重新提交。

---

## 7. 如果被拒了（大概率会遇到的几种）

| 拒因 | 我们的准备 | 应对 |
|---|---|---|
| 「权限过多」 | 9 条权限逐条有理由，且实测无网络请求 | 附上 §4.2 的理由表 + 隐私测试结论 |
| 「listing 描述的功能与扩展不符」 | listing ↔ 实现一致性守门（CI 每次 push 跑） | 贴 CI 通过记录 |
| 「隐私政策不可访问」 | GitHub Pages 已上线 | 换 `getshotly.com`（更稳） |
| 「功能不足 / 只是个空壳」 | 6 个功能全部可用，有 28 条 E2E | 贴测试报告 |
| 「需要域名」 | 隐私政策 URL 现在挂在 GitHub Pages | 注册 `getshotly.com` 换上去 |

> 📌 被拒后会收到邮件说明具体拒因。**改完重新提交版本号必须更大**
> （0.1.0 → 0.1.1 → 0.2.0）。改 manifest 要重新 `pnpm zip`。

---

## 附：一键自检

提交前跑这条，全绿再上去：

```bash
cd projects/gofullpage-clone/shotly
pnpm build && pnpm zip && pnpm test          # 208 单测
cd ../test-infra
pnpm exec playwright test e2e/                # 28 E2E
```

或直接看 CI：https://github.com/weihongdago/shotly/actions
（最新一次绿 = 产物就是对的，下载 `shotly-chrome-zip` artifact 即可提交）

---

## 参考文档

- 注册账号：https://developer.chrome.com/docs/webstore/register
- 准备扩展：https://developer.chrome.com/docs/webstore/prepare
- 提交发布：https://developer.chrome.com/docs/webstore/publish
- Store Listing 字段：https://developer.chrome.com/docs/webstore/cws-dashboard-listing
- Privacy 字段：https://developer.chrome.com/docs/webstore/cws-dashboard-privacy
- 图片规格：https://developer.chrome.com/docs/webstore/images
- 审核流程：https://developer.chrome.com/docs/webstore/review-process
