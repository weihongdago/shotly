# Shotly

> Modern whole-page screenshot tool for Chrome. Privacy-first: your screenshots never leave your device.

## Status

**D+1 — 2026-07-11**: project scaffold + architecture v1.2 patches landed.

- ✅ Project bootstrapped from WXT Vue template (pnpm 10.33, Node 25, WXT 0.20.27)
- ✅ 8-permission manifest (architecture §4.1 v1.2)
- ✅ Long-port messaging layer with 20s heartbeat (architecture §2.3 v1.2)
- ✅ Iframe placeholder utility (architecture §3.2 v1.2)
- ✅ Retry × 3 → fallback to html2canvas (architecture §3.5 v1.2)
- ✅ Dark mode token system, teal-700/500 with WCAG AA contrast (architecture §4.5 v1.2)
- ✅ OffscreenCanvas stitch skeleton (architecture §3.1 v1.2)
- ✅ Background / content / offscreen / popup entrypoints wired up
- ✅ Unit tests: 13/13 passing

**Next** (D+2): wire real `chrome.tabs.captureVisibleTab` round-trip in background, integrate OffscreenCanvas stitch with chunk buffer, real scroll-and-stitch on a test page.

## Development

```bash
pnpm install          # postinstall runs `wxt prepare` to generate types
pnpm dev              # WXT dev server with HMR (loads in .output/chrome-mv3)
pnpm typecheck        # vue-tsc --noEmit
pnpm test             # vitest run
pnpm build            # production build → .output/chrome-mv3
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
│   ├── offscreen-main.ts      # offscreen port ping/pong
│   └── popup/                 # toolbar popup (Vue 3, brand-styled)
├── utils/
│   ├── messaging.ts           # Envelope types, openPort(), requestOverPort()
│   ├── capture-fallback.ts    # plan A → retry 3x → plan B
│   ├── iframe-placeholder.ts  # cross-origin iframe replacement
│   ├── screenshot-engine.ts   # planCapture, runScrollAndCapture, stitchChunks
│   ├── theme.ts               # light/dark mode tokens (WCAG AA)
│   └── __tests__/             # vitest unit tests
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

Per architecture §5.5: **screenshots never leave the device**. Server (Cloudflare Workers) only receives event-level telemetry (event name, anonymous ID, timestamp). No URL, no content, no PII.