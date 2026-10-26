/**
 * Content script — Shotly (architecture v1.2 §2.3, §3)
 *
 * Runs in the page's isolated world. Responsibilities (D+2):
 *   - Accept `screenshot-port` connections from the background SW.
 *   - Drive the scroll-and-stitch pipeline:
 *       1. Plan segments from document geometry.
 *       2. Initialize offscreen canvas via bg (`screenshot:init-stitch`).
 *       3. For each segment: scroll → wait → request capture from bg →
 *          bg calls `chrome.tabs.captureVisibleTab` → returns dataUrl.
 *       4. Forward each chunk to offscreen for drawing (`screenshot:stitch-chunk`).
 *       5. Finalize: bg → offscreen `screenshot:finalize` → convertToBlob → blobUrl.
 *   - Install/restore iframe placeholders and hide fixed elements around capture.
 *   - Drive a 25s heartbeat so the SW stays alive mid-pipeline (architecture §2.3.3).
 */

import {
  CAPTURE_MSG,
  PORT_NAMES,
  PROTOCOL_VERSION,
  REGION_MSG,
  type CaptureChunkResponse,
  type CaptureChunkPayload,
  type Envelope,
  type FinalizeResponse,
  type InitStitchPayload,
  type RegionSelection,
  type StitchChunkPayload,
} from '../utils/messaging';
import {
  isPageTooLong,
  planCapture,
  runScrollAndCapture,
  PER_SEGMENT_BUFFER_MS,
  waitForNetworkIdle,
  type ScreenshotChunk,
} from '../utils/screenshot-engine';
import { requestOverPort, sleep, cryptoRandomId } from '../utils/messaging';
import {
  MIN_REGION_SIZE,
  computeRegionCrop,
  segmentsCoveringRegion,
  selectRegion,
} from '../utils/region-selector';

// Heartbeat offset from bg's 20s so they don't sync up + double the SW wake cost.
const CONTENT_HEARTBEAT_MS = 25_000;

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  main() {
    console.info('[shotly:content] script injected');

    // Ready marker — lets automation (E2E) wait for the content script to
    // actually be injected before driving the popup. Without it, the test
    // can click "capture" before `document_idle` fires and the port
    // connect fails intermittently.
    try {
      document.documentElement.setAttribute('data-shotly-content', 'ready');
    } catch {
      /* document may be in a weird state (e.g. XML) — not fatal */
    }

    chrome.runtime.onConnect.addListener((port) => {
      if (port.name !== PORT_NAMES.screenshot) return;

      const heartbeat = setInterval(() => {
        try {
          port.postMessage({
            v: PROTOCOL_VERSION,
            id: '__heartbeat__',
            scope: 'content',
            type: 'screenshot:content-heartbeat',
            payload: { ts: Date.now() },
          } satisfies Envelope);
        } catch {
          clearInterval(heartbeat);
        }
      }, CONTENT_HEARTBEAT_MS);

      port.onDisconnect.addListener(() => {
        clearInterval(heartbeat);
        console.info('[shotly:content] port disconnected');
      });

      port.onMessage.addListener(async (env: Envelope) => {
        if (env.id === '__heartbeat__') return;

        try {
          switch (env.type) {
            case 'screenshot:plan': {
              const plan = planCapture();
              port.postMessage({
                v: PROTOCOL_VERSION,
                id: env.id,
                scope: 'content',
                type: 'screenshot:plan-result',
                payload: { plan, tooLong: isPageTooLong(plan) },
              } satisfies Envelope);
              break;
            }

            case 'screenshot:start':
              await handleStartCapture(port, env);
              break;

            case 'screenshot:abort':
              port.disconnect();
              break;

            case REGION_MSG.START:
              await handleRegionStart(port, env);
              break;

            default:
              console.debug(`[shotly:content] unhandled type: ${env.type}`);
          }
        } catch (err) {
          port.postMessage({
            v: PROTOCOL_VERSION,
            id: env.id,
            scope: 'content',
            type: 'screenshot:error',
            payload: { message: (err as Error).message },
          } satisfies Envelope);
        }
      });
    });
  },
});

// ─── Pipeline driver ──────────────────────────────────────────────────────────

async function handleStartCapture(
  port: chrome.runtime.Port,
  env: Envelope,
): Promise<void> {
  // BG always injects `tabId` in the `screenshot:start` payload so the
  // content script knows which tab to ask the SW to capture.
  const tabId = (env.payload as { tabId?: number })?.tabId;
  if (tabId == null) {
    throw new Error('content script has no tabId (cannot route captures)');
  }

  const plan = planCapture();
  if (isPageTooLong(plan)) {
    port.postMessage({
      v: PROTOCOL_VERSION,
      id: env.id,
      scope: 'content',
      type: 'screenshot:too-long',
      payload: { totalHeight: plan.totalHeight, limit: 50_000 },
    } satisfies Envelope);
    return;
  }

  // ── Step 1: tell bg to size the offscreen canvas. We wait for ack so
  //    subsequent stitch-chunks don't race ahead of init.
  const initPayload: InitStitchPayload = {
    viewportWidth: plan.viewportWidth,
    totalHeight: plan.totalHeight,
  };
  await requestOverPort<InitStitchPayload, InitStitchPayload>(
    port,
    CAPTURE_MSG.INIT_STITCH,
    initPayload,
  );

  // ── Step 2: scroll-and-capture loop. For each segment, we:
  //    a) ask bg to captureVisibleTab → dataUrl
  //    b) forward that dataUrl to bg → offscreen → drawImage
  let capturedCount = 0;
  await runScrollAndCapture({
    plan,
    onChunk: async (chunk: ScreenshotChunk) => {
      // (a) Real capture — bg performs chrome.tabs.captureVisibleTab
      const captureReq: { tabId: number; segmentIndex: number } = {
        tabId,
        segmentIndex: chunk.index,
      };
      const captureRes = await requestOverPort<
        typeof captureReq,
        CaptureChunkResponse
      >(
        port,
        CAPTURE_MSG.CAPTURE_CHUNK,
        captureReq,
        30_000,
      );

      // (b) Push the freshly-captured dataUrl into the offscreen stitcher.
      const capturePayload = captureRes.payload;
      if (!capturePayload) {
        throw new Error(`capture chunk ${chunk.index} returned empty payload`);
      }
      // The captured bitmap is in DEVICE pixels; the stitcher works in CSS
      // pixels. Derive the scale from the bitmap's real size instead of
      // trusting window.devicePixelRatio (browser zoom breaks that).
      const scale = {
        x: plan.viewportWidth > 0 ? capturePayload.width / plan.viewportWidth : 1,
        y: plan.viewportHeight > 0 ? capturePayload.height / plan.viewportHeight : 1,
      };
      // The viewport we captured may show MORE than this slice needs (the
      // last slice of a page is usually shorter than a viewport, and the
      // browser clamps the final scroll position). Crop the bitmap down to
      // the slice so the stitched image has neither gaps nor overlaps.
      const sliceTop = chunk.offsetY;
      const sliceBottom = chunk.offsetY + chunk.segmentHeight;
      // Use the viewport position the engine measured at capture time —
      // re-reading `window.scrollY` here can differ (the page may have
      // scrolled again) and would shift the crop.
      const viewportTop = chunk.viewportTop;
      const cropTop = Math.max(sliceTop, viewportTop);
      const cropBottom = Math.min(sliceBottom, viewportTop + plan.viewportHeight);
      const cropHeightCss = Math.max(0, cropBottom - cropTop);
      const stitchReq: StitchChunkPayload = {
        index: chunk.index,
        dataUrl: capturePayload.dataUrl,
        segmentHeight: cropHeightCss,
        viewportWidth: plan.viewportWidth,
        offsetY: cropTop,
        crop: {
          sx: 0,
          sy: Math.round((cropTop - viewportTop) * scale.y),
          sw: capturePayload.width,
          sh: Math.max(1, Math.round(cropHeightCss * scale.y)),
        },
      };
      await requestOverPort<StitchChunkPayload, { index: number }>(
        port,
        CAPTURE_MSG.STITCH_CHUNK,
        stitchReq,
        30_000,
      );

      capturedCount += 1;
    },
    onProgress: (i, total) => {
      try {
        port.postMessage({
          v: PROTOCOL_VERSION,
          // ⚠️ Notification events MUST carry their own id. Reusing the
          // start message's id makes the background's per-port dedupe
          // treat every progress tick as a duplicate of the first one
          // (the same `seen` set already holds the start id) and drop it.
          id: cryptoRandomId(),
          scope: 'content',
          type: 'screenshot:progress',
          payload: { i, total },
        } satisfies Envelope);
      } catch {
        /* port closed mid-emit */
      }
    },
    onError: (err) => {
      try {
        port.postMessage({
          v: PROTOCOL_VERSION,
          id: env.id,
          scope: 'content',
          type: 'screenshot:error',
          payload: { message: err.message },
        } satisfies Envelope);
      } catch {
        /* port closed */
      }
    },
  });

  // ── Step 3: ask offscreen to convert the canvas → blob URL.
  const finalRes = await requestOverPort<undefined, FinalizeResponse>(
    port,
    CAPTURE_MSG.FINALIZE,
    undefined,
    60_000,
  );

  const finalPayload = finalRes.payload;
  if (!finalPayload) {
    throw new Error('finalize returned empty payload');
  }

  port.postMessage({
    v: PROTOCOL_VERSION,
    // Own id — `screenshot:done` is a notification, not a reply to the
    // start message, and must not collide with it in the bg's dedupe set.
    id: cryptoRandomId(),
    scope: 'content',
    type: 'screenshot:done',
    payload: {
      segmentCount: plan.segments.length,
      capturedCount,
      ...finalPayload,
    },
  } satisfies Envelope);
}

// ─── Region capture (architecture §3.2, decision B1) ─────────────────────────

/**
 * Guards against a second selection UI opening while one is already up.
 *
 * The background may open a *second* content port for the same tab (e.g.
 * the user hits the region button twice). Both ports deliver their
 * `region:start` message to this content script, and without the guard
 * two overlays would fight over the mouse.
 */
let regionFlowActive = false;

/**
 * `popup → bg → content: region:start`
 *
 * Opens the drag-select overlay, then captures the selected rectangle.
 * The rectangle may span several viewport heights — in that case we
 * capture every screen it touches and stitch the pieces together.
 */
async function handleRegionStart(
  port: chrome.runtime.Port,
  env: Envelope,
): Promise<void> {
  if (regionFlowActive) {
    console.info('[shotly:content] region flow already active, ignoring duplicate start');
    return;
  }
  regionFlowActive = true;
  try {
    const region = await selectRegion({
      minSize: MIN_REGION_SIZE,
      hint: '拖拽框选区域 · 最小 100×100 · Esc 取消',
    });

    if (!region) {
      port.postMessage({
        v: PROTOCOL_VERSION,
        id: env.id,
        scope: 'content',
        type: REGION_MSG.CANCELLED,
        payload: { reason: 'user_cancelled' },
      } satisfies Envelope);
      return;
    }

    port.postMessage({
      v: PROTOCOL_VERSION,
      id: env.id,
      scope: 'content',
      type: REGION_MSG.SELECTED,
      payload: { region },
    } satisfies Envelope);

    await captureRegion(port, env, region);
  } catch (err) {
    port.postMessage({
      v: PROTOCOL_VERSION,
      id: env.id,
      scope: 'content',
      type: 'screenshot:error',
      payload: { message: (err as Error).message },
    } satisfies Envelope);
  } finally {
    regionFlowActive = false;
  }
}

/**
 * Capture the selected rectangle.
 *
 * Strategy (full cross-screen variant, not the "current viewport only"
 * fallback): the region is split into viewport-height slices, each slice
 * is scrolled into view and captured, and every bitmap is **cropped** to
 * the part that overlaps the region before it is handed to the offscreen
 * stitcher. The stitcher therefore only ever sees the region pixels.
 *
 * The crop is described to the offscreen document as metadata
 * (`StitchChunkPayload.crop`) instead of being baked into the bitmap on
 * this side: re-encoding every chunk here would mean decoding + encoding
 * a full-viewport PNG per slice in the page, while the offscreen document
 * already owns an OffscreenCanvas and has to decode the bitmap anyway.
 */
async function captureRegion(
  port: chrome.runtime.Port,
  env: Envelope,
  region: RegionSelection,
): Promise<void> {
  const tabId = (env.payload as { tabId?: number })?.tabId;
  if (tabId == null) {
    throw new Error('content script has no tabId (cannot route region captures)');
  }

  const plan = planCapture();
  const slices = segmentsCoveringRegion(region, plan);
  if (slices.length === 0) {
    throw new Error('selected region does not intersect the page');
  }

  // Size the offscreen canvas to the *region*, not to the page.
  await requestOverPort<InitStitchPayload, InitStitchPayload>(port, CAPTURE_MSG.INIT_STITCH, {
    viewportWidth: region.width,
    totalHeight: region.height,
  });

  const previousScrollY = window.scrollY;
  let capturedCount = 0;
  try {
    for (const slice of slices) {
      postProgress(port, slice.index, slices.length);

      window.scrollTo({ top: slice.scrollY, behavior: 'instant' });
      await sleep(200); // let the scroll settle
      await waitForNetworkIdle();
      await sleep(PER_SEGMENT_BUFFER_MS);

      // The browser clamps the scroll near the document end — re-read it so
      // the crop matches what was actually captured.
      const scrollY = window.scrollY;

      const captureReq: { tabId: number; segmentIndex: number } = {
        tabId,
        segmentIndex: slice.index,
      };
      const captureRes = await requestOverPort<typeof captureReq, CaptureChunkResponse>(
        port,
        CAPTURE_MSG.CAPTURE_CHUNK,
        captureReq,
        30_000,
      );
      const captured = captureRes.payload;
      if (!captured) {
        throw new Error(`region capture ${slice.index} returned empty payload`);
      }

      // The captured PNG is in device pixels — derive the scale from the
      // actual bitmap size instead of trusting window.devicePixelRatio
      // (browser zoom would break the assumption).
      const scale = {
        x: plan.viewportWidth > 0 ? captured.width / plan.viewportWidth : 1,
        y: plan.viewportHeight > 0 ? captured.height / plan.viewportHeight : 1,
      };
      const crop = computeRegionCrop(
        region,
        { x: window.scrollX, y: scrollY },
        { width: plan.viewportWidth, height: plan.viewportHeight },
        scale,
      );
      if (!crop) continue; // this screen does not overlap the region

      const stitchReq: StitchChunkPayload = {
        index: slice.index,
        dataUrl: captured.dataUrl,
        segmentHeight: crop.cssHeight,
        viewportWidth: region.width,
        offsetY: crop.offsetY,
        crop: { sx: crop.sx, sy: crop.sy, sw: crop.sw, sh: crop.sh },
      };
      await requestOverPort<StitchChunkPayload, { index: number }>(
        port,
        CAPTURE_MSG.STITCH_CHUNK,
        stitchReq,
        30_000,
      );

      capturedCount += 1;
    }
  } finally {
    // Always put the page back where the user left it.
    window.scrollTo({ top: previousScrollY, behavior: 'instant' });
  }

  const finalRes = await requestOverPort<undefined, FinalizeResponse>(
    port,
    CAPTURE_MSG.FINALIZE,
    undefined,
    60_000,
  );
  const finalPayload = finalRes.payload;
  if (!finalPayload) {
    throw new Error('finalize returned empty payload');
  }

  port.postMessage({
    v: PROTOCOL_VERSION,
    id: env.id,
    scope: 'content',
    type: 'screenshot:done',
    payload: {
      segmentCount: slices.length,
      capturedCount,
      ...finalPayload,
    },
  } satisfies Envelope);
}

/** Emit a progress event on the content port (ignored if the port died). */
function postProgress(
  port: chrome.runtime.Port,
  i: number,
  total: number,
): void {
  try {
    port.postMessage({
      v: PROTOCOL_VERSION,
      // Own id — every progress tick is a distinct event (see the note on
      // the onProgress callback above).
      id: cryptoRandomId(),
      scope: 'content',
      type: 'screenshot:progress',
      payload: { i, total },
    } satisfies Envelope);
  } catch {
    /* port closed mid-emit */
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Keep imports referenced even if TS tree-shakes after narrowing.
void ({} as CaptureChunkPayload);