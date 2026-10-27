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

import type { ExportFormat } from './export';

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

/**
 * Export pipeline (architecture v1.2 §3.1 — "offscreen document owns
 * OffscreenCanvas stitching, PDF encoding").
 *
 * Flow:
 *   popup --[export:convert]--> bg --relay--> offscreen
 *   offscreen --(canvas/pdf-lib)--> blobUrl --result--> bg --relay--> popup
 *   popup --(anchor download / navigator.clipboard)--> user's disk / clipboard
 *
 * The popup never touches image bytes directly: it only ever holds the
 * `blobUrl` minted by the offscreen document. That keeps the heavy
 * pdf-lib bundle out of the popup's critical path (popup must open fast)
 * and out of the SW (which has no DOM).
 */
export const EXPORT_MSG = {
  /** popup → bg → offscreen: convert a captured blob into a target format. */
  CONVERT: 'export:convert',
} as const;

export type ExportMsg = (typeof EXPORT_MSG)[keyof typeof EXPORT_MSG];

/**
 * Region capture protocol (architecture v1.2 §3.2 — decision B1:
 * "矩形框选（拖拽）+ 智能元素吸附（v1.1 增强）").
 *
 * Flow:
 *   popup --[region:start]--> bg --relay--> content
 *   content opens the drag-select overlay, then answers with either
 *   --[region:selected]--> (page-absolute rect) or --[region:cancelled]-->.
 *   bg relays the answer back to the popup.
 *
 * The actual pixel capture reuses the regular screenshot pipeline
 * (`CAPTURE_MSG.*`) — only the *geometry* differs (see StitchChunkPayload.crop).
 */
export const REGION_MSG = {
  /** popup → bg → content: 启动区域选择 */
  START: 'region:start',
  /** content → bg: 选区确定（页面绝对坐标） */
  SELECTED: 'region:selected',
  /** content → bg: 用户取消 */
  CANCELLED: 'region:cancelled',
} as const;

export type RegionMsg = (typeof REGION_MSG)[keyof typeof REGION_MSG];

/**
 * A rectangle in **page-absolute CSS pixels** (same coordinate space as
 * `MouseEvent.pageX/pageY`), NOT viewport coordinates.
 *
 * Single source of truth: defined here (protocol layer) and re-exported by
 * `utils/region-selector.ts` — never declared twice.
 */
export interface RegionSelection {
  /** 页面绝对坐标 */
  x: number;
  y: number;
  width: number;
  height: number;
}

/** popup → bg: start a region selection on the given tab. */
export interface RegionStartRequest {
  tabId: number;
}

/** content → bg: the user finished dragging a rectangle. */
export interface RegionSelectedPayload {
  region: RegionSelection;
}

/** bg → popup: the region flow reached a terminal state. */
export interface RegionAckResponse {
  ok: boolean;
  tabId: number;
  reason?: string;
}

/**
 * Supported export formats (PRD v1 §3.2 F4/F5 — PNG/JPG/PDF).
 *
 * `ExportFormat` itself is defined in `utils/export.ts` (the module that owns
 * the MIME / extension tables) and only *imported* here — re-exporting it
 * would make WXT's auto-import registry see the same name in two modules and
 * emit a "Duplicated imports" warning at build time.
 */

export interface ExportConvertRequest {
  /** blobUrl previously minted by the offscreen document. */
  sourceBlobUrl: string;
  format: ExportFormat;
  /** JPEG quality 0..1. Ignored for png/pdf. Defaults to 0.92. */
  quality?: number;
}

export interface ExportConvertResponse {
  blobUrl: string;
  format: ExportFormat;
  mimeType: string;
  byteSize: number;
  width: number;
  height: number;
}

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

/**
 * Source rectangle inside a captured bitmap, in **bitmap (device) pixels**.
 *
 * Used by the region pipeline: the offscreen stitcher crops each captured
 * viewport down to the part that overlaps the selected region, so the full
 * viewport bitmaps never have to be re-encoded on the content side.
 */
export interface CropRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

export interface StitchChunkPayload {
  index: number;
  dataUrl: string;
  segmentHeight: number;
  viewportWidth: number;
  offsetY: number;
  /**
   * Device pixels per CSS pixel for this bitmap.
   *
   * Resolved by the content script (`resolveDeviceScale`) — it can see both
   * the page's `devicePixelRatio` and the real bitmap size, so it is the
   * only place that can get this right.
   *
   * ⚠️ The stitcher MUST use this exact number for the canvas size and
   * the draw rectangles. Deriving its own scale from the bitmap makes the
   * image stretch: `captureVisibleTab` grabs the browser *widget*, which
   * is often larger than the page's layout viewport (a 1282×839 widget
   * rasterising a 1280×800 viewport reads as 2.0975× instead of 2×), and
   * the crop the content script computed with the true scale no longer
   * matches the destination rect.
   */
  deviceScaleRatio?: number;
  /**
   * Optional crop window (bitmap pixels). When present the offscreen
   * stitcher draws only that sub-rect of the bitmap — this is how the
   * region pipeline stitches several *viewport* captures into one image.
   * When absent the legacy full-page behaviour (draw from the top-left,
   * `segmentHeight` pixels tall) is preserved byte-for-byte.
   */
  crop?: CropRect;
}

export interface InitStitchPayload {
  /**
   * Canvas width in **CSS px** — for the full-page flow this is the page
   * viewport width, for the region flow it is the selected region width.
   */
  viewportWidth: number;
  /** Canvas height in **CSS px** (the page height / region height). */
  totalHeight: number;
  /**
   * The page's viewport size in CSS px.
   *
   * Needed even when `viewportWidth` is NOT the page width (region flow:
   * the canvas is the region, but the bitmaps are full viewports). The
   * stitcher uses it to interpret the bitmap's pixel geometry.
   */
  pageViewportWidth: number;
  /** The page's viewport height in CSS px (same reasoning as above). */
  pageViewportHeight: number;
  /**
   * The page's `devicePixelRatio`.
   *
   * Only a *starting hint* for the stitcher: the authoritative scale is
   * resolved per chunk from the real bitmap (`StitchChunkPayload
   * .deviceScaleRatio`) because `captureVisibleTab` grabs the browser
   * widget, whose size can differ from the page's layout viewport.
   */
  pageDevicePixelRatio?: number;
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
      // An error envelope is a *reply* to this request — reject with the
      // real reason instead of resolving with an envelope the caller
      // would have to know to inspect. Otherwise a failure surfaces as a
      // confusing "empty payload" further down the pipeline.
      if (typeof env.type === 'string' && env.type.endsWith(':error')) {
        const message =
          (env.payload as { message?: string } | undefined)?.message ??
          `request '${type}' failed`;
        reject(new Error(message));
        return;
      }
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

/**
 * Simple random id (no PII, no analytics).
 *
 * `crypto.randomUUID()` is only available in **secure contexts**. Content
 * scripts run inside the page's world, so on a plain `http://` site the
 * method is `undefined` and calling it would throw. Fall back to
 * `getRandomValues` (available everywhere) instead of exploding.
 */
export function cryptoRandomId(): string {
  if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Sleep helper — used for retry/backoff in capture pipeline. */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}