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

import { readPngDimensions } from '@/utils/png';
import {
  CAPTURE_MSG,
  EXPORT_MSG,
  PORT_NAMES,
  PROTOCOL_VERSION,
  REGION_MSG,
  type CaptureChunkResponse,
  type Envelope,
  type ExportConvertRequest,
  type ExportConvertResponse,
  type FinalizeResponse,
  type InitStitchPayload,
  type RegionAckResponse,
  type RegionSelectedPayload,
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
  /**
   * Region flow only: when the popup is gone (the user has to click on
   * the page to drag the selection, which closes the popup!) the capture
   * is saved to the download folder instead of being thrown away.
   */
  autoDownload?: boolean;
}
const captureSessions = new Map<number, CaptureSession>();

/**
 * Maps a port to the tab it belongs to.
 *
 * `port.sender` is only populated on the *receiving* end of a connection.
 * The background initiates the content connection via
 * `chrome.tabs.connect(tabId, …)`, so on the background side
 * `port.sender` is `undefined` — `port.sender?.tab?.id` would be
 * `undefined` and the session lookup would silently miss. This map is the
 * reliable source of truth for "which tab is this port talking about".
 */
const portTabIds = new WeakMap<chrome.runtime.Port, number>();

/** Single offscreen document — Chrome constraint. */
let offscreenDocumentPromise: Promise<void> | null = null;

/** Single offscreen port — bg is the only peer. */
let offscreenPort: chrome.runtime.Port | null = null;
/**
 * True once the offscreen document completed the `offscreen:ready`
 * handshake on the *current* port. The offscreen registers its
 * `port.onMessage` handler before announcing itself, so this flag means
 * "the offscreen is listening and can receive stitch traffic".
 */
let offscreenPortReady = false;

/**
 * Relayed offscreen requests → the content request that caused them.
 *
 * The offscreen gets its own request id, so its replies cannot be
 * correlated with the content script's request on their own. This map
 * keeps the link so that an offscreen failure (e.g. the stitch canvas
 * exceeding Chrome's 65_535px limit once the real device scale is
 * known) can be reported to the exact caller instead of vanishing.
 *
 * Entries are removed as soon as they are answered — see the
 * `wireOffscreenPort` listener.
 */
const offscreenRelays = new Map<string, { port: chrome.runtime.Port; requestId: string }>();
/** Resolvers waiting for the offscreen document to connect + handshake. */
const offscreenWaiters = new Set<(port: chrome.runtime.Port) => void>();

/** How long to wait for the offscreen document to connect + handshake. */
const OFFSCREEN_CONNECT_TIMEOUT_MS = 8_000;

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
    wiredPorts.add(port);

    // Special-case: the offscreen document owns its own port lifecycle
    // (see entrypoints/offscreen/main.ts — it calls chrome.runtime.connect
    // when it boots and re-connects on demand). It must be wired BEFORE the
    // sender-key dedupe below, otherwise a legitimate re-connect (same
    // sender URL) would be dropped as a "duplicate".
    if (port.name === PORT_NAMES.offscreen) {
      wireOffscreenPort(port);
      return;
    }

    const senderKey = `${port.name}|${port.sender?.tab?.id ?? ''}|${port.sender?.url ?? port.sender?.id ?? ''}`;
    if (wiredSenderKeys.has(senderKey)) {
      console.info(`[shotly:bg] onConnect sender already wired, skipping key=${senderKey}`);
      return;
    }
    wiredSenderKeys.add(senderKey);

    const scope: Scope = portScope(port);

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
  // Only the full-page command exists. A `capture-visible` shortcut used to
  // be declared, but it was routed here too — so it silently produced a
  // full-page image. It was removed rather than shipped as a false claim;
  // see the note in wxt.config.ts.
  chrome.commands?.onCommand?.addListener((cmd) => {
    if (cmd === 'capture-full-page') {
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
  if (offscreenDocumentPromise) return offscreenDocumentPromise;
  offscreenDocumentPromise = (async () => {
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

    // The offscreen document may already exist from a previous service
    // worker lifetime, in which case its port is dead but the document
    // is alive. Ask it to (re)connect. This is a ONE-SHOT request — the
    // offscreen never reconnects on its own — so the MV3 service worker
    // is not kept alive by a reconnect loop.
    void requestOffscreenConnect();
  })();
  return offscreenDocumentPromise;
}

/**
 * Ask the offscreen document to (re)connect its port.
 *
 * The offscreen document owns its port (see entrypoints/offscreen/main.ts)
 * because `chrome.offscreen.createDocument()` resolves as soon as the
 * document exists — it does NOT wait for the document's script to
 * evaluate, so a worker-initiated `chrome.runtime.connect()` races the
 * offscreen's own `onConnect` registration.
 *
 * The message can legitimately be lost when the offscreen script has not
 * evaluated yet. That is fine: the offscreen self-connects on boot, so
 * the "active request" and the "passive request" paths complement each
 * other instead of depending on one another.
 */
async function requestOffscreenConnect(): Promise<void> {
  try {
    await chrome.runtime.sendMessage({ type: 'shotly:offscreen:connect' });
    console.info('[shotly:bg] offscreen connect requested');
  } catch (err) {
    const raw = (err as Error)?.message ?? String(err);
    // "Could not establish connection. Receiving end does not exist." means
    // the offscreen document is not there (yet) — the offscreen will connect
    // on its own as soon as it boots, so this is not an error worth logging.
    if (!raw.includes('Could not establish connection')) {
      console.warn('[shotly:bg] offscreen connect request failed:', raw);
    }
  }
}

/**
 * Wait until the offscreen document has connected AND completed the
 * `offscreen:ready` handshake on the current port.
 *
 * The offscreen installs its `port.onMessage` listener *before* it
 * announces readiness, so `offscreen:ready` is a reliable signal that
 * stitch traffic will be received.
 */
function waitForOffscreenPort(
  timeoutMs: number = OFFSCREEN_CONNECT_TIMEOUT_MS,
): Promise<chrome.runtime.Port> {
  if (offscreenPort && offscreenPortReady) {
    return Promise.resolve(offscreenPort);
  }

  return new Promise<chrome.runtime.Port>((resolve, reject) => {
    const onReady = (port: chrome.runtime.Port) => {
      clearTimeout(timer);
      resolve(port);
    };
    const timer = setTimeout(() => {
      offscreenWaiters.delete(onReady);
      reject(
        new Error(
          `[shotly:bg] offscreen document did not connect within ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);
    offscreenWaiters.add(onReady);
  });
}

/** Resolve every pending waiter — the offscreen is ready. */
function flushOffscreenWaiters(port: chrome.runtime.Port): void {
  if (offscreenWaiters.size === 0) return;
  for (const resolve of [...offscreenWaiters]) {
    offscreenWaiters.delete(resolve);
    resolve(port);
  }
}

/**
 * Get the live offscreen port, waiting for the handshake if needed.
 *
 * Order matters: the waiter is registered BEFORE we ask the offscreen to
 * (re)connect, so a fast connect cannot land before anybody is listening.
 */
async function getOffscreenPort(): Promise<chrome.runtime.Port> {
  if (offscreenPort && offscreenPortReady) return offscreenPort;

  const waiter = waitForOffscreenPort(OFFSCREEN_CONNECT_TIMEOUT_MS);
  await ensureOffscreen();
  void requestOffscreenConnect();
  return waiter;
}

/**
 * Decide whether a port belongs to a content script or to the popup.
 *
 * The popup is an extension page, so its sender URL starts with
 * `chrome-extension://`. The content script runs inside a web page, so
 * its sender URL is the page URL and it carries a `sender.tab`.
 *
 * We must NOT rely on `sender.tab != null` alone: when the popup is
 * opened as a regular tab (which is exactly what the E2E harness does
 * with `chrome-extension://<id>/popup.html?testTabId=…`), it also has a
 * `sender.tab` and would be misclassified as a content script — binding
 * the popup port to `session.contentPort` and hijacking the pipeline.
 */
function portScope(port: chrome.runtime.Port): Scope {
  const senderUrl = port.sender?.url ?? '';
  if (senderUrl.startsWith('chrome-extension://')) return 'popup';
  if (port.sender?.tab != null) return 'content';
  // Background-initiated content port: `port.sender` is undefined on the
  // initiating side, but we recorded the tabId when we opened it.
  if (portTabIds.has(port)) return 'content';
  return 'popup';
}

/**
 * Resolve the tab a port is talking about.
 *
 * Prefers the explicit map (background-initiated `chrome.tabs.connect`
 * ports) and falls back to `port.sender?.tab?.id` for ports the
 * background did not open (e.g. a content script that connected on its own).
 */
function tabIdForPort(port: chrome.runtime.Port): number | undefined {
  const mapped = portTabIds.get(port);
  if (mapped != null) return mapped;
  return port.sender?.tab?.id;
}

/**
 * Wire an inbound offscreen port.
 *
 * The offscreen document opens this port, so we receive it via
 * `chrome.runtime.onConnect`. A legitimate reconnect carries the same
 * sender URL as the previous one, so this path must stay OUTSIDE the
 * sender-key dedupe.
 */
function wireOffscreenPort(port: chrome.runtime.Port): void {
  offscreenPort = port;
  offscreenPortReady = false;
  console.info('[shotly:bg] offscreen port connected');

  port.onMessage.addListener((env: Envelope) => {
    if (env?.type === 'offscreen:ready' || env?.type === 'offscreen:pong') {
      offscreenPortReady = true;
      console.info('[shotly:bg] offscreen document ready');
      flushOffscreenWaiters(port);
      return;
    }
    // ⚠️ Offscreen errors used to die here.
    //
    // The offscreen document is the only place that can fail *after* the
    // content script handed over a request — e.g. the stitch canvas turns
    // out to exceed Chrome's 65_535px canvas limit once the real device
    // scale is known. The offscreen answers with `<type>:error`, but this
    // listener used to drop everything that was not ready/pong, so the
    // content script sat waiting for an ack that never came and the popup
    // hung until the 30s request timeout fired with a misleading
    // "timed out" message.
    //
    // Now the error is routed back to the exact content request that
    // caused it (the relay map remembers the original request id), so the
    // user sees the real reason.
    if (typeof env?.type === 'string' && env.type.endsWith(':error')) {
      const relay = offscreenRelays.get(env.id);
      offscreenRelays.delete(env.id);
      const message = (env.payload as { message?: string } | undefined)?.message ?? env.type;
      console.error(`[shotly:bg] offscreen error (${env.type}): ${message}`);
      if (relay) {
        try {
          relay.port.postMessage({
            v: PROTOCOL_VERSION,
            id: relay.requestId,
            scope: 'bg',
            type: env.type,
            payload: { message },
          } satisfies Envelope);
        } catch {
          /* content port already closed */
        }
      }
    }
  });

  // The offscreen posts `offscreen:ready` immediately after connecting.
  // That message can arrive BEFORE this listener is attached (the port
  // object only exists once onConnect fires, and the offscreen does not
  // wait for us), which would drop it. So we also send our own ping —
  // issued *after* the listener is attached — and treat the pong as
  // equally valid proof of readiness.
  try {
    port.postMessage({
      v: PROTOCOL_VERSION,
      id: crypto.randomUUID(),
      scope: 'bg',
      type: 'offscreen:ping',
      payload: { ts: Date.now() },
    } satisfies Envelope);
  } catch {
    /* port already dead — onDisconnect will clean up */
  }

  port.onDisconnect.addListener(() => {
    console.warn('[shotly:bg] offscreen port disconnected');
    if (offscreenPort === port) {
      offscreenPort = null;
      offscreenPortReady = false;
    }
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
  const isContent = portScope(port) === 'content';

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

    // ─── Popup → bg → content: open the region selector ─────────────────
    case REGION_MSG.START: {
      const { tabId } = env.payload as { tabId: number };
      console.info(`[shotly:bg] REGION_START received tabId=${tabId} env.id=${env.id}`);
      const ok = await kickoffRegionSelection(tabId, port);
      const reply: RegionAckResponse = { ok, tabId, reason: ok ? undefined : 'no_content' };
      port.postMessage({
        v: PROTOCOL_VERSION,
        id: env.id,
        scope: 'bg',
        type: `${REGION_MSG.START}:ack`,
        payload: reply,
      } satisfies Envelope);
      break;
    }

    // ─── Content → bg: the user picked (or cancelled) a region ──────────
    case REGION_MSG.SELECTED:
    case REGION_MSG.CANCELLED: {
      const tabId = tabIdForPort(port);
      const session = tabId != null ? captureSessions.get(tabId) : undefined;
      if (env.type === REGION_MSG.SELECTED) {
        const picked = env.payload as RegionSelectedPayload;
        console.info(
          `[shotly:bg] region selected ${picked?.region?.width}×${picked?.region?.height} @ ${picked?.region?.x},${picked?.region?.y}`,
        );
      }
      if (session?.popupPort) {
        try {
          session.popupPort.postMessage({
            v: PROTOCOL_VERSION,
            id: env.id,
            scope: 'bg',
            type: env.type,
            payload: env.payload,
          } satisfies Envelope);
        } catch (err) {
          console.warn('[shotly:bg] region reply to popup failed:', err);
        }
      }
      if (env.type === REGION_MSG.CANCELLED) {
        // Nothing to capture — tear the session down so the SW can idle.
        if (tabId != null) captureSessions.delete(tabId);
        try {
          port.disconnect();
        } catch {
          /* already gone */
        }
      }
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
      const relayId = relayToOffscreen(offscreen, CAPTURE_MSG.INIT_STITCH, payload);
      offscreenRelays.set(relayId, { port, requestId: env.id });
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
      const relayId = relayToOffscreen(offscreen, CAPTURE_MSG.STITCH_CHUNK, payload);
      offscreenRelays.set(relayId, { port, requestId: env.id });
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
      const tabId = tabIdForPort(port);
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
        // Cleanup session — but keep region sessions alive: the content
        // script emits its own 'screenshot:done' right after, and that is
        // the event that triggers the download fallback (the popup is
        // usually gone by then) plus the port cleanup.
        if (!session?.autoDownload) {
          captureSessions.delete(tabId);
        }
      }
      break;
    }

    // ─── Popup → bg → offscreen: convert a capture into PNG/JPG/PDF ──────
    case EXPORT_MSG.CONVERT: {
      const req = env.payload as ExportConvertRequest;
      console.info(`[shotly:bg] EXPORT_CONVERT format=${req?.format} id=${env.id}`);
      const offscreen = await getOffscreenPort();
      const reply = await requestOverOffscreen<
        ExportConvertRequest,
        ExportConvertResponse
      >(offscreen, EXPORT_MSG.CONVERT, req);
      port.postMessage({
        v: PROTOCOL_VERSION,
        id: env.id,
        scope: 'bg',
        type: `${EXPORT_MSG.CONVERT}:result`,
        payload: reply,
      } satisfies Envelope);
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
  if (isContent && tabIdForPort(port) != null) {
    const tabId = tabIdForPort(port)!;
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
    // ⚠️ `captureVisibleTab` shoots the ACTIVE tab of that window, and it
    // never tells us which one that was. If some other tab is in front, we
    // would happily stitch a screenshot of the wrong page — with no error
    // anywhere. Check it explicitly before every chunk.
    try {
      const [activeTab] = await chrome.tabs.query({
        active: true,
        windowId,
      });
      if (activeTab?.id !== tabId) {
        reject(
          new Error(
            `capture target mismatch: tab ${tabId} is not the active tab of window ${windowId} (active=${activeTab?.id ?? 'none'})`,
          ),
        );
        return;
      }
    } catch (err) {
      if ((err as Error).message.includes('capture target mismatch')) {
        reject(err);
        return;
      }
      // A failed guard query must not block the capture — log and continue.
      console.warn('[shotly:bg] active-tab guard query failed:', err);
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

  // The captured bitmap is in DEVICE pixels. The stitcher works in CSS
  // pixels, so this is where the ratio shows up — log it, because a
  // mismatch here is the difference between a sharp capture and a
  // silently downscaled one.
  console.info(
    `[shotly:bg] capture chunk ${segmentIndex}: ${width}×${height} device px`,
  );

  return {
    dataUrl,
    width,
    height,
    capturedAt: Date.now(),
  };
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

  // ⚠️ `chrome.tabs.captureVisibleTab(windowId, …)` captures the **active
  // tab of that window** — it takes a windowId, NOT a tabId. If any other
  // tab sits in front of the one we want (e.g. the popup opened as a
  // regular tab, which is exactly what the E2E harness does), the capture
  // silently returns a screenshot of the WRONG page and the stitched
  // result is garbage — with no error anywhere.
  //
  // Make the target tab active before the pipeline starts. In the normal
  // user flow it is already active, so this is a no-op.
  try {
    await chrome.tabs.update(tabId, { active: true });
  } catch (err) {
    console.warn('[shotly:bg] tabs.update(active) failed:', err);
  }

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
  portTabIds.set(contentPort, tabId);

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
  forwardContentEvents(contentPort, tabId);

  contentPort.postMessage({
    v: PROTOCOL_VERSION,
    id: crypto.randomUUID(),
    scope: 'bg',
    type: 'screenshot:start',
    payload: { tabId },
  } satisfies Envelope);

  return true;
}

/**
 * Kick off the region flow (architecture §3.2, decision B1).
 *
 * Unlike the full-page pipeline this one is *interactive*: the content
 * script opens a drag-select overlay and waits for the user. The port has
 * to stay alive for as long as the user takes — the content heartbeat
 * (25s) keeps the SW awake in the meantime.
 */
async function kickoffRegionSelection(
  tabId: number,
  popupPort: chrome.runtime.Port,
): Promise<boolean> {
  let contentPort: chrome.runtime.Port;
  try {
    // Same reasoning as kickoffCapture: the manifest already injects the
    // content script, so we only open a port — never inject a second copy.
    contentPort = chrome.tabs.connect(tabId, { name: PORT_NAMES.screenshot });
  } catch (err) {
    console.warn('[shotly:bg] region tabs.connect failed:', err);
    return false;
  }
  portTabIds.set(contentPort, tabId);

  const session: CaptureSession = {
    tabId,
    contentPort,
    popupPort: popupPort ?? null,
    offscreenPort: null,
    startedAt: Date.now(),
    chunkCount: 0,
    seenMessageIds: new Set<string>(),
    autoDownload: true,
  };
  captureSessions.set(tabId, session);

  contentPort.onDisconnect.addListener(() => {
    console.info('[shotly:bg] region content port disconnected');
    const live = captureSessions.get(tabId);
    if (live?.contentPort === contentPort) {
      captureSessions.delete(tabId);
    }
  });
  contentPort.onMessage.addListener((envelope: Envelope) => {
    if (envelope.id === '__heartbeat__') return;
    handlePortMessage(contentPort, envelope).catch((err) => {
      console.error('[shotly:bg] region content handlePortMessage error:', err);
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
  forwardContentEvents(contentPort, tabId);

  contentPort.postMessage({
    v: PROTOCOL_VERSION,
    id: crypto.randomUUID(),
    scope: 'bg',
    type: REGION_MSG.START,
    payload: { tabId },
  } satisfies Envelope);

  return true;
}

/**
 * Relay content-originated pipeline events to the popup.
 *
 * The region flow additionally saves the capture to the download folder
 * when the popup is no longer connected — clicking on the page to drag
 * the selection closes the extension popup, so this is the *normal* path
 * for a real user, not an edge case.
 */
function forwardContentEvents(
  contentPort: chrome.runtime.Port,
  tabId: number,
): void {
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
    if (live?.popupPort) {
      console.info(`[shotly:bg] relay → popup: ${envelope.type}`, envelope.payload);
      try {
        live.popupPort.postMessage(envelope);
      } catch (err) {
        console.warn(`[shotly:bg] relay post to popup failed:`, err);
      }
    } else if (envelope.type === 'screenshot:done' && live?.autoDownload) {
      void autoDownloadCapture(envelope.payload as FinalizeResponse);
    }
    if (envelope.type === 'screenshot:done' && live?.autoDownload) {
      // The region flow owns its port — close it so the SW can go idle
      // again instead of heart-beating forever.
      captureSessions.delete(tabId);
      try {
        contentPort.disconnect();
      } catch {
        /* already closed */
      }
    }
  });
}

/**
 * Save a finished capture to the user's download folder.
 *
 * Used when the popup was closed before the capture finished (the user
 * had to leave the popup to drag the selection rectangle on the page).
 */
async function autoDownloadCapture(payload: FinalizeResponse): Promise<void> {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `shotly-region-${stamp}.png`;
    await chrome.downloads.download({ url: payload.blobUrl, filename, saveAs: false });
    console.info(`[shotly:bg] region capture saved as ${filename}`);
  } catch (err) {
    console.warn('[shotly:bg] region auto-download failed:', err);
  }
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
): string {
  const id = crypto.randomUUID();
  try {
    port.postMessage({
      v: PROTOCOL_VERSION,
      id,
      scope: 'bg',
      type,
      payload,
    } satisfies Envelope);
  } catch (err) {
    // Chrome throws a raw "Attempting to use a disconnected port object"
    // when the peer went away. Never surface that string to the popup —
    // wrap it with actionable context instead.
    throw new Error(
      `[shotly:bg] failed to relay '${type}' to offscreen: ${describePortError(err)}`,
    );
  }
  return id;
}

/**
 * Human-readable reason for a dead offscreen port.
 *
 * Chrome's raw message ("Attempting to use a disconnected port object")
 * is meaningless to users, so we translate it into something actionable.
 */
function describePortError(err: unknown): string {
  const raw = (err as Error)?.message ?? String(err);
  if (raw.includes('disconnected port')) {
    return 'the offscreen document connection was closed — try the capture again';
  }
  return raw;
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
    try {
      port.postMessage({
        v: PROTOCOL_VERSION,
        id,
        scope: 'bg',
        type,
        payload,
      } satisfies Envelope);
    } catch (err) {
      clearTimeout(timer);
      port.onMessage.removeListener(listener);
      reject(
        new Error(
          `[shotly:bg] failed to request '${type}' from offscreen: ${describePortError(err)}`,
        ),
      );
    }
  });
}