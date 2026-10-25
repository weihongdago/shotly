/**
 * Shotly messaging layer (architecture v1.2 §2.3)
 *
 * Two transport modes:
 *   - `sendMessage` for instantaneous request/response (< 2s)
 *   - `connect` long-port for screenshot pipeline (30s~90s)
 *     because MV3 Service Worker is killed after 30s of inactivity.
 *
 * Heartbeat is set to 20s (less than Chrome's 30s SW idle threshold).
 */

export const PROTOCOL_VERSION = 1 as const;

export type Scope =
  | 'bg'
  | 'content'
  | 'popup'
  | 'offscreen'
  | 'options';

export interface Envelope<T = unknown> {
  v: typeof PROTOCOL_VERSION;
  id: string;
  scope: Scope;
  type: string;
  payload?: T;
}

export const PORT_NAMES = {
  /**
   * screenshot-port — long-lived port for the full-page capture pipeline.
   * Connected from: content script (per-tab) + popup (per-session).
   * 20s heartbeat on each side keeps the SW alive during 30-90s pipelines.
   */
  screenshot: 'screenshot-port',
  /**
   * offscreen-port — bg ↔ offscreen relay for the OffscreenCanvas stitcher.
   * Single instance (Chrome allows one offscreen doc). Bg maintains the only
   * connection and forwards `stitch-chunk` / `finalize` messages from content.
   */
  offscreen: 'offscreen-port',
  /** history-port — popup ↔ bg for screenshot history listing. */
  history: 'history-port',
  /** license-port — popup ↔ bg for Pro license validation. */
  license: 'license-port',
} as const;

export type PortName = (typeof PORT_NAMES)[keyof typeof PORT_NAMES];

/**
 * Capture pipeline envelope types (architecture v1.2 §2.3, §3.1).
 *
 * Flow:
 *   popup --[screenshot:start]--> bg --relay--> content
 *   content --[screenshot:capture-chunk]--> bg --[chrome.tabs.captureVisibleTab]--> returns dataUrl
 *   content --[screenshot:stitch-chunk]--> bg --relay--> offscreen (drawImage on OffscreenCanvas)
 *   content --[screenshot:finalize]--> bg --relay--> offscreen --convertToBlob--> blobUrl
 *   bg --[screenshot:done]--> content & popup
 */
export const CAPTURE_MSG = {
  /** content → bg: request a capture of the currently-visible viewport of `tabId`. */
  CAPTURE_CHUNK: 'screenshot:capture-chunk',
  /** content → bg: push a captured chunk bitmap to the offscreen stitcher. */
  STITCH_CHUNK: 'screenshot:stitch-chunk',
  /** content → bg: ask offscreen to convert its canvas to a Blob and return a blob URL. */
  FINALIZE: 'screenshot:finalize',
  /** bg → offscreen: reset/initialize the OffscreenCanvas for a new capture. */
  INIT_STITCH: 'screenshot:init-stitch',
  /** bg → offscreen: clean up canvas + revoke any blob URL. */
  RESET_STITCH: 'screenshot:reset-stitch',
  /** popup → bg: kick off the full capture pipeline against the active tab. */
  START_FULL: 'screenshot:start-full',
  /** popup → bg: cancel any in-flight capture for this tab. */
  CANCEL: 'screenshot:cancel',
} as const;

export type CaptureMsg = (typeof CAPTURE_MSG)[keyof typeof CAPTURE_MSG];

export interface CaptureChunkPayload {
  index: number;
  dataUrl: string;
  segmentHeight: number;
  capturedAt: number;
}

export interface CaptureChunkRequest {
  tabId: number;
  segmentIndex: number;
}

export interface CaptureChunkResponse {
  dataUrl: string;
  width: number;
  height: number;
  capturedAt: number;
}

export interface StitchChunkPayload {
  index: number;
  dataUrl: string;
  segmentHeight: number;
  viewportWidth: number;
  offsetY: number;
}

export interface InitStitchPayload {
  viewportWidth: number;
  totalHeight: number;
}

export interface FinalizeResponse {
  blobUrl: string;
  width: number;
  height: number;
  byteSize: number;
}

export interface StartFullRequest {
  tabId: number;
  segmentHeight?: number;
}

export interface StartFullResponse {
  ok: boolean;
  tabId: number;
  reason?: string;
}

/**
 * Open a long-lived port to the background SW.
 * Heartbeat is 20s — keeps the SW alive during long screenshot pipelines.
 *
 * Caller MUST handle `onDisconnect` to clear its own timers.
 */
export function openPort(name: PortName): chrome.runtime.Port {
  const port = chrome.runtime.connect({ name });
  // Heartbeat to prevent SW idle kill (architecture §2.3.3)
  const heartbeat = setInterval(() => {
    try {
      port.postMessage({
        v: PROTOCOL_VERSION,
        id: cryptoRandomId(),
        scope: 'bg',
        type: 'screenshot:heartbeat',
      } satisfies Envelope);
    } catch {
      // Port is closed — cleanup will happen via onDisconnect
      clearInterval(heartbeat);
    }
  }, 20_000);
  port.onDisconnect.addListener(() => clearInterval(heartbeat));
  return port;
}

/**
 * Wrap a port with typed request/response matching via `id`.
 * Returns a Promise for the matching response envelope (same `id`).
 *
 * Times out after `timeoutMs` (default 90s) to prevent stuck promises.
 */
export function requestOverPort<TReq, TRes>(
  port: chrome.runtime.Port,
  type: string,
  payload: TReq,
  timeoutMs = 90_000,
): Promise<Envelope<TRes>> {
  return new Promise((resolve, reject) => {
    const id = cryptoRandomId();
    const timer = setTimeout(() => {
      port.onMessage.removeListener(listener);
      reject(new Error(`[shotly] port request '${type}' (id=${id}) timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    function listener(msg: unknown) {
      const env = msg as Envelope;
      if (env?.id !== id) return;
      clearTimeout(timer);
      port.onMessage.removeListener(listener);
      resolve(env as Envelope<TRes>);
    }

    port.onMessage.addListener(listener);
    port.postMessage({
      v: PROTOCOL_VERSION,
      id,
      scope: 'bg',
      type,
      payload,
    } satisfies Envelope<TReq>);
  });
}

/** Simple random id (no PII, no analytics). */
export function cryptoRandomId(): string {
  return crypto.randomUUID();
}

/** Sleep helper — used for retry/backoff in capture pipeline. */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}