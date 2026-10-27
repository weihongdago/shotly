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
  resolveDeviceScale,
  runScrollAndCapture,
  PER_SEGMENT_BUFFER_MS,
  waitForIframesReady,
  waitForNetworkIdle,
  maxAllowedCssHeight,
  MAX_CANVAS_DIMENSION_PX,
  type ScreenshotChunk,
} from '../utils/screenshot-engine';
import { requestOverPort, sleep, cryptoRandomId } from '../utils/messaging';
import {
  MIN_REGION_SIZE,
  computeRegionCrop,
  segmentsCoveringRegion,
  selectRegion,
  sweepRegionOverlays,
} from '../utils/region-selector';
import { resolveLocale, translate } from '../utils/i18n';

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

    // Remove a region-selection overlay left behind by a previous run.
    //
    // ⚠️ The overlay is normally removed in `cleanup()`, but if the page
    // navigated (or the SW was killed) mid-selection, the cleanup never
    // ran and the overlay stays on top of the page — a full-screen
    // transparent sheet that swallows every click. The overlay is marked
    // with `data-shotly-region-overlay` precisely so it can be found
    // again; without this sweep the marker is write-only.
    try {
      sweepRegionOverlays();
    } catch {
      /* not fatal */
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
  // The stitch canvas is sized in **device** pixels, and Chrome refuses
  // canvases taller than 65_535px. A page that is fine at DPR=1 can blow
  // that budget at DPR=2, so the limit has to be checked against the
  // device scale, not just the CSS height.
  const dpr = plan.devicePixelRatio || 1;
  const maxCssHeight = maxAllowedCssHeight(dpr);
  if (plan.totalHeight > maxCssHeight) {
    port.postMessage({
      v: PROTOCOL_VERSION,
      id: env.id,
      scope: 'content',
      type: 'screenshot:too-long',
      payload: {
        totalHeight: plan.totalHeight,
        limit: maxCssHeight,
        devicePixelRatio: dpr,
        reason:
          dpr > 1
            ? `page is ${plan.totalHeight}px tall; at ${dpr}× DPR the stitch canvas would exceed Chrome's ${MAX_CANVAS_DIMENSION_PX}px limit (max ${maxCssHeight}px)`
            : `page is ${plan.totalHeight}px tall; the limit is ${maxCssHeight}px`,
      },
    } satisfies Envelope);
    return;
  }

  // ── Step 1: tell bg to size the offscreen canvas. We wait for ack so
  //    subsequent stitch-chunks don't race ahead of init.
  const initPayload: InitStitchPayload = {
    viewportWidth: plan.viewportWidth,
    totalHeight: plan.totalHeight,
    pageViewportWidth: plan.viewportWidth,
    pageViewportHeight: plan.viewportHeight,
    pageDevicePixelRatio: dpr,
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
      // pixels. The scale is the number of device pixels per CSS pixel.
      //
      // ⚠️ It must NOT be derived naively from the bitmap's size:
      // `captureVisibleTab` grabs the browser *widget*, which can be
      // larger than the page's layout viewport (measured: a 1282×839
      // widget rasterising a 1280×800 layout viewport), which would read
      // as 2.003× instead of 2× and stretch the image.
      //
      // `resolveDeviceScale` trusts the page's devicePixelRatio but falls
      // back to the bitmap when the raster is coarser than the page
      // believes (Playwright's CDP deviceScaleFactor does exactly that).
      const scaleInfo = resolveDeviceScale(
        plan.viewportWidth,
        plan.viewportHeight,
        capturePayload.width,
        capturePayload.height,
        plan.devicePixelRatio,
      );
      const scale = scaleInfo.scale;
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
        // The stitcher must use the very same scale the crop was computed
        // with — otherwise the image is silently stretched.
        deviceScaleRatio: scale,
        crop: {
          // The widget raster can be wider/taller than the layout
          // viewport (extra widget area on the right/bottom). The page
          // content starts at the raster's top-left corner, so the crop
          // takes exactly the layout viewport's width in device pixels.
          sx: 0,
          sy: Math.round((cropTop - viewportTop) * scale),
          sw: Math.min(
            Math.round(plan.viewportWidth * scale),
            capturePayload.width,
          ),
          sh: Math.max(1, Math.round(cropHeightCss * scale)),
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
    // The overlay is drawn on the page, so it has to speak the user's
    // language — an English-locale user must not be greeted by a Chinese
    // hint bar. The locale comes from the same override the popup uses.
    const locale = await resolveLocale();
    const region = await selectRegion({
      minSize: MIN_REGION_SIZE,
      hint: translate(locale, 'region.hint', { min: MIN_REGION_SIZE }),
      tooSmallMessage: translate(locale, 'region.tooSmall', { min: MIN_REGION_SIZE }),
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
  const dpr = plan.devicePixelRatio || 1;
  const slices = segmentsCoveringRegion(region, plan);
  if (slices.length === 0) {
    throw new Error('selected region does not intersect the page');
  }

  // Size the offscreen canvas to the *region*, not to the page.
  // `pageViewportWidth/Height` stay the PAGE viewport — the bitmaps are
  // full viewports, and the stitcher needs them to interpret the bitmap's
  // pixel geometry.
  await requestOverPort<InitStitchPayload, InitStitchPayload>(port, CAPTURE_MSG.INIT_STITCH, {
    viewportWidth: region.width,
    totalHeight: region.height,
    pageViewportWidth: plan.viewportWidth,
    pageViewportHeight: plan.viewportHeight,
    pageDevicePixelRatio: dpr,
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

      // The captured PNG is in device pixels. The scale must come from
      // `resolveDeviceScale` (the page's devicePixelRatio, with a
      // bitmap-based fallback) — deriving it from the bitmap's size alone
      // over-reads whenever the browser widget is larger than the page's
      // layout viewport, which stretches the region crop.
      const scaleInfo = resolveDeviceScale(
        plan.viewportWidth,
        plan.viewportHeight,
        captured.width,
        captured.height,
        plan.devicePixelRatio,
      );
      const scale = { x: scaleInfo.scale, y: scaleInfo.scale };
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
        deviceScaleRatio: scaleInfo.scale,
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