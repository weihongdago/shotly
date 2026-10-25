# Shotly

> Modern whole-page screenshot tool for Chrome. Privacy-first: your screenshots never leave your device.

## Status

**D+3 — 2026-10-25**: capture pipeline landed, export + history in progress.

- ✅ **D+1**: WXT scaffold + architecture v1.2 patches, 8-permission manifest, long-port messaging (20s heartbeat), iframe placeholders, retry→fallback, dark mode tokens, offscreen stitch skeleton
- ✅ **D+2** (`0b3397c`): full-page capture pipeline — bg port registry + SW double-eval guard + sender-key dedupe, offscreen lifecycle, `captureVisibleTab` round-trip, OffscreenCanvas stitching, popup UI with progress, PoC-D3 scenarios
- 🚧 **D+3**: export formats (PNG/JPG/PDF via offscreen + pdf-lib), IndexedDB history store (50-entry LRU), region capture (rectangle drag-select), CI workflow, privacy policy

**Next** (D+4): Chrome Web Store listing assets, real-browser end-to-end run against the 5 PoC-D3 scenarios.

## Development

```bash
pnpm install          # postinstall runs `wxt prepare` to generate types
pnpm dev              # WXT dev server with HMR (loads in .output/chrome-mv3)
pnpm typecheck        # vue-tsc --noEmit
pnpm test             # vitest run
pnpm build            # production build → .output/chrome-mv3
pnpm build:firefox    # firefox-mv2 build
pnpm zip              # package for CWS upload
```

## Architecture

See [`../architecture.md`](../architecture.md) v1.2 (1503 lines).

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
│   ├── capture-fallback.ts    # plan A → retry 3x → plan B
│   ├── iframe-placeholder.ts  # cross-origin iframe replacement
│   ├── screenshot-engine.ts   # planCapture, runScrollAndCapture, stitchChunks
│   ├── region-selector.ts     # rectangle drag-select overlay (D+3)
│   ├── history-store.ts       # IndexedDB history, 50-entry LRU (D+3)
│   ├── export.ts              # filename/MIME/PDF page-size helpers (D+3)
│   ├── theme.ts               # light/dark mode tokens (WCAG AA)
│   └── __tests__/             # vitest unit tests
├── .github/workflows/ci.yml   # type-check → test → build (chrome + firefox)
├── PRIVACY.md                 # privacy policy (bilingual, CWS-ready)
├── wxt.config.ts              # WXT config + 8-permission manifest
├── vitest.config.ts
└── package.json
```

### Permission rationale (architecture §4.2)

| Permission | Why |
|------------|-----|
| `activeTab` | Inject content script on user click only — no pre-injection |
| `scripting` | Programmatic injection for precise timing |
| `offscreen` | MV3 SW cannot use DOM; offscreen doc is the official workaround |
| `storage` | User preferences (chrome.storage) |
| `downloads` | Default export method |
| `clipboardWrite` | F4 P0: copy screenshot to clipboard (navigator.clipboard.write) |
| `unlimitedStorage` | IndexedDB quota exceeds default 100KB — 50 screenshot history needs ~50MB |
| `tabs` | Alt+Shift+S shortcut → tabs.query → captureVisibleTab |
| `<all_urls>` (host) | Screenshot extension — must reach any user page |

## Privacy

**Screenshots never leave the device.** No accounts, no telemetry SDKs, no analytics, no third-party requests.

- Screenshot images + metadata → local IndexedDB (max 50, LRU eviction)
- Preferences → `chrome.storage`
- Uninstall → Chrome removes all of it

Full policy (bilingual, CWS-ready): [`PRIVACY.md`](./PRIVACY.md).