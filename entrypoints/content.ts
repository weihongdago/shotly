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
  type CaptureChunkResponse,
  type CaptureChunkPayload,
  type Envelope,
  type FinalizeResponse,
  type InitStitchPayload,
  type StitchChunkPayload,
} from '../utils/messaging';
import {
  isPageTooLong,
  planCapture,
  runScrollAndCapture,
  type ScreenshotChunk,
} from '../utils/screenshot-engine';
import { requestOverPort } from '../utils/messaging';

// Heartbeat offset from bg's 20s so they don't sync up + double the SW wake cost.
const CONTENT_HEARTBEAT_MS = 25_000;

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  main() {
    console.info('[shotly:content] script injected');

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
      const stitchReq: StitchChunkPayload = {
        index: chunk.index,
        dataUrl: capturePayload.dataUrl,
        segmentHeight: chunk.segmentHeight,
        viewportWidth: plan.viewportWidth,
        offsetY: chunk.index * plan.viewportHeight,
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
          id: env.id,
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
    id: env.id,
    scope: 'content',
    type: 'screenshot:done',
    payload: {
      segmentCount: plan.segments.length,
      capturedCount,
      ...finalPayload,
    },
  } satisfies Envelope);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Keep imports referenced even if TS tree-shakes after narrowing.
void ({} as CaptureChunkPayload);