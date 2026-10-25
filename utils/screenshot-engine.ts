/**
 * Screenshot engine skeleton (architecture v1.2 §3)
 *
 * Pipeline:
 *   1. content script measures document height → computes segments
 *   2. hides fixed/sticky elements + installs iframe placeholders (§3.4 / §3.2)
 *   3. for each segment: scrollTo → wait → bg.captureVisibleTab → push to offscreen
 *   4. offscreen stitches all chunks via OffscreenCanvas → final blob
 *   5. restore DOM
 *
 * This is the D+1 SKELETON — most heavy lifting is wired in but not yet
 * integrated with the offscreen document. Real implementation lands in
 * D+2 (scroll-and-capture loop) and D+3 (offscreen stitch + PoC validation).
 */

import { sleep } from './messaging';
import {
  installIframePlaceholders,
  restoreIframes,
  type PlaceholderRecord,
} from './iframe-placeholder';

// ─── Types ────────────────────────────────────────────────────────────────────

export const DEFAULT_SEGMENT_HEIGHT = 4096;
export const PER_SEGMENT_BUFFER_MS = 1500;
export const HARD_PAGE_LIMIT_PX = 50_000;

export interface SegmentMeta {
  index: number;
  startY: number;
  endY: number;
  height: number;
}

export interface ScreenshotChunk {
  index: number;
  dataUrl: string;
  segmentHeight: number;
  capturedAt: number;
}

export interface ScreenshotPlan {
  totalHeight: number;
  viewportHeight: number;
  viewportWidth: number;
  devicePixelRatio: number;
  segments: SegmentMeta[];
}

// ─── DOM measurement & planning ─────────────────────────────────────────────

/**
 * Compute the scroll-and-stitch plan for the current document.
 * Returns the segment list with start/end Y coordinates.
 *
 * Hard page limit: HARD_PAGE_LIMIT_PX (50_000px). Over the limit → caller
 * should show a toast and recommend region capture.
 */
export function planCapture(
  segmentHeight: number = DEFAULT_SEGMENT_HEIGHT,
): ScreenshotPlan {
  const docEl = (document.scrollingElement || document.documentElement) as HTMLElement;
  const body = document.body as HTMLElement;
  const totalHeight = Math.max(
    docEl.scrollHeight,
    body.scrollHeight,
    docEl.offsetHeight,
    body.offsetHeight,
  );
  const viewportHeight = window.innerHeight;
  const viewportWidth = window.innerWidth;
  const dpr = window.devicePixelRatio || 1;

  const segments: SegmentMeta[] = [];
  for (let y = 0; y < totalHeight; y += segmentHeight) {
    segments.push({
      index: segments.length,
      startY: y,
      endY: Math.min(y + segmentHeight, totalHeight),
      height: Math.min(segmentHeight, totalHeight - y),
    });
  }

  return { totalHeight, viewportHeight, viewportWidth, devicePixelRatio: dpr, segments };
}

/** Returns true if page exceeds the hard limit (caller should warn user). */
export function isPageTooLong(plan: ScreenshotPlan): boolean {
  return plan.totalHeight > HARD_PAGE_LIMIT_PX;
}

// ─── Fixed/Sticky element handling (architecture §3.4) ────────────────────────

interface HiddenElement {
  el: HTMLElement;
  originalDisplay: string;
  originalVisibility: string;
}

/**
 * Hide position:fixed / sticky elements with high z-index so they don't
 * appear N times in the stitched image.
 *
 * v1.0 default mode = 'auto-hide'. Other modes reserved for v1.1 settings.
 */
export function hideFixedElements(): HiddenElement[] {
  const hidden: HiddenElement[] = [];
  const all = document.querySelectorAll<HTMLElement>('*');
  for (const el of Array.from(all)) {
    const cs = window.getComputedStyle(el);
    const pos = cs.position;
    if (pos !== 'fixed' && pos !== 'sticky') continue;
    const z = parseInt(cs.zIndex || '0', 10);
    if (!Number.isFinite(z) || z < 1) continue;
    // Skip very small ones (likely badges) — keep visual noise down
    const rect = el.getBoundingClientRect();
    if (rect.width < 24 && rect.height < 24) continue;

    hidden.push({
      el,
      originalDisplay: el.style.display,
      originalVisibility: el.style.visibility,
    });
    el.style.visibility = 'hidden';
  }
  return hidden;
}

export function restoreFixedElements(hidden: HiddenElement[]): void {
  for (const h of hidden) {
    h.el.style.display = h.originalDisplay;
    h.el.style.visibility = h.originalVisibility;
  }
}

// ─── Lazy-load priming (architecture §3.3) ───────────────────────────────────

/**
 * Force lazy-loaded <img> elements to eager loading.
 * Other libraries (IntersectionObserver-driven) are not directly controllable —
 * the 1500ms buffer after scroll covers most cases.
 */
export function primeLazyImages(): number {
  let count = 0;
  document
    .querySelectorAll<HTMLImageElement>('img[loading="lazy"]')
    .forEach((img) => {
      img.loading = 'eager';
      count++;
    });
  // Force reflow so the browser re-evaluates lazy sets
  document.body.getBoundingClientRect();
  return count;
}

/**
 * Wait for network idle (no in-flight requests for `idleMs`).
 * Falls back to a hard timeout of `timeoutMs`.
 */
export async function waitForNetworkIdle(
  idleMs = 800,
  timeoutMs = 1500,
): Promise<void> {
  return new Promise((resolve) => {
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const reset = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(resolve, idleMs);
    };
    const events: Array<keyof DocumentEventMap> = [
      'load',
      'DOMContentLoaded',
    ];
    events.forEach((e) => document.addEventListener(e, reset, { once: true }));
    window.addEventListener('scroll', reset, { passive: true });
    setTimeout(resolve, timeoutMs); // hard ceiling
  });
}

// ─── Scroll-and-capture driver (D+2 will wire to background) ─────────────────

export interface CaptureContext {
  plan: ScreenshotPlan;
  onChunk: (chunk: ScreenshotChunk) => Promise<void> | void;
  onProgress?: (segmentIndex: number, total: number) => void;
  onError?: (err: Error) => void;
}

/**
 * Drives the page: scroll → wait → emit chunk callback → repeat.
 * The actual `chrome.tabs.captureVisibleTab` call happens in the background
 * service worker (see architecture §2.3.3 port model). This function is the
 * in-page half of the protocol.
 */
export async function runScrollAndCapture(ctx: CaptureContext): Promise<{
  chunks: ScreenshotChunk[];
  iframes: PlaceholderRecord[];
  hidden: HiddenElement[];
}> {
  const chunks: ScreenshotChunk[] = [];
  const iframes = installIframePlaceholders();
  const hidden = hideFixedElements();
  const primedLazy = primeLazyImages();
  console.info(`[shotly] capture start: ${ctx.plan.segments.length} segments, ${primedLazy} lazy images primed`);

  const previousScrollY = window.scrollY;
  try {
    for (const seg of ctx.plan.segments) {
      ctx.onProgress?.(seg.index, ctx.plan.segments.length);
      window.scrollTo({ top: seg.startY, behavior: 'instant' });
      await sleep(200); // let scroll settle
      await waitForNetworkIdle();
      await sleep(PER_SEGMENT_BUFFER_MS);

      // D+2: this is the slot where the content script receives the real
      // dataUrl from bg (chrome.tabs.captureVisibleTab). The chunk passed
      // to ctx.onChunk() carries the synthetic placeholder dataUrl only so
      // the engine stays pure / testable; the real dataUrl flows via the
      // content<->bg port. See entrypoints/content.ts `handleStartCapture`.
      const syntheticDataUrl = await syntheticChunkPlaceholder(seg);
      const chunk: ScreenshotChunk = {
        index: seg.index,
        dataUrl: syntheticDataUrl,
        segmentHeight: seg.height,
        capturedAt: Date.now(),
      };
      chunks.push(chunk);
      await ctx.onChunk(chunk);
    }
  } catch (err) {
    ctx.onError?.(err as Error);
    throw err;
  } finally {
    // Always restore — order matters: iframes first (visually), then fixed
    restoreIframes(iframes);
    restoreFixedElements(hidden);
    window.scrollTo({ top: previousScrollY, behavior: 'instant' });
    console.info(`[shotly] capture done: ${chunks.length} chunks`);
  }

  return { chunks, iframes, hidden };
}

// ─── OffscreenCanvas stitch (architecture §3.1 final step) ────────────────────

/**
 * Stitch chunks into a single image via OffscreenCanvas.
 *
 * D+2 status: the production path runs in the offscreen document
 * (see entrypoints/offscreen-main.ts) because MV3 Service Workers cannot
 * use DOM. This function is retained as a same-process fallback for
 *   (a) unit tests that run under happy-dom (no chrome.offscreen), and
 *   (b) future single-process variants (e.g. Firefox MV2 if we ship there).
 *
 * Memory note: a 1920×50_000 RGBA canvas = ~384MB. Chrome WILL OOM-kill the
 * offscreen doc beyond that, so HARD_PAGE_LIMIT_PX = 50_000 is enforced
 * upstream in the content script.
 */
export async function stitchChunks(
  chunks: ScreenshotChunk[],
  plan: ScreenshotPlan,
): Promise<Blob> {
  const totalPx = plan.viewportWidth * plan.totalHeight;
  const estMb = (totalPx * 4) / (1024 * 1024);
  console.info(
    `[shotly] (fallback) stitching ${chunks.length} chunks → ${plan.viewportWidth}x${plan.totalHeight} (~${estMb.toFixed(1)} MB)`,
  );

  if (typeof OffscreenCanvas === 'undefined') {
    throw new Error('[shotly] OffscreenCanvas not available — Chrome < 109');
  }

  const canvas = new OffscreenCanvas(plan.viewportWidth, plan.totalHeight);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('[shotly] 2d context unavailable on OffscreenCanvas');

  // Fill with neutral background so partial stitches don't show transparent stripes
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, plan.viewportWidth, plan.totalHeight);

  for (const chunk of chunks) {
    const bitmap = await createImageBitmap(
      await (await fetch(chunk.dataUrl)).blob(),
    );
    const offsetY = chunk.index * plan.viewportHeight;
    const drawHeight = Math.min(
      chunk.segmentHeight,
      plan.totalHeight - offsetY,
    );
    ctx.drawImage(
      bitmap,
      0, 0, bitmap.width, drawHeight,
      0, offsetY, plan.viewportWidth, drawHeight,
    );
    bitmap.close();
  }

  return canvas.convertToBlob({ type: 'image/png' });
}

// ─── D+1 placeholder so the pipeline can be unit-tested without Chrome ──────

async function syntheticChunkPlaceholder(seg: SegmentMeta): Promise<string> {
  // 1x1 transparent PNG — real capture happens via bg port in D+2
  const dataUrl =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  await sleep(10); // simulate IPC latency
  return dataUrl;
}