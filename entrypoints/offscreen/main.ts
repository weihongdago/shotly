/**
 * Offscreen document — Shotly (architecture v1.2 §1.4, §3.1)
 *
 * Lives in a hidden HTML document so we get a DOM/Canvas context outside
 * the Service Worker (MV3 SW cannot use DOM). Chrome allows exactly one
 * offscreen document per extension — the background SW owns the single
 * bg↔offscreen port and relays stitch/finalize traffic from content.
 *
 * Responsibilities (D+2):
 *   - Maintain an OffscreenCanvas sized to the page's (width × totalHeight).
 *   - For each chunk bitmap: createImageBitmap → drawImage at (0, offsetY).
 *   - On finalize: canvas.convertToBlob → URL.createObjectURL → return URL.
 *   - On reset: revoke blob URL, drop canvas, free memory.
 *
 * Memory budget (architecture §3.1):
 *   1920 × 50_000 × 4 bytes = ~384MB worst case. Chrome WILL OOM-kill the
 *   offscreen doc beyond that, so HARD_PAGE_LIMIT_PX = 50_000 is enforced
 *   upstream in the content script.
 */

import {
  CAPTURE_MSG,
  EXPORT_MSG,
  PORT_NAMES,
  PROTOCOL_VERSION,
  type Envelope,
  type ExportConvertRequest,
  type ExportConvertResponse,
  type FinalizeResponse,
  type InitStitchPayload,
  type StitchChunkPayload,
} from '../../utils/messaging';
import { EXPORT_MIME, pdfPageSizeFor } from '../../utils/export';
import { PDFDocument } from 'pdf-lib';

// ─── State ────────────────────────────────────────────────────────────────────

interface StitchState {
  canvas: OffscreenCanvas;
  ctx: OffscreenCanvasRenderingContext2D;
  viewportWidth: number;
  totalHeight: number;
  chunksWritten: number;
  offsetsByIndex: Map<number, number>;
  blobUrl: string | null;
}

let state: StitchState | null = null;

/**
 * The PNG blob from the most recent finalize.
 *
 * We keep it (instead of only the blobUrl) because the popup revokes its
 * blobUrl when it unmounts, and a blob minted in a different JS context
 * can be revoked by that context at any time. Holding the raw Blob here
 * makes the export path independent of URL lifetime — `handleConvert`
 * prefers the caller's sourceBlobUrl and falls back to this.
 */
let lastCaptureBlob: Blob | null = null;

// ─── Background connection ───────────────────────────────────────────────────

/**
 * The port to the service worker.
 *
 * DIRECTION MATTERS (2026-10-26 fix). The *offscreen document* opens this
 * port, not the service worker. `chrome.offscreen.createDocument()`
 * resolves as soon as the document exists — it does NOT wait for the
 * document's script to evaluate. A worker-initiated
 * `chrome.runtime.connect({ name: PORT_NAMES.offscreen })` therefore races
 * the offscreen's `chrome.runtime.onConnect` registration and can land
 * before that listener exists, producing a port that is dead on arrival
 * ("Attempting to use a disconnected port object").
 *
 * Opening the port from the offscreen side removes the race entirely: the
 * connect happens exactly when the offscreen code is running.
 */
let bgPort: chrome.runtime.Port | null = null;
let bgPortConnecting = false;

/**
 * Serial task queue for inbound background messages.
 *
 * The background relays `init-stitch` / `stitch-chunk` fire-and-forget (it
 * acks the content script immediately), so two chunks can be in flight at
 * the same time. Each handler is async (`createImageBitmap` + `drawImage`),
 * so without a queue the *drawing order* would follow bitmap-decode
 * completion order rather than message order — the stitched image would
 * come out scrambled. Chaining every handler onto one promise makes the
 * offscreen strictly sequential.
 */
let bgQueue: Promise<void> = Promise.resolve();

/** Enqueue a background message handler, preserving arrival order. */
function enqueueBackgroundMessage(
  port: chrome.runtime.Port,
  env: Envelope,
): void {
  bgQueue = bgQueue
    .then(() => handleBackgroundMessage(port, env))
    .catch((err) => {
      console.error('[shotly:offscreen] queued handler failed:', err);
    });
}

/**
 * Open (or re-open) the port to the service worker.
 *
 * Safe to call repeatedly — it is a no-op while a live port exists.
 */
function connectToBackground(): void {
  if (bgPort) return;
  if (bgPortConnecting) return;
  bgPortConnecting = true;

  try {
    const port = chrome.runtime.connect({ name: PORT_NAMES.offscreen });
    bgPort = port;
    console.info('[shotly:offscreen] connected to background');

    port.onMessage.addListener((env: Envelope) => {
      enqueueBackgroundMessage(port, env);
    });

    port.onDisconnect.addListener(() => {
      console.warn('[shotly:offscreen] background port disconnected');
      if (bgPort === port) bgPort = null;
    });

    // Announce readiness — bg waits for this before sending capture traffic.
    port.postMessage({
      v: PROTOCOL_VERSION,
      id: '__boot__',
      scope: 'offscreen',
      type: 'offscreen:ready',
      payload: {
        ts: Date.now(),
        hasOffscreenCanvas: typeof OffscreenCanvas !== 'undefined',
      },
    } satisfies Envelope);
  } catch (err) {
    console.warn('[shotly:offscreen] connect to background failed:', (err as Error).message);
  } finally {
    bgPortConnecting = false;
  }
}

/** Handle a message that arrived from the service worker. */
async function handleBackgroundMessage(
  port: chrome.runtime.Port,
  env: Envelope,
): Promise<void> {
  if (env.id === '__heartbeat__' || env.id === '__boot__') return;

  try {
    switch (env.type) {
      case CAPTURE_MSG.INIT_STITCH:
        await handleInitStitch(port, env);
        break;

      case CAPTURE_MSG.STITCH_CHUNK:
        await handleStitchChunk(port, env);
        break;

      case CAPTURE_MSG.FINALIZE:
        await handleFinalize(port, env);
        break;

      case CAPTURE_MSG.RESET_STITCH:
        handleReset(port, env);
        break;

      case EXPORT_MSG.CONVERT:
        await handleConvert(port, env);
        break;

      case 'offscreen:ping':
        port.postMessage({
          v: PROTOCOL_VERSION,
          id: env.id,
          scope: 'offscreen',
          type: 'offscreen:pong',
          payload: {
            hasOffscreenCanvas: typeof OffscreenCanvas !== 'undefined',
            hasState: state !== null,
            chunksWritten: state?.chunksWritten ?? 0,
          },
        } satisfies Envelope);
        break;

      default:
        console.debug(`[shotly:offscreen] unhandled: ${env.type}`);
    }
  } catch (err) {
    console.error(`[shotly:offscreen] handler '${env.type}' error:`, err);
    try {
      port.postMessage({
        v: PROTOCOL_VERSION,
        id: env.id,
        scope: 'offscreen',
        type: `${env.type}:error`,
        payload: { message: (err as Error).message },
      } satisfies Envelope);
    } catch {
      /* port closed */
    }
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

/**
 * Boot the offscreen document.
 *
 * IMPORTANT (2026-10-26 fix): this file is loaded as a plain ES module by
 * `entrypoints/offscreen/index.html` — it is NOT a WXT "unlisted script"
 * entrypoint, so nothing ever calls a default export. The old code shipped
 * its whole body inside `export default defineUnlistedScript(() => {...})`,
 * which Rollup treated as dead code and tree-shook out of the bundle: the
 * built `chunks/offscreen-*.js` contained only pdf-lib and zero offscreen
 * code. The offscreen document therefore never registered any listener, so
 * the service worker's port found no peer and every relay died with
 * "Attempting to use a disconnected port object".
 *
 * So: self-execute. Do not wrap the boot body in a default export.
 */
function bootOffscreen(): void {
  console.info('[shotly:offscreen] script booted');

  if (typeof chrome === 'undefined' || !chrome.runtime?.connect) {
    console.warn('[shotly:offscreen] chrome.runtime unavailable, skipping port setup');
    return;
  }

  try {
    // The service worker asks us to (re)connect when its port died — e.g.
    // the MV3 worker was terminated and restarted, taking the port with it.
    // We deliberately do NOT auto-reconnect in a loop: a permanent
    // reconnect loop would keep the MV3 service worker alive forever.
    chrome.runtime.onMessage.addListener((msg: unknown) => {
      const env = msg as Envelope;
      if (env?.type === 'shotly:offscreen:connect') {
        console.info('[shotly:offscreen] reconnect requested by background');
        connectToBackground();
      }
    });

    connectToBackground();
  } catch (err) {
    // wxt prepare uses a fake browser that throws on addListener
    console.warn('[shotly:offscreen] port setup skipped:', (err as Error).message);
  }
}

bootOffscreen();

// ─── Handlers ─────────────────────────────────────────────────────────────────

async function handleInitStitch(
  port: chrome.runtime.Port,
  env: Envelope,
): Promise<void> {
  const { viewportWidth, totalHeight } = env.payload as InitStitchPayload;
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) {
    throw new Error(`init-stitch: bad viewportWidth=${viewportWidth}`);
  }
  if (!Number.isFinite(totalHeight) || totalHeight <= 0) {
    throw new Error(`init-stitch: bad totalHeight=${totalHeight}`);
  }

  // Drop any prior canvas to free memory before allocating new one.
  resetState();

  const canvas = new OffscreenCanvas(viewportWidth, totalHeight);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('[shotly:offscreen] 2d context unavailable');

  // Fill with a neutral background so partial stitches don't show transparent stripes
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, viewportWidth, totalHeight);

  state = {
    canvas,
    ctx,
    viewportWidth,
    totalHeight,
    chunksWritten: 0,
    offsetsByIndex: new Map(),
    blobUrl: null,
  };

  console.info(
    `[shotly:offscreen] stitcher initialized ${viewportWidth}×${totalHeight} (~${((viewportWidth * totalHeight * 4) / (1024 * 1024)).toFixed(1)} MB)`,
  );

  port.postMessage({
    v: PROTOCOL_VERSION,
    id: env.id,
    scope: 'offscreen',
    type: `${CAPTURE_MSG.INIT_STITCH}:ack`,
    payload: { viewportWidth, totalHeight },
  } satisfies Envelope);
}

async function handleStitchChunk(
  port: chrome.runtime.Port,
  env: Envelope,
): Promise<void> {
  if (!state) {
    throw new Error('stitch-chunk received before init-stitch');
  }

  const { index, dataUrl, offsetY, segmentHeight, crop } = env.payload as StitchChunkPayload;

  // Defensive bounds check — we must never draw past the canvas height
  const clampedOffsetY = Math.max(0, Math.min(offsetY, state.totalHeight - 1));
  const drawHeight = Math.max(
    1,
    Math.min(segmentHeight, state.totalHeight - clampedOffsetY),
  );

  let bitmap: ImageBitmap | null = null;
  try {
    const blob = await dataUrlToBlob(dataUrl);
    bitmap = await createImageBitmap(blob);
    // Source rect:
    //   - with a crop window (region pipeline): only the sub-rect that
    //     overlaps the selected region is drawn. The crop is expressed in
    //     bitmap (device) pixels, the destination in CSS pixels — the
    //     aspect ratio is preserved because the content script derived
    //     the crop from the bitmap's real pixel size.
    //   - without a crop (full-page pipeline): keep the legacy behaviour
    //     byte-for-byte — draw from the top-left, `segmentHeight` pixels
    //     tall, so the existing output does not change.
    const srcX = crop?.sx ?? 0;
    const srcY = crop?.sy ?? 0;
    const srcW = crop?.sw ?? bitmap.width;
    const srcH = crop?.sh ?? drawHeight;
    state.ctx.drawImage(
      bitmap,
      srcX, srcY, srcW, srcH, // src rect
      0, clampedOffsetY, state.viewportWidth, drawHeight, // dst rect
    );
    state.chunksWritten += 1;
    state.offsetsByIndex.set(index, clampedOffsetY);
  } finally {
    bitmap?.close();
  }

  port.postMessage({
    v: PROTOCOL_VERSION,
    id: env.id,
    scope: 'offscreen',
    type: `${CAPTURE_MSG.STITCH_CHUNK}:ack`,
    payload: { index, offsetY: clampedOffsetY, chunksWritten: state.chunksWritten },
  } satisfies Envelope);
}

async function handleFinalize(
  port: chrome.runtime.Port,
  env: Envelope,
): Promise<void> {
  if (!state) {
    throw new Error('finalize received before init-stitch');
  }

  // Convert to PNG blob (lossless; preserves text + UI screenshots perfectly)
  const blob = await state.canvas.convertToBlob({ type: 'image/png' });
  if (!blob || blob.size === 0) {
    throw new Error('offscreen canvas produced empty blob');
  }

  // Revoke any prior URL to avoid leaks across rapid captures
  if (state.blobUrl) {
    URL.revokeObjectURL(state.blobUrl);
  }
  const blobUrl = URL.createObjectURL(blob);
  state.blobUrl = blobUrl;
  lastCaptureBlob = blob;

  const payload: FinalizeResponse = {
    blobUrl,
    width: state.viewportWidth,
    height: state.totalHeight,
    byteSize: blob.size,
  };

  port.postMessage({
    v: PROTOCOL_VERSION,
    id: env.id,
    scope: 'offscreen',
    type: `${CAPTURE_MSG.FINALIZE}:result`,
    payload,
  } satisfies Envelope);

  // Free the canvas — caller (bg) will call reset-stitch or a new
  // init-stitch will replace state. Either way the heavy buffer goes now.
  // (We keep `state` so a subsequent reset-stitch can revoke the blobUrl.)
  state.canvas.width = 0;
  state.canvas.height = 0;
  state.ctx = null as unknown as OffscreenCanvasRenderingContext2D;
}

function handleReset(port: chrome.runtime.Port, env: Envelope): void {
  resetState();
  port.postMessage({
    v: PROTOCOL_VERSION,
    id: env.id,
    scope: 'offscreen',
    type: `${CAPTURE_MSG.RESET_STITCH}:ack`,
    payload: { ok: true },
  } satisfies Envelope);
}

// ─── Export conversion (D+3) ──────────────────────────────────────────────────

/**
 * Convert a captured PNG into PNG / JPG / PDF.
 *
 * Why the offscreen document owns this: it is the only context with both
 * a canvas (for raster conversion) and enough runtime headroom to run
 * pdf-lib without bloating the popup bundle. The Service Worker has no
 * DOM at all, so it cannot rasterize.
 *
 * JPG path: decode PNG → OffscreenCanvas → convertToBlob('image/jpeg').
 * PDF path: pdf-lib embeds the PNG losslessly on a page sized to the image.
 */
async function handleConvert(
  port: chrome.runtime.Port,
  env: Envelope,
): Promise<void> {
  const req = env.payload as ExportConvertRequest;
  const { format, quality } = req;
  const source = await resolveSourceBlob(req.sourceBlobUrl);

  let outBlob: Blob;
  let width = 0;
  let height = 0;

  if (format === 'png') {
    outBlob = source;
    const dims = await probePngSize(source);
    width = dims.width;
    height = dims.height;
  } else if (format === 'jpg') {
    const bitmap = await createImageBitmap(source);
    try {
      width = bitmap.width;
      height = bitmap.height;
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('[shotly:offscreen] 2d context unavailable for jpg export');
      // JPEG has no alpha channel — fill white first so transparent PNG
      // regions don't turn black.
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(bitmap, 0, 0);
      outBlob = await canvas.convertToBlob({
        type: 'image/jpeg',
        quality: clampQuality(quality),
      });
    } finally {
      bitmap.close();
    }
  } else if (format === 'pdf') {
    const dims = await probePngSize(source);
    width = dims.width;
    height = dims.height;
    const page = pdfPageSizeFor({ widthPx: width, heightPx: height });
    const pdf = await PDFDocument.create();
    const image = await pdf.embedPng(await source.arrayBuffer());
    const pdfPage = pdf.addPage([page.width, page.height]);
    pdfPage.drawImage(image, { x: 0, y: 0, width: page.width, height: page.height });
    const bytes = await pdf.save();
    outBlob = new Blob([bytes as unknown as BlobPart], {
      type: EXPORT_MIME.pdf,
    });
  } else {
    throw new Error(`[shotly:offscreen] unsupported export format: ${String(format)}`);
  }

  if (!outBlob || outBlob.size === 0) {
    throw new Error('[shotly:offscreen] export produced empty blob');
  }

  const blobUrl = URL.createObjectURL(outBlob);
  const payload: ExportConvertResponse = {
    blobUrl,
    format,
    mimeType: EXPORT_MIME[format],
    byteSize: outBlob.size,
    width,
    height,
  };

  port.postMessage({
    v: PROTOCOL_VERSION,
    id: env.id,
    scope: 'offscreen',
    type: `${EXPORT_MSG.CONVERT}:result`,
    payload,
  } satisfies Envelope);
}

/**
 * Resolve the source image bytes.
 *
 * Prefers the caller-supplied blobUrl (correct when exporting a capture
 * that isn't the most recent one). Falls back to the last finalized blob
 * because the popup revokes its blobUrl on unmount — a revoked URL would
 * otherwise make every export fail after the popup closes once.
 */
async function resolveSourceBlob(sourceBlobUrl?: string): Promise<Blob> {
  if (sourceBlobUrl) {
    try {
      const res = await fetch(sourceBlobUrl);
      const blob = await res.blob();
      if (blob && blob.size > 0) return blob;
    } catch {
      /* revoked or already gone — fall through */
    }
  }
  if (lastCaptureBlob && lastCaptureBlob.size > 0) return lastCaptureBlob;
  throw new Error('[shotly:offscreen] no source image available for export');
}

/** Clamp a caller-supplied JPEG quality into the valid 0..1 range. */
function clampQuality(quality?: number): number {
  if (quality == null || !Number.isFinite(quality)) return 0.92;
  return Math.min(1, Math.max(0, quality));
}

/**
 * Read PNG dimensions from the blob header (no full decode).
 * Mirrors the same trick used in the background SW.
 */
async function probePngSize(blob: Blob): Promise<{ width: number; height: number }> {
  const header = await blob.slice(0, 32).arrayBuffer();
  const bytes = new Uint8Array(header);
  if (
    bytes.length < 24 ||
    bytes[0] !== 0x89 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x4e ||
    bytes[3] !== 0x47
  ) {
    throw new Error('[shotly:offscreen] source is not a PNG');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    width: view.getUint32(16, false),
    height: view.getUint32(20, false),
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resetState(): void {
  if (!state) return;
  if (state.blobUrl) {
    URL.revokeObjectURL(state.blobUrl);
  }
  state.canvas.width = 0;
  state.canvas.height = 0;
  state = null;
}

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  // Fast path: native dataUrl → Blob is cheap and avoids base64 round-trip.
  if (typeof fetch === 'function') {
    const res = await fetch(dataUrl);
    return await res.blob();
  }
  // Fallback: hand-decode base64 (older runtimes in offscreen contexts).
  const comma = dataUrl.indexOf(',');
  if (comma < 0) throw new Error('invalid dataUrl');
  const b64 = dataUrl.slice(comma + 1);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: 'image/png' });
}