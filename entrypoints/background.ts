/**
 * Background Service Worker — Shotly (architecture v1.2 §2.3, §3.1)
 *
 * Responsibilities (D+2):
 *   - Maintain `screenshot-port` long connections from content + popup
 *     with 20s heartbeat (prevents MV3 SW idle kill).
 *   - Dispatch `chrome.tabs.captureVisibleTab` for the content-script capture loop.
 *   - Relay captured chunks to the offscreen document's OffscreenCanvas.
 *   - Maintain a single offscreen document (Chrome hard constraint: one per extension).
 *   - Relay finalize → blob URL back to both content + popup.
 *   - Handle keyboard shortcuts (Alt+Shift+S / Alt+Shift+V) by kicking the pipeline.
 *
 * Capture pipeline data flow:
 *
 *   popup ──start-full──► bg ──start──► content
 *   content ──capture-chunk──► bg ──chrome.tabs.captureVisibleTab──► bg
 *   bg ──dataUrl──► content ──stitch-chunk──► bg ──relay──► offscreen (drawImage)
 *   ... loop per segment ...
 *   content ──finalize──► bg ──relay──► offscreen ──convertToBlob──► blobUrl
 *   bg ──done(blobUrl)──► content & popup
 */

import {
  CAPTURE_MSG,
  PORT_NAMES,
  PROTOCOL_VERSION,
  type CaptureChunkResponse,
  type Envelope,
  type FinalizeResponse,
  type InitStitchPayload,
  type Scope,
  type StartFullResponse,
  type StitchChunkPayload,
} from '../utils/messaging';

// ─── Port registry ────────────────────────────────────────────────────────────

const HEARTBEAT_INTERVAL_MS = 20_000;

/** Tracks every active port for cleanup + heartbeat. */
const activePorts = new Map<
  chrome.runtime.Port,
  { heartbeat: ReturnType<typeof setInterval>; scope: Scope; name: string }
>();

/**
 * Tracks active capture sessions, keyed by `tabId`. One session = one
 * in-flight pipeline (scroll + capture + stitch + finalize). We keep both
 * the content port (for relay) and the popup port (for status/done) so we
 * can notify either side as the pipeline progresses.
 */
interface CaptureSession {
  tabId: number;
  contentPort: chrome.runtime.Port | null;
  popupPort: chrome.runtime.Port | null;
  offscreenPort: chrome.runtime.Port | null;
  startedAt: number;
  chunkCount: number;
  /** Seen message ids — used to dedupe in case Playwright/CDP double-fires. */
  seenMessageIds: Set<string>;
}
const captureSessions = new Map<number, CaptureSession>();

/** Single offscreen document — Chrome constraint. */
let offscreenReady: Promise<void> | null = null;

/** Single offscreen port — bg is the only peer. */
let offscreenPort: chrome.runtime.Port | null = null;
let offscreenConnecting: Promise<chrome.runtime.Port> | null = null;

// ─── Background entrypoint ────────────────────────────────────────────────────

export default defineBackground(() => {
  const swInstanceId = Math.random().toString(36).slice(2, 8);
  console.info(`[shotly:bg] defineBackground called swInstanceId=${swInstanceId}`);
  // Guard against the SW module evaluating more than once within the same
  // SW process. In MV3 + some test harnesses the script can be imported
  // twice; without this guard we'd register `chrome.runtime.onConnect`
  // twice and every popup/content message would be handled twice.
  // (architecture §2.3 hotfix 2026-07-12)
  const globalGuard = globalThis as unknown as { __shotlyBgInit?: boolean };
  if (globalGuard.__shotlyBgInit) {
    console.info(`[shotly:bg] duplicate module eval, skipping init swInstanceId=${swInstanceId}`);
    return;
  }
  globalGuard.__shotlyBgInit = true;
  console.info(`[shotly:bg] service worker booted pid=${(globalThis as { process?: { pid?: number } }).process?.pid ?? '?'} swInstanceId=${swInstanceId}`);

  // ─── Port connections (long-lived) ────────────────────────────────────────
  // Track which ports we've already wired so duplicate onConnect events
  // (Playwright/CDP can report the same connection twice) don't add
  // duplicate onMessage listeners. (architecture §2.3 hotfix 2026-07-12)
  const wiredPorts = new WeakSet<chrome.runtime.Port>();
  // Sender-based dedupe: Playwright sometimes reports the same logical
  // connection as two distinct Port objects (verified 2026-07-12). We
  // memoize by `name + sender.tab?.id` so the second one short-circuits.
  // We store this on globalThis so duplicate SW module evals still see
  // the same set (in case `__shotlyBgInit` guard somehow misses).
  const globalSenderKeys = (globalThis as unknown as {
    __shotlyWiredSenderKeys?: Set<string>;
  }).__shotlyWiredSenderKeys ??= new Set<string>();
  const wiredSenderKeys = globalSenderKeys;

  chrome.runtime.onConnect.addListener((port) => {
    // Each call gets a fresh invocation id so we can correlate.
    const invocationId = Math.random().toString(36).slice(2, 8);
    console.info(`[shotly:bg] onConnect fired name=${port.name} sender=${JSON.stringify({tab: port.sender?.tab?.id, url: port.sender?.url})} swInstanceId=${swInstanceId} invocationId=${invocationId}`);
    (port as chrome.runtime.Port & { __invId?: string }).__invId = invocationId;
    if (
      port.name !== PORT_NAMES.screenshot &&
      port.name !== PORT_NAMES.offscreen &&
      port.name !== PORT_NAMES.history &&
      port.name !== PORT_NAMES.license
    ) {
      return;
    }
    if (wiredPorts.has(port)) {
      console.info(`[shotly:bg] onConnect already wired, skipping duplicate`);
      return;
    }
    const senderKey = `${port.name}|${port.sender?.tab?.id ?? ''}|${port.sender?.url ?? port.sender?.id ?? ''}`;
    if (wiredSenderKeys.has(senderKey)) {
      console.info(`[shotly:bg] onConnect sender already wired, skipping key=${senderKey}`);
      return;
    }
    wiredSenderKeys.add(senderKey);
    wiredPorts.add(port);

    // Special-case: offscreen connection announces itself for relay.
    if (port.name === PORT_NAMES.offscreen) {
      wireOffscreenPort(port);
      return;
    }

    const scope: Scope =
      port.sender?.tab != null ? 'content' : 'popup';

    const heartbeat = setInterval(() => {
      try {
        port.postMessage({
          v: PROTOCOL_VERSION,
          id: '__heartbeat__',
          scope: 'bg',
          type: `${port.name.replace('-port', '')}:heartbeat`,
          payload: { ts: Date.now() },
        } satisfies Envelope);
      } catch {
        clearInterval(heartbeat);
        activePorts.delete(port);
      }
    }, HEARTBEAT_INTERVAL_MS);

    activePorts.set(port, { heartbeat, scope, name: port.name });

    port.onDisconnect.addListener(() => {
      clearInterval(heartbeat);
      activePorts.delete(port);
      console.info(`[shotly:bg] port ${port.name} (${scope}) disconnected`);

      // If this was a content port for an active session, mark session orphaned.
      if (scope === 'content' && port.sender?.tab?.id != null) {
        const session = captureSessions.get(port.sender.tab.id);
        if (session?.contentPort === port) {
          session.contentPort = null;
        }
      }
      // If this was a popup port for an active session, just drop the reference.
      if (scope === 'popup') {
        for (const session of captureSessions.values()) {
          if (session.popupPort === port) session.popupPort = null;
        }
      }
    });

    port.onMessage.addListener((envelope: Envelope) => {
      if (envelope.id === '__heartbeat__') return;
      const invId = (port as chrome.runtime.Port & { __invId?: string }).__invId ?? '?';
      console.info(`[shotly:bg] handlePortMessage type=${envelope.type} id=${envelope.id} from port=${port.name} invId=${invId} swInstanceId=${swInstanceId}`);
      handlePortMessage(port, envelope).catch((err) => {
        console.error('[shotly:bg] handlePortMessage error:', err);
        try {
          port.postMessage({
            v: PROTOCOL_VERSION,
            id: envelope.id,
            scope: 'bg',
            type: `${envelope.type}:error`,
            payload: { message: (err as Error).message },
          } satisfies Envelope);
        } catch {
          /* port closed */
        }
      });
    });
  });

  // ─── Keyboard shortcuts (architecture §4.1 commands) ─────────────────────
  chrome.commands?.onCommand?.addListener((cmd) => {
    if (cmd === 'capture-full-page' || cmd === 'capture-visible') {
      chrome.tabs
        .query({ active: true, currentWindow: true })
        .then(([tab]) => {
          if (!tab?.id) return;
          kickoffCapture(tab.id).catch((err) =>
            console.warn('[shotly:bg] kickoffCapture failed:', err),
          );
        });
    }
  });

  // Eagerly pre-warm offscreen so first capture is fast.
  void ensureOffscreen();
});

// ─── Offscreen lifecycle ─────────────────────────────────────────────────────

async function ensureOffscreen(): Promise<void> {
  if (offscreenReady) return offscreenReady;
  offscreenReady = (async () => {
    try {
      const existing = await chrome.offscreen.hasDocument?.();
      if (!existing) {
        await chrome.offscreen.createDocument({
          url: 'offscreen.html',
          reasons: [chrome.offscreen.Reason.DISPLAY_MEDIA],
          justification:
            'Stitching screenshot chunks via OffscreenCanvas (architecture §3.1)',
        });
      }
      console.info('[shotly:bg] offscreen document ready');
    } catch (err) {
      if (!(err as Error).message.includes('single offscreen')) throw err;
    }
  })();
  return offscreenReady;
}

/**
 * Connect to the offscreen document over the offscreen-port.
 * Deduplicates concurrent connection attempts.
 */
async function getOffscreenPort(): Promise<chrome.runtime.Port> {
  if (offscreenPort) return offscreenPort;
  if (offscreenConnecting) return offscreenConnecting;

  offscreenConnecting = (async () => {
    await ensureOffscreen();
    // Race: offscreen needs to call chrome.runtime.connect({ name: PORT_NAMES.offscreen })
    // We open OUR side; the offscreen listener picks it up.
    const port = chrome.runtime.connect({ name: PORT_NAMES.offscreen });
    // Wait for offscreen to ack via its first message — we resolve when ready.
    await new Promise<void>((resolve) => {
      const onMsg = (msg: unknown) => {
        const env = msg as Envelope;
        if (env?.type === 'offscreen:ready') {
          port.onMessage.removeListener(onMsg);
          resolve();
        }
      };
      port.onMessage.addListener(onMsg);
      // Timeout safety — don't block forever
      setTimeout(resolve, 5_000);
    });
    offscreenPort = port;
    offscreenConnecting = null;
    return port;
  })();
  return offscreenConnecting;
}

function wireOffscreenPort(port: chrome.runtime.Port): void {
  offscreenPort = port;
  port.postMessage({
    v: PROTOCOL_VERSION,
    id: '__boot__',
    scope: 'bg',
    type: 'offscreen:ready',
    payload: { ts: Date.now() },
  } satisfies Envelope);
  console.info('[shotly:bg] offscreen port connected');

  port.onDisconnect.addListener(() => {
    console.warn('[shotly:bg] offscreen port disconnected');
    offscreenPort = null;
    offscreenConnecting = null;
    offscreenReady = null;
    // Any in-flight sessions are now orphaned.
    for (const session of captureSessions.values()) {
      session.offscreenPort = null;
    }
  });
}

// ─── Port message router ─────────────────────────────────────────────────────

async function handlePortMessage(
  port: chrome.runtime.Port,
  env: Envelope,
): Promise<void> {
  const isContent = port.sender?.tab != null;

  // Per-port dedupe by envelope.id. If two listeners slip through (e.g. SW
  // restart during a long capture re-registers onConnect), only the first
  // delivery of any given id runs; the rest are silently dropped.
  // (architecture §2.3 hotfix 2026-07-12)
  // We attach the set to the port itself so popup/offscreen/content all
  // dedupe independently without needing the captureSession to exist yet.
  const portAny = port as chrome.runtime.Port & { __shotlySeen?: Set<string> };
  if (!portAny.__shotlySeen) portAny.__shotlySeen = new Set<string>();
  const seen = portAny.__shotlySeen;
  if (seen.has(env.id)) {
    console.info(`[shotly:bg] drop duplicate message id=${env.id} type=${env.type} on port=${port.name}`);
    return;
  }
  if (seen.size > 512) seen.clear();
  seen.add(env.id);

  switch (env.type) {
    case 'screenshot:ping':
      port.postMessage({
        v: PROTOCOL_VERSION,
        id: env.id,
        scope: 'bg',
        type: 'screenshot:pong',
        payload: { ts: Date.now() },
      } satisfies Envelope);
      break;

    // ─── Popup → bg: kick off the full pipeline ─────────────────────────
    case CAPTURE_MSG.START_FULL: {
      const { tabId } = env.payload as { tabId: number };
      console.info(`[shotly:bg] START_FULL received tabId=${tabId} env.id=${env.id} from port=${port.name}`);
      const ok = await kickoffCapture(tabId, port);
      const reply: StartFullResponse = { ok, tabId, reason: ok ? undefined : 'no_content' };
      port.postMessage({
        v: PROTOCOL_VERSION,
        id: env.id,
        scope: 'bg',
        type: `${CAPTURE_MSG.START_FULL}:ack`,
        payload: reply,
      } satisfies Envelope);
      break;
    }

    // ─── Content → bg: real capture via chrome.tabs.captureVisibleTab ─────
    case CAPTURE_MSG.CAPTURE_CHUNK: {
      const { tabId, segmentIndex } = env.payload as {
        tabId: number;
        segmentIndex: number;
      };
      const result = await captureVisibleTab(tabId, segmentIndex);
      port.postMessage({
        v: PROTOCOL_VERSION,
        id: env.id,
        scope: 'bg',
        type: `${CAPTURE_MSG.CAPTURE_CHUNK}:result`,
        payload: result,
      } satisfies Envelope);
      break;
    }

    // ─── Content → bg: initialize offscreen canvas before chunks arrive ──
    case CAPTURE_MSG.INIT_STITCH: {
      const payload = env.payload as InitStitchPayload;
      const offscreen = await getOffscreenPort();
      relayToOffscreen(offscreen, CAPTURE_MSG.INIT_STITCH, payload);
      port.postMessage({
        v: PROTOCOL_VERSION,
        id: env.id,
        scope: 'bg',
        type: `${CAPTURE_MSG.INIT_STITCH}:ack`,
        payload,
      } satisfies Envelope);
      break;
    }

    // ─── Content → bg: push a chunk bitmap into offscreen stitcher ───────
    case CAPTURE_MSG.STITCH_CHUNK: {
      const payload = env.payload as StitchChunkPayload;
      const offscreen = await getOffscreenPort();
      relayToOffscreen(offscreen, CAPTURE_MSG.STITCH_CHUNK, payload);
      port.postMessage({
        v: PROTOCOL_VERSION,
        id: env.id,
        scope: 'bg',
        type: `${CAPTURE_MSG.STITCH_CHUNK}:ack`,
        payload: { index: payload.index },
      } satisfies Envelope);
      break;
    }

    // ─── Content → bg: ask offscreen to convert canvas → blob ────────────
    case CAPTURE_MSG.FINALIZE: {
      console.info(`[shotly:bg] FINALIZE: get offscreen port (id=${env.id})`);
      const offscreen = await getOffscreenPort();
      console.info(`[shotly:bg] FINALIZE: got offscreen, requesting convertToBlob`);
      const reply = await requestOverOffscreen<unknown, FinalizeResponse>(
        offscreen,
        CAPTURE_MSG.FINALIZE,
        undefined,
      );
      console.info(`[shotly:bg] FINALIZE: got reply byteSize=${reply?.byteSize} blobUrl=${reply?.blobUrl?.slice(0, 30)}`);
      console.info(`[shotly:bg] FINALIZE: post FINALIZE:result to content port`);
      port.postMessage({
        v: PROTOCOL_VERSION,
        id: env.id,
        scope: 'bg',
        type: `${CAPTURE_MSG.FINALIZE}:result`,
        payload: reply,
      } satisfies Envelope);

      // Also notify the popup (if connected) so it can swap UI to "ready".
      const tabId = port.sender?.tab?.id;
      if (tabId != null) {
        const session = captureSessions.get(tabId);
        console.info(`[shotly:bg] FINALIZE: post done to popup (session=${!!session}, tabId=${tabId})`);
        session?.popupPort?.postMessage({
          v: PROTOCOL_VERSION,
          id: env.id,
          scope: 'bg',
          type: 'screenshot:done',
          payload: reply,
        } satisfies Envelope);
      }
      // Cleanup session
      if (tabId != null) {
        captureSessions.delete(tabId);
      }
      break;
    }

    // ─── Popup → bg: cancel any in-flight pipeline for this tab ───────────
    case CAPTURE_MSG.CANCEL: {
      const tabId = (env.payload as { tabId?: number })?.tabId;
      if (tabId == null) {
        for (const id of captureSessions.keys()) await cancelSession(id);
      } else {
        await cancelSession(tabId);
      }
      port.postMessage({
        v: PROTOCOL_VERSION,
        id: env.id,
        scope: 'bg',
        type: `${CAPTURE_MSG.CANCEL}:ack`,
        payload: { ok: true },
      } satisfies Envelope);
      break;
    }

    default:
      console.debug(`[shotly:bg] unhandled message type: ${env.type}`);
  }

  // Bind content/popup ports to session lazily when we see capture traffic
  if (isContent && port.sender?.tab?.id != null) {
    const tabId = port.sender.tab.id;
    let session = captureSessions.get(tabId);
    if (!session) {
      session = {
        tabId,
        contentPort: port,
        popupPort: null,
        offscreenPort: null,
        startedAt: Date.now(),
        chunkCount: 0,
        seenMessageIds: new Set<string>(),
      };
      captureSessions.set(tabId, session);
    } else {
      session.contentPort = port;
    }
  }
}

// ─── Capture core ─────────────────────────────────────────────────────────────

/**
 * Ask the offscreen port to perform a chrome.tabs.captureVisibleTab call.
 * Returns the PNG dataUrl along with its decoded dimensions.
 */
async function captureVisibleTab(
  tabId: number,
  segmentIndex: number,
): Promise<CaptureChunkResponse> {
  const dataUrl = await new Promise<string>(async (resolve, reject) => {
    // ⚠️ Chrome API signature is `captureVisibleTab(windowId, options)` — the
    // first param is the *window* id, NOT the tab id. Passing a tabId by
    // mistake throws "No window with id: <tabId>" which kills the stitch loop
    // and leaves popup with an empty blob. (architecture §3.1 / D+2 fix.)
    let windowId: number | undefined;
    try {
      const tab = await chrome.tabs.get(tabId);
      windowId = tab.windowId;
    } catch (err) {
      reject(new Error(`chrome.tabs.get(${tabId}) failed: ${(err as Error).message}`));
      return;
    }
    chrome.tabs.captureVisibleTab(
      windowId,
      { format: 'png' },
      (url) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!url) {
          reject(new Error('captureVisibleTab returned empty'));
          return;
        }
        resolve(url);
      },
    );
  });

  // Decode dimensions from PNG header (cheap, no need to fully rasterize)
  const { width, height } = await readPngDimensions(dataUrl);

  return {
    dataUrl,
    width,
    height,
    capturedAt: Date.now(),
  };
}

/**
 * Read PNG IHDR for width/height without decoding the full image.
 * Works for data:image/png;base64,... and data:image/png,... (URL-encoded).
 */
async function readPngDimensions(
  dataUrl: string,
): Promise<{ width: number; height: number }> {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) throw new Error('invalid dataUrl');
  const header = dataUrl.slice(comma + 1, comma + 1 + 32);
  const bytes = header.startsWith('data:') || /^[!-/]/.test(header)
    ? new TextEncoder().encode(decodeURIComponent(header))
    : Uint8Array.from(atob(header), (c) => c.charCodeAt(0));

  // PNG signature 8B + IHDR length 4B + 'IHDR' 4B = 16B before width/height
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes.length < 24 ||
    bytes[0] !== 0x89 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x4e ||
    bytes[3] !== 0x47
  ) {
    throw new Error('not a PNG');
  }
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  return { width, height };
}

// ─── Pipeline orchestration ───────────────────────────────────────────────────

/**
 * Kick off a capture pipeline. Called from popup (`START_FULL`) or
 * keyboard shortcut. Connects to the content script (which is auto-
 * injected via manifest `content_scripts.matches: ['<all_urls>']`,
 * `run_at: 'document_idle'`) and asks it to begin scroll-and-capture.
 *
 * NOTE: we intentionally do NOT call `chrome.scripting.executeScript`
 * here. The manifest already injects content.js at document_idle, and
 * a second injection causes TWO content scripts on the same page, each
 * registering its own onConnect listener. That dual-listener race made
 * the bg-init content port disconnect mid-capture and produced empty
 * blob URLs in the popup. (architecture §2.3 hotfix 2026-07-12)
 */
async function kickoffCapture(
  tabId: number,
  popupPort?: chrome.runtime.Port,
): Promise<boolean> {
  await ensureOffscreen();

  // Open the long port from bg to content. We initiate (was previously
  // a 3s race waiting for content to call connect — which it never did,
  // causing `no_content` errors). chrome.tabs.connect is sync from bg's
  // side and fires content's onConnect listener immediately.
  let contentPort: chrome.runtime.Port;
  try {
    contentPort = chrome.tabs.connect(tabId, {
      name: PORT_NAMES.screenshot,
    });
  } catch (err) {
    console.warn('[shotly:bg] tabs.connect failed:', err);
    return false;
  }

  // Wire up content port lifecycle. The bg-initiated port doesn't fire
  // chrome.runtime.onConnect on the bg side, so we have to attach these
  // handlers manually.
  contentPort.onDisconnect.addListener(() => {
    console.info('[shotly:bg] content port disconnected');
    const session = captureSessions.get(tabId);
    if (session?.contentPort === contentPort) {
      session.contentPort = null;
    }
  });
  contentPort.onMessage.addListener((envelope: Envelope) => {
    if (envelope.id === '__heartbeat__') return;
    handlePortMessage(contentPort, envelope).catch((err) => {
      console.error('[shotly:bg] content port handlePortMessage error:', err);
      try {
        contentPort.postMessage({
          v: PROTOCOL_VERSION,
          id: envelope.id,
          scope: 'bg',
          type: `${envelope.type}:error`,
          payload: { message: (err as Error).message },
        } satisfies Envelope);
      } catch {
        /* port closed */
      }
    });
  });

  // Tell content to start. Bind the popup port (when invoked via START_FULL)
  console.info(
    `[shotly:bg] kickoffCapture tabId=${tabId} popupPort=${popupPort ? 'set' : 'unset'} sender=${JSON.stringify({
      tab: popupPort?.sender?.tab?.id,
      url: popupPort?.sender?.url,
    })}`,
  );
  // so the content → bg pipeline-event relay has somewhere to forward to —
  // otherwise session.popupPort is permanently null and the popup UI sits
  // in 'starting' state forever.
  const session: CaptureSession = {
    tabId,
    contentPort,
    popupPort: popupPort ?? null,
    offscreenPort: null,
    startedAt: Date.now(),
    chunkCount: 0,
    seenMessageIds: new Set<string>(),
  };
  captureSessions.set(tabId, session);

  // Forward content-side pipeline events (progress / error / too-long /
  // done / plan-result) to the popup so its UI can leave the 'starting'
  // state. Without this relay, the popup sits at 'starting' forever
  // because handlePortMessage has no cases for these content-originated
  // types and silently drops them. (architecture §2.3 / popup App.vue.)
  const RELAY_TYPES = new Set([
    'screenshot:progress',
    'screenshot:error',
    'screenshot:too-long',
    'screenshot:done',
    'screenshot:plan-result',
  ]);
  contentPort.onMessage.addListener((envelope: Envelope) => {
    if (!RELAY_TYPES.has(envelope.type)) return;
    const live = captureSessions.get(tabId);
    if (!live?.popupPort) {
      console.warn(`[shotly:bg] relay skip ${envelope.type}: popupPort not bound`);
      return;
    }
    console.info(`[shotly:bg] relay → popup: ${envelope.type}`, envelope.payload);
    try {
      live.popupPort.postMessage(envelope);
    } catch (err) {
      console.warn(`[shotly:bg] relay post to popup failed:`, err);
    }
  });

  contentPort.postMessage({
    v: PROTOCOL_VERSION,
    id: crypto.randomUUID(),
    scope: 'bg',
    type: 'screenshot:start',
    payload: { tabId },
  } satisfies Envelope);

  return true;
}

async function cancelSession(tabId: number): Promise<void> {
  const session = captureSessions.get(tabId);
  if (!session) return;
  session.contentPort?.postMessage({
    v: PROTOCOL_VERSION,
    id: crypto.randomUUID(),
    scope: 'bg',
    type: 'screenshot:abort',
    payload: { reason: 'user_cancelled' },
  } satisfies Envelope);
  // Tell offscreen to reset its canvas
  try {
    const offscreen = await getOffscreenPort();
    relayToOffscreen(offscreen, CAPTURE_MSG.RESET_STITCH, undefined);
  } catch {
    /* ignore */
  }
  captureSessions.delete(tabId);
}

// ─── Offscreen relay helpers ──────────────────────────────────────────────────

function relayToOffscreen(
  port: chrome.runtime.Port,
  type: string,
  payload: unknown,
): void {
  port.postMessage({
    v: PROTOCOL_VERSION,
    id: crypto.randomUUID(),
    scope: 'bg',
    type,
    payload,
  } satisfies Envelope);
}

function requestOverOffscreen<TReq, TRes>(
  port: chrome.runtime.Port,
  type: string,
  payload: TReq,
  timeoutMs = 60_000,
): Promise<TRes> {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      port.onMessage.removeListener(listener);
      reject(new Error(`offscreen '${type}' (id=${id}) timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    function listener(msg: unknown) {
      const env = msg as Envelope<TRes>;
      if (env?.id !== id) return;
      clearTimeout(timer);
      port.onMessage.removeListener(listener);
      if (env.type === `${type}:error`) {
        reject(new Error((env.payload as { message: string })?.message ?? 'offscreen error'));
      } else if (env.type === `${type}:result`) {
        resolve(env.payload as TRes);
      } else {
        // Unexpected type — treat as error so caller doesn't hang.
        reject(new Error(`offscreen '${type}' got unexpected reply: ${env.type}`));
      }
    }

    port.onMessage.addListener(listener);
    port.postMessage({
      v: PROTOCOL_VERSION,
      id,
      scope: 'bg',
      type,
      payload,
    } satisfies Envelope);
  });
}