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
  /**
   * Page-absolute Y (CSS px) where this chunk's content is PLACED on the
   * stitched canvas.
   */
  offsetY: number;
  /**
   * Page-absolute Y (CSS px) of the top of the captured viewport.
   *
   * The browser clamps the last scroll position, so the viewport we
   * actually captured does not necessarily start where we asked it to.
   * `offsetY - viewportTop` is therefore the crop offset into the bitmap.
   */
  viewportTop: number;
}

export interface ScreenshotPlan {
  totalHeight: number;
  viewportHeight: number;
  viewportWidth: number;
  devicePixelRatio: number;
  segments: SegmentMeta[];
}

/**
 * One viewport-height slice of a full-page capture.
 *
 * `chrome.tabs.captureVisibleTab` only ever returns the VISIBLE viewport,
 * so a full-page capture has to scroll one viewport at a time. The slices
 * are contiguous and non-overlapping in page coordinates: slice `k` covers
 * `[k*vh, min((k+1)*vh, totalHeight))`.
 */
export interface ViewportSlice {
  /** Ordinal of the slice (0-based). */
  index: number;
  /** Target scroll position (page px). */
  scrollY: number;
  /**
   * Page-absolute Y where this slice is supposed to END.
   *
   * It is the NEXT slice's scroll target (or the page bottom for the last
   * slice) — that is what makes the slices tile the page exactly.
   */
  plannedEnd: number;
}

/**
 * Split a full page into viewport-height scroll targets.
 *
 * `chrome.tabs.captureVisibleTab` only ever returns the VISIBLE viewport,
 * so a full-page capture has to scroll one viewport at a time.
 *
 * The last target is clamped to `totalHeight - viewportHeight` because the
 * browser cannot scroll further. That means the last viewport overlaps the
 * previous one, and the caller has to crop the overlap away — `plannedEnd`
 * makes the intended end of each slice explicit so the tiling can be
 * computed from the ACTUAL scroll positions.
 */
export function planViewportSlices(
  totalHeight: number,
  viewportHeight: number,
): ViewportSlice[] {
  if (!(totalHeight > 0) || !(viewportHeight > 0)) return [];

  const count = Math.max(1, Math.ceil(totalHeight / viewportHeight));
  const maxScroll = Math.max(0, totalHeight - viewportHeight);

  const targets: number[] = [];
  for (let k = 0; k < count; k++) {
    targets.push(Math.min(k * viewportHeight, maxScroll));
  }

  return targets.map((scrollY, index) => ({
    index,
    scrollY,
    plannedEnd: index + 1 < count ? targets[index + 1] : totalHeight,
  }));
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

// ─── Device-pixel (DPR) limits ───────────────────────────────────────────────

/**
 * Chrome's maximum canvas dimension, in device pixels.
 *
 * This — not memory — is the binding constraint for the stitch canvas.
 * Measured on this machine (test-infra/probe-canvas-limits.mjs):
 *
 *   2560 × 60_000  → OK    (153.6M px, 586 MB)
 *   2560 × 70_000  → FAIL  (179.2M px, 684 MB)
 *   1920 × 80_000  → FAIL  (153.6M px, 586 MB)  ← same area as the OK case
 *   1280 × 100_000 → FAIL  (128.0M px, 488 MB)
 *
 * The failures are exactly the canvases taller than 65_535 px, while a
 * *shorter* canvas with a *larger* area still works. So the rule is a
 * maximum **dimension**, not a maximum area. When the allocation fails
 * Chrome silently hands back a zero-size canvas and `convertToBlob` throws
 * "IndexSizeError: The size of OffscreenCanvas is zero" — a confusing
 * error that looks like a Shotly bug, so we refuse the capture up front
 * with a readable message instead.
 */
/**
 * Chrome's maximum canvas dimension (width OR height), in device pixels.
 *
 * Measured, not guessed — see `test-infra/probe-canvas-limits.mjs`:
 *   2560 × 60_000 → OK   (153.6M px, 586 MB)
 *   2560 × 70_000 → FAIL (179.2M px, 684 MB)
 *   1920 × 80_000 → FAIL (153.6M px — same area as the OK case!)
 *   1280 × 100_000 → FAIL
 * The binding constraint is the **dimension**, not the area.
 */
export const MAX_CANVAS_DIMENSION_PX = 65_535;

/**
 * The tallest page (in CSS px) that can be stitched at the given device
 * scale.
 *
 * Two independent ceilings:
 *   1. HARD_PAGE_LIMIT_PX — the architecture's own cap (50_000 CSS px).
 *   2. MAX_CANVAS_DIMENSION_PX / scale — Chrome's canvas dimension cap.
 *
 * At DPR=1 the architecture cap still binds (50_000 CSS px). At DPR=2 the
 * canvas cap binds first (32_767 CSS px) — which still covers the
 * 30_000px Notion-style page the PoC-D3 S2 scenario targets.
 */
export function maxAllowedCssHeight(scale: number): number {
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return Math.min(HARD_PAGE_LIMIT_PX, Math.floor(MAX_CANVAS_DIMENSION_PX / s));
}

/**
 * Would the stitch canvas exceed Chrome's dimension limit at this scale?
 *
 * `scale` is device pixels per CSS pixel. The height is what actually
 * breaks Chrome (see MAX_CANVAS_DIMENSION_PX), but the width is checked
 * too — a 4K-wide window at DPR=2 would be 7_680 device px, which is
 * fine, while the height is the real risk.
 */
export function exceedsCanvasLimit(
  cssWidth: number,
  cssHeight: number,
  cssScale: number,
): boolean {
  const s = Number.isFinite(cssScale) && cssScale > 0 ? cssScale : 1;
  return (
    Math.ceil(cssWidth * s) > MAX_CANVAS_DIMENSION_PX ||
    Math.ceil(cssHeight * s) > MAX_CANVAS_DIMENSION_PX
  );
}

/**
 * How many device pixels does one CSS pixel occupy in the captured bitmap?
 *
 * ⚠️ This is the single most error-prone number in the whole pipeline, and
 * getting it wrong is *silent*: the stitcher scales the bitmap into the
 * canvas, so a wrong scale produces a stretched image with no error
 * anywhere. Two failure modes we have actually hit:
 *
 * 1. **Deriving it from the bitmap's size.** Tempting
 *    (`bitmap.width / window.innerWidth`), but `captureVisibleTab` grabs
 *    the browser **widget**, which can be LARGER than the page's layout
 *    viewport — e.g. a 1282×839 widget rasterising a 1280×800 layout
 *    viewport. The ratio then reads 2.003 instead of 2, and the image
 *    comes out stretched by 0.16% horizontally and 4.9% vertically.
 *    Measured: `test-infra/probe-marker-mapping.mjs` draws 1px markers at
 *    known page positions and reads back where they landed in the bitmap.
 *
 * 2. **Blindly trusting `window.devicePixelRatio`.** It is right in a real
 *    browser (Chrome sets DPR = zoom × screen scale, and the raster uses
 *    the same factor), but it can be *higher* than the raster that
 *    actually comes back — e.g. Playwright's CDP `deviceScaleFactor`
 *    emulation, which makes the page believe it is on a 2× screen while
 *    the window widget still rasters at 1×. Trusting DPR there would
 *    upscale a 1× bitmap into a 2× canvas (soft, blurry, double the
 *    memory for no detail).
 *
 * So: **trust the page's DPR, but only when the bitmap is at least that
 * sharp.** If the bitmap is materially coarser than DPR claims, fall back
 * to the bitmap's own ratio. A 5% tolerance absorbs the widget overhang
 * (which makes the bitmap *bigger*, never smaller).
 *
 * @param cssWidth   the page's layout viewport width (CSS px)
 * @param cssHeight  the page's layout viewport height (CSS px)
 * @param bitmapWidth  the captured bitmap's width (device px)
 * @param bitmapHeight the captured bitmap's height (device px)
 * @param devicePixelRatio the page's `window.devicePixelRatio`
 */
export function resolveDeviceScale(
  cssWidth: number,
  cssHeight: number,
  bitmapWidth: number,
  bitmapHeight: number,
  devicePixelRatio: number,
): { scale: number; source: 'dpr' | 'bitmap' } {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;

  // How many device px does the layout viewport need at this DPR?
  const expectedW = cssWidth * dpr;
  const expectedH = cssHeight * dpr;

  // The bitmap must be able to hold the whole layout viewport at DPR
  // resolution. If it cannot, the raster is coarser than the page
  // believes → use the raster's own ratio instead of upscaling.
  const rasterCovers =
    bitmapWidth >= expectedW * 0.95 && bitmapHeight >= expectedH * 0.95;

  if (rasterCovers) return { scale: dpr, source: 'dpr' };

  // Fall back to the bitmap. Use whichever axis is more reliable: the
  // widget overhang inflates the ratio, so take the SMALLER of the two
  // ratios (the tighter fit is the honest one).
  const byWidth = cssWidth > 0 ? bitmapWidth / cssWidth : 0;
  const byHeight = cssHeight > 0 ? bitmapHeight / cssHeight : 0;
  const candidates = [byWidth, byHeight].filter((v) => Number.isFinite(v) && v > 0);
  if (candidates.length === 0) return { scale: dpr, source: 'dpr' };

  return { scale: Math.min(...candidates), source: 'bitmap' };
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
  // `captureVisibleTab` only ever returns the VISIBLE viewport, so the
  // capture has to walk the page one viewport at a time — the 4096px
  // `plan.segments` are a different concern (how much page there is).
  const slices = planViewportSlices(
    ctx.plan.totalHeight,
    ctx.plan.viewportHeight,
  );
  console.info(`[shotly] capture start: ${slices.length} viewport slices, ${primedLazy} lazy images primed`);

  const previousScrollY = window.scrollY;
  try {
    for (const slice of slices) {
      ctx.onProgress?.(slice.index, slices.length);
      window.scrollTo({ top: slice.scrollY, behavior: 'instant' });
      await sleep(200); // let scroll settle
      await waitForNetworkIdle();
      await sleep(PER_SEGMENT_BUFFER_MS);

      // D+2: this is the slot where the content script receives the real
      // dataUrl from bg (chrome.tabs.captureVisibleTab). The chunk passed
      // to ctx.onChunk() carries the synthetic placeholder dataUrl only so
      // the engine stays pure / testable; the real dataUrl flows via the
      // content<->bg port. See entrypoints/content.ts `handleStartCapture`.
      const syntheticDataUrl = await syntheticChunkPlaceholder(slice);
      // The browser clamps the scroll position (the last slice of a page
      // that cannot scroll far enough), so read the ACTUAL position back
      // instead of assuming `slice.scrollY` was honoured.
      const viewportTop = window.scrollY;
      const chunk: ScreenshotChunk = {
        index: slice.index,
        dataUrl: syntheticDataUrl,
        // `plannedEnd` is where this slice's content is SUPPOSED to end on
        // the page, `scrollY` is where it starts — the difference is the
        // slice's height in page px. (The last slice is usually shorter
        // than a viewport, and it may overlap the previous one when the
        // page height is not a multiple of the viewport height — the
        // caller crops the overlap away using `viewportTop`.)
        segmentHeight: slice.plannedEnd - slice.scrollY,
        offsetY: slice.scrollY,
        viewportTop,
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
 * (see entrypoints/offscreen/main.ts) because MV3 Service Workers cannot
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
    const offsetY = chunk.offsetY;
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

async function syntheticChunkPlaceholder(seg: ViewportSlice): Promise<string> {
  // 1x1 transparent PNG — real capture happens via bg port in D+2
  const dataUrl =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  await sleep(10); // simulate IPC latency
  return dataUrl;
}