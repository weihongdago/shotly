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
  PORT_NAMES,
  PROTOCOL_VERSION,
  type Envelope,
  type FinalizeResponse,
  type InitStitchPayload,
  type StitchChunkPayload,
} from '../utils/messaging';

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

// ─── Boot ─────────────────────────────────────────────────────────────────────

export default defineUnlistedScript(() => {
  console.info('[shotly:offscreen] script booted');

  if (typeof chrome === 'undefined' || !chrome.runtime?.onConnect) {
    console.warn('[shotly:offscreen] chrome.runtime unavailable, skipping port setup');
    return;
  }

  try {
    chrome.runtime.onConnect.addListener((port) => {
      if (port.name !== PORT_NAMES.offscreen) return;

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

      port.onMessage.addListener(async (env: Envelope) => {
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
      });
    });
  } catch (err) {
    // wxt prepare uses a fake browser that throws on addListener
    console.warn('[shotly:offscreen] port setup skipped:', (err as Error).message);
  }
});

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

  const { index, dataUrl, offsetY, segmentHeight } = env.payload as StitchChunkPayload;

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
    // Draw at full bitmap width but only the clamped height — guards against
    // over-tall last segment that would otherwise bleed into the next row.
    state.ctx.drawImage(
      bitmap,
      0, 0, bitmap.width, drawHeight, // src rect
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