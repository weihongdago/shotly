# Shotly

> Modern whole-page screenshot tool for Chrome. Privacy-first: your screenshots never leave your device.

> ⚠️ **Chrome / Chromium only.** The capture pipeline depends on
> `chrome.offscreen` (OffscreenCanvas stitching), which **Firefox does not
> implement** — MDN's browser-compat-data has no `offscreen` entry at all.
> `pnpm build:firefox` compiles and produces a zip, but that build is
> **broken at runtime**: `chrome.offscreen` is `undefined` there, so
> `ensureOffscreen()` throws and every capture fails.
>
> The Firefox build is kept in CI as a **compile check only** (it catches
> accidental Chrome-only API usage in shared code), not as a supported
> platform. See progress.md 决策 #1: 平台范围 = Chrome only.

## Status

**D+4 — 2026-10-27**: v1.0 feature set is feature-complete and verified in a real browser.

- ✅ **D+1**: WXT scaffold + architecture v1.2 patches, 9-permission manifest, long-port messaging (20s heartbeat), iframe placeholders, retry→fallback helper, dark mode tokens, offscreen stitch skeleton
- ✅ **D+2** (`0b3397c`): full-page capture pipeline — bg port registry + SW double-eval guard + sender-key dedupe, offscreen lifecycle, `captureVisibleTab` round-trip, OffscreenCanvas stitching, popup UI with progress, PoC-D3 scenarios
- ✅ **D+3**: export formats (PNG/JPG/PDF via offscreen + pdf-lib), IndexedDB history store (50-entry LRU), region capture (rectangle drag-select), CI workflow, privacy policy
- ✅ **D+4**: device-pixel (Retina-correct) stitching, URL-origin based cross-origin iframe detection, `waitForPaint()` (iframe *loaded* ≠ *painted*), Chrome Web Store listing assets, **8/8 PoC-D3 scenarios green in a real Chrome**

### Verification

The five PoC-D3 scenarios run against a real Chromium with the real
extension loaded — no mocks. Every assertion is **pixel-based** (per-band
non-white ratio, exact colour hits, pixel signatures); byte size is never
used, because a broken stitch silently produces a blank PNG that is still
100 KB+.

| Scenario | What it proves | Result |
|----------|----------------|--------|
| S1 short page | baseline stitch, no stripes | ✅ 1280×2662, 7/7 bands |
| S2 long page @ DPR 2 | 30 000 CSS px → **60 000 device px**, 150 bands, no empty band | ✅ 2560×60000 |
| S3 cross-origin iframes | placeholder mint `#2DD4BF` present, same-origin iframe kept verbatim | ✅ |
| S4 lazy images | 200 lazy tiles all rasterised before capture | ✅ 22/22 bands |
| S5a 49 500 px | near the hard limit, still complete | ✅ 124/124 bands |
| S5b 50 001 px | over-limit page is **refused up front**, zero capture side effects | ✅ |
| S5c dark mode | dark background survives the white canvas fill | ✅ |
| S5d web font | the captured glyphs are the webfont, not the fallback | ✅ |

Scenarios, fixtures and pass criteria live in [`poc-d3/`](./poc-d3) —
including [`poc-d3/expected-results.md`](./poc-d3/expected-results.md).

### Known limitations

- The stitch canvas is sized in **device pixels**, and Chrome refuses
  canvases taller than 65 535 px, so the page limit is
  `min(50 000, ⌊65 535 / DPR⌋)` CSS px (50 000 at DPR 1, 32 767 at DPR 2).
  A page that fits at DPR 1 is refused at DPR 2, with the reason in the
  error message.
- Cross-origin iframes are replaced by a labelled placeholder (the
  browser will not let an extension read their content). Same-origin
  iframes are captured verbatim.

## Install

```bash
git clone https://github.com/weihongdago/shotly.git
cd shotly
pnpm install
pnpm build          # → .output/chrome-mv3
pnpm zip            # → .output/shotly-<version>-chrome.zip (CWS upload)
```

Load it in Chrome: `chrome://extensions/` → enable **Developer mode** →
**Load unpacked** → pick `shotly/.output/chrome-mv3`.

## Development

## Development

```bash
pnpm install          # postinstall runs `wxt prepare` to generate types
pnpm dev              # WXT dev server with HMR (loads in .output/chrome-mv3)
pnpm typecheck        # vue-tsc --noEmit
pnpm test             # vitest run
pnpm build            # production build → .output/chrome-mv3
pnpm build:firefox    # firefox-mv2 COMPILE CHECK ONLY — see the ⚠️ note at the top
pnpm zip              # package for CWS upload
```

## Architecture

See [`docs/architecture.md`](./docs/architecture.md) v1.2 (1503 lines),
[`docs/test-plan-v1.md`](./docs/test-plan-v1.md) and
[`docs/ui-style-guide-v1.md`](./docs/ui-style-guide-v1.md).

### Module layout

```
shotly/
├── entrypoints/
│   ├── background.ts          # SW: ports, heartbeat, offscreen single-instance, commands
│   ├── content.ts             # page-context: scroll-and-stitch driver, port handler
│   ├── offscreen.html         # hidden HTML for OffscreenCanvas
│   ├── offscreen-main.ts      # offscreen stitcher + PNG/JPG/PDF export conversion
│   └── popup/                 # toolbar popup (Vue 3, brand-styled)
├── utils/
│   ├── messaging.ts           # Envelope types, openPort(), requestOverPort(), CAPTURE_MSG/EXPORT_MSG
│   ├── capture-fallback.ts    # plan A → retry 3x → plan B（⚠️ 未接入生产路径，见下）
│   ├── iframe-placeholder.ts  # cross-origin iframe replacement
│   ├── screenshot-engine.ts   # planCapture, runScrollAndCapture, stitchChunks
│   ├── region-selector.ts     # rectangle drag-select overlay (D+3)
│   ├── history-store.ts       # IndexedDB history, 50-entry LRU (D+3)
│   ├── export.ts              # filename/MIME/PDF page-size helpers (D+3)
│   ├── theme.ts               # light/dark mode tokens (WCAG AA)
│   └── __tests__/             # vitest unit tests
├── .github/workflows/ci.yml   # type-check → test → build (chrome + firefox)
├── docs/                      # architecture, test plan, UI style guide
├── poc-d3/                    # 5 verification scenarios + fixtures + expected results
├── PRIVACY.md                 # privacy policy (bilingual, CWS-ready)
├── wxt.config.ts              # WXT config + manifest（8 permissions + 1 host permission）
├── vitest.config.ts
└── package.json
```


> ⚠️ **`utils/capture-fallback.ts` 未接入生产路径。**
> 它实现了「plan A 失败重试 3 次 → 回退 plan B」，但没有任何生产代码 import 它
> （构建产物里也不含它）。v1.0 的实际行为是：截图失败**直接报错**，
> 没有 A/B 回退。文档里描述的重试逻辑是**为将来准备的**，不是现状。
> 详见 `docs/architecture.md` 顶部「历史设计文档」标注。

### Permission rationale (architecture §4.2)

| Permission | Why |
|------------|-----|
| `activeTab` | Inject content script on user click only — no pre-injection |
| `scripting` | Programmatic injection for precise timing |
| `offscreen` | MV3 SW cannot use DOM; offscreen doc is the official workaround |
| `storage` | Save the interface language choice (chrome.storage) |
| `downloads` | Save the exported PNG/JPG/PDF to the user's disk when they click Download |
| `clipboardWrite` | Copy the screenshot to the clipboard (navigator.clipboard.write) |
| `unlimitedStorage` | IndexedDB quota exceeds default 100KB — 50 screenshot history needs ~50MB |
| `tabs` | Read the current tab's title and URL to label local history entries |
| `<all_urls>` (host) | Screenshot extension — must reach any user page |

## Privacy

**Screenshots never leave the device.** No accounts, no telemetry SDKs, no analytics, no third-party requests.

- Screenshot images + metadata → local IndexedDB (max 50, LRU eviction)
- Interface language choice → `chrome.storage`
- Uninstall → Chrome removes all of it

Full policy (bilingual, CWS-ready): [`PRIVACY.md`](./PRIVACY.md).