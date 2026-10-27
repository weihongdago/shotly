/**
 * Region selector — Shotly (architecture v1.2 §3.2, decision B1)
 *
 * "矩形框选（拖拽）+ 智能元素吸附（v1.1 增强）" — v1.0 ships the drag
 * rectangle only. The user drags over the page, we return the rectangle in
 * **page-absolute CSS pixels** (the `MouseEvent.pageX/pageY` coordinate
 * space) so the capture pipeline can stitch the region across several
 * viewports.
 *
 * Design notes:
 *   - The overlay is a plain <div> appended to <body>. Every property is
 *     reset with `all: initial` and then re-declared with `!important`,
 *     because page CSS would otherwise bleed into the overlay (a stray
 *     `div { display: none }` would silently break the whole feature).
 *   - The overlay does NOT swallow wheel events, so the user can still
 *     scroll a long page while the layer is open. That is what makes
 *     cross-screen region selection possible at all.
 *   - Every exit path (confirm / cancel / too-small) tears the overlay down
 *     again: listeners removed, DOM removed, and the page's own
 *     `user-select` / `cursor` inline styles restored verbatim.
 *
 * The pure geometry helpers (normalizeRegion, segmentsCoveringRegion,
 * computeRegionCrop …) live in this module on purpose: they carry all the
 * maths and are therefore unit-tested in
 * `utils/__tests__/region-selector.test.ts`.
 */

import { type RegionSelection } from './messaging';

/**
 * `RegionSelection` lives in the protocol layer (`utils/messaging.ts`) —
 * it is the payload of the `region:selected` message, so it belongs next
 * to the message types. It is deliberately *not* re-exported here: WXT's
 * auto-import scanner warns about duplicate export names, and the type
 * must only be declared in one place.
 */

/** Minimum selection size in CSS px (architecture B1: "最小支持 100x100"). */
export const MIN_REGION_SIZE = 100;

/**
 * Marks the overlay element so leftovers can be detected/removed.
 *
 * The content script sweeps `[data-shotly-region-overlay]` on injection:
 * if the page navigated (or the service worker died) mid-selection, the
 * overlay's `cleanup()` never ran and a full-screen transparent sheet
 * would sit on top of the page, swallowing every click.
 */
export const OVERLAY_ATTR = 'data-shotly-region-overlay';

/**
 * Remove any region-selection overlay left behind by a previous run.
 *
 * Returns how many leftovers were removed. Safe to call at any time — it
 * only touches elements carrying `OVERLAY_ATTR`.
 */
export function sweepRegionOverlays(root: ParentNode = document): number {
  let removed = 0;
  for (const leftover of Array.from(root.querySelectorAll(`[${OVERLAY_ATTR}]`))) {
    leftover.remove();
    removed += 1;
  }
  return removed;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Point {
  x: number;
  y: number;
}

export interface SelectRegionOptions {
  /** Minimum width AND height in CSS px. Defaults to MIN_REGION_SIZE. */
  minSize?: number;
  /** Hint line rendered in the overlay. */
  hint?: string;
}

/** Minimal geometry contract a capture plan must satisfy. */
export interface RegionPlanLike {
  /** Viewport height in CSS px. */
  viewportHeight: number;
  /** Total scrollable document height in CSS px. */
  totalHeight: number;
}

/**
 * One viewport-height slice of the page that overlaps the selected region.
 *
 * `scrollY` is the *target* scroll position; the capture driver re-reads
 * `window.scrollY` after scrolling because the browser clamps it near the
 * document end.
 */
export interface RegionSlice {
  /** Ordinal of the slice (0-based) — also used as the stitch chunk index. */
  index: number;
  /** Target scroll position (page px) for this slice. */
  scrollY: number;
  /** Region-local Y offset (page px) where this slice's part starts. */
  offsetY: number;
  /** Height (page px) of the region covered by this slice. */
  height: number;
}

/**
 * The crop window to apply to one captured viewport bitmap, plus the
 * region-local placement of the cropped piece.
 */
export interface RegionCrop {
  /** Region-local Y offset (CSS px) — where the piece is pasted. */
  offsetY: number;
  /** Height of the cropped piece (CSS px). */
  cssHeight: number;
  /** Source rect inside the captured bitmap (bitmap/device px). */
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

// ─── Pure geometry helpers (unit-tested) ─────────────────────────────────────

/**
 * Turn a press point + a release point into a positive-width rectangle.
 *
 * Dragging up/left produces negative deltas — they are normalised here so
 * every downstream calculation can assume `width >= 0` / `height >= 0`.
 */
export function normalizeRegion(a: Point, b: Point): RegionSelection {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}

/** Minimum-size gate (architecture B1: 100x100). */
export function isRegionLargeEnough(
  region: RegionSelection,
  minSize: number = MIN_REGION_SIZE,
): boolean {
  return region.width >= minSize && region.height >= minSize;
}

/**
 * Clip a rectangle to a bounding box. Returns a zero-sized rectangle when
 * the two do not overlap at all.
 */
export function clampRegion(
  region: RegionSelection,
  bounds: { left: number; right: number; top: number; bottom: number },
): RegionSelection {
  const left = Math.max(region.x, bounds.left);
  const right = Math.min(region.x + region.width, bounds.right);
  const top = Math.max(region.y, bounds.top);
  const bottom = Math.min(region.y + region.height, bounds.bottom);
  return {
    x: left,
    y: top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

/**
 * Split the selected region into the viewport-height slices that cover it.
 *
 * The region may span several screens: the capture driver scrolls to each
 * slice in turn and stitches the pieces vertically.
 */
export function segmentsCoveringRegion(
  region: RegionSelection,
  plan: RegionPlanLike,
): RegionSlice[] {
  const viewportHeight = plan.viewportHeight;
  if (!(viewportHeight > 0) || !(region.height > 0)) return [];

  // The browser cannot scroll further than `totalHeight - viewportHeight`.
  const maxScroll = Math.max(0, plan.totalHeight - viewportHeight);
  const regionTop = region.y;
  const regionBottom = region.y + region.height;

  const first = Math.max(0, Math.floor(regionTop / viewportHeight));
  // `regionBottom - 1` keeps a region that ends exactly on a screen
  // boundary from spilling into one extra (empty) slice.
  const last = Math.max(
    first,
    Math.floor(Math.max(regionTop, regionBottom - 1) / viewportHeight),
  );

  const slices: RegionSlice[] = [];
  for (let screen = first; screen <= last; screen++) {
    const scrollY = Math.min(screen * viewportHeight, maxScroll);
    const top = Math.max(regionTop, scrollY);
    const bottom = Math.min(regionBottom, scrollY + viewportHeight);
    const height = bottom - top;
    if (height <= 0) continue;
    slices.push({
      index: slices.length,
      scrollY,
      offsetY: top - regionTop,
      height,
    });
  }
  return slices;
}

/**
 * Compute the crop window for one captured viewport.
 *
 * @param region  the selected rectangle (page-absolute CSS px)
 * @param scroll  the page scroll offset the viewport is currently at
 * @param viewport the viewport size in CSS px
 * @param scale   bitmap pixels per CSS pixel (bitmap.width / viewport.width)
 *
 * Returns `null` when the region does not overlap the viewport at all.
 */
export function computeRegionCrop(
  region: RegionSelection,
  scroll: { x: number; y: number },
  viewport: { width: number; height: number },
  scale: { x: number; y: number },
): RegionCrop | null {
  const top = Math.max(region.y, scroll.y);
  const bottom = Math.min(region.y + region.height, scroll.y + viewport.height);
  const left = Math.max(region.x, scroll.x);
  const right = Math.min(region.x + region.width, scroll.x + viewport.width);
  if (bottom <= top || right <= left) return null;

  // Round the *edges* instead of the size so neighbouring pieces never
  // overlap or leave a 1px gap after scaling.
  const sx0 = Math.round((left - scroll.x) * scale.x);
  const sx1 = Math.round((right - scroll.x) * scale.x);
  const sy0 = Math.round((top - scroll.y) * scale.y);
  const sy1 = Math.round((bottom - scroll.y) * scale.y);

  return {
    offsetY: top - region.y,
    cssHeight: bottom - top,
    sx: sx0,
    sy: sy0,
    sw: Math.max(1, sx1 - sx0),
    sh: Math.max(1, sy1 - sy0),
  };
}

// ─── DOM overlay ──────────────────────────────────────────────────────────────

/**
 * Ask the user to drag a rectangle over the page.
 *
 * Resolves with the selected rectangle in **page-absolute CSS px**, or
 * `null` when the user pressed Escape.
 *
 * The promise never rejects — a failed selection is always `null`.
 */
export function selectRegion(
  options: SelectRegionOptions = {},
): Promise<RegionSelection | null> {
  const minSize = options.minSize ?? MIN_REGION_SIZE;
  const hint = options.hint ?? '拖拽鼠标框选区域 · Esc 取消';

  return new Promise<RegionSelection | null>((resolve) => {
    const body = document.body;
    if (!body) {
      resolve(null);
      return;
    }

    const overlay = document.createElement('div');
    overlay.setAttribute(OVERLAY_ATTR, '1');
    applyOverlayStyles(overlay);

    const box = document.createElement('div');
    applyBoxStyles(box);

    const label = document.createElement('div');
    applyLabelStyles(label);

    const toast = document.createElement('div');
    applyToastStyles(toast);
    toast.textContent = hint;

    overlay.append(box, label, toast);

    // Remember the page's own inline styles so we can restore them exactly
    // (including the `!important` flag and the -webkit- alias).
    const savedUserSelect = body.style.getPropertyValue('user-select');
    const savedUserSelectPriority = body.style.getPropertyPriority('user-select');
    const savedWebkitUserSelect = body.style.getPropertyValue('-webkit-user-select');
    const savedWebkitUserSelectPriority = body.style.getPropertyPriority('-webkit-user-select');
    const savedCursor = body.style.getPropertyValue('cursor');
    const savedCursorPriority = body.style.getPropertyPriority('cursor');

    body.style.setProperty('user-select', 'none', 'important');
    body.style.setProperty('-webkit-user-select', 'none', 'important');
    body.style.setProperty('cursor', 'crosshair', 'important');

    /** Drag origin / current point in *client* (viewport) coordinates. */
    let startClient: Point | null = null;
    let currentClient: Point | null = null;
    let settled = false;

    const cleanup = (): void => {
      if (settled) return;
      settled = true;
      window.removeEventListener('mousedown', onMouseDown, true);
      window.removeEventListener('mousemove', onMouseMove, true);
      window.removeEventListener('mouseup', onMouseUp, true);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('wheel', onWheel, { capture: true } as EventListenerOptions);
      document.removeEventListener('mouseleave', onMouseLeave, true);
      document.removeEventListener('contextmenu', onContextMenu, true);
      overlay.remove();
      body.style.setProperty('user-select', savedUserSelect, savedUserSelectPriority);
      body.style.setProperty(
        '-webkit-user-select',
        savedWebkitUserSelect,
        savedWebkitUserSelectPriority,
      );
      body.style.setProperty('cursor', savedCursor, savedCursorPriority);
    };

    const finish = (region: RegionSelection | null): void => {
      cleanup();
      resolve(region);
    };

    const showToast = (message: string): void => {
      toast.textContent = message;
    };

    const updateBox = (): void => {
      if (!startClient || !currentClient) return;
      const left = Math.min(startClient.x, currentClient.x);
      const top = Math.min(startClient.y, currentClient.y);
      const width = Math.abs(currentClient.x - startClient.x);
      const height = Math.abs(currentClient.y - startClient.y);
      box.style.setProperty('left', `${left}px`, 'important');
      box.style.setProperty('top', `${top}px`, 'important');
      box.style.setProperty('width', `${width}px`, 'important');
      box.style.setProperty('height', `${height}px`, 'important');
      box.style.setProperty('display', 'block', 'important');
      label.textContent = `${Math.round(width)}×${Math.round(height)}`;
      label.style.setProperty('left', `${left}px`, 'important');
      // Prefer the label above the box; flip below when it would clip.
      const labelTop = top - 24 < 0 ? top + height + 6 : top - 24;
      label.style.setProperty('top', `${labelTop}px`, 'important');
      label.style.setProperty('display', 'block', 'important');
    };

    const onMouseDown = (e: MouseEvent): void => {
      if (e.button !== 0) return;
      // Stop the page from starting a text selection / image drag.
      e.preventDefault();
      e.stopPropagation();
      startClient = { x: e.clientX, y: e.clientY };
      currentClient = { x: e.clientX, y: e.clientY };
      updateBox();
    };

    const onMouseMove = (e: MouseEvent): void => {
      if (!startClient) return;
      e.preventDefault();
      e.stopPropagation();
      currentClient = { x: e.clientX, y: e.clientY };
      updateBox();
    };

    const onMouseUp = (e: MouseEvent): void => {
      if (!startClient) return;
      e.preventDefault();
      e.stopPropagation();
      const end: Point = { x: e.clientX, y: e.clientY };
      currentClient = end;
      const start: Point = startClient;
      startClient = null;

      const region = normalizeRegion(
        { x: start.x + window.scrollX, y: start.y + window.scrollY },
        { x: end.x + window.scrollX, y: end.y + window.scrollY },
      );

      // The region must stay inside the horizontally visible area: the
      // capture pipeline scrolls vertically only, so anything outside the
      // current viewport width could never be captured.
      const clamped = clampRegion(region, {
        left: window.scrollX,
        right: window.scrollX + window.innerWidth,
        top: 0,
        bottom: documentHeight(),
      });

      if (!isRegionLargeEnough(clamped, minSize)) {
        // Reject but keep the overlay alive so the user can simply try again.
        showToast(`选区太小（至少 ${minSize}×${minSize}px），请重新拖拽`);
        box.style.setProperty('display', 'none', 'important');
        label.style.setProperty('display', 'none', 'important');
        return;
      }

      finish(clamped);
    };

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      finish(null);
    };

    const onWheel = (e: WheelEvent): void => {
      // While dragging we freeze the page scroll so the drag stays
      // anchored to the same content. Outside of a drag the wheel is left
      // alone — the user must be able to scroll a long page.
      if (!startClient) return;
      e.preventDefault();
      e.stopPropagation();
    };

    const onMouseLeave = (): void => {
      // Pointer left the window while dragging → drop the drag, keep the
      // overlay (the user can press Escape or try again).
      if (!startClient) return;
      startClient = null;
      currentClient = null;
      box.style.setProperty('display', 'none', 'important');
      label.style.setProperty('display', 'none', 'important');
    };

    const onContextMenu = (e: MouseEvent): void => {
      e.preventDefault();
      e.stopPropagation();
    };

    window.addEventListener('mousedown', onMouseDown, true);
    window.addEventListener('mousemove', onMouseMove, true);
    window.addEventListener('mouseup', onMouseUp, true);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('wheel', onWheel, { capture: true, passive: false });
    document.addEventListener('mouseleave', onMouseLeave, true);
    document.addEventListener('contextmenu', onContextMenu, true);

    document.body.appendChild(overlay);
  });
}

// ─── Overlay styling helpers ─────────────────────────────────────────────────

/** Height of the scrollable document (falls back to the viewport height). */
function documentHeight(): number {
  const docEl = (document.scrollingElement ?? document.documentElement) as HTMLElement;
  const body = document.body;
  return Math.max(
    docEl?.scrollHeight ?? 0,
    body?.scrollHeight ?? 0,
    docEl?.offsetHeight ?? 0,
    body?.offsetHeight ?? 0,
    window.innerHeight,
  );
}

/**
 * `all: initial` wipes every inherited property (font, color, line-height,
 * direction, …) so the page's typography cannot leak into the overlay.
 * Everything we rely on is then re-declared with `!important` so a hostile
 * page rule (`div { position: static !important }`) cannot break it.
 */
function applyOverlayStyles(el: HTMLElement): void {
  el.style.setProperty('all', 'initial');
  el.style.setProperty('position', 'fixed', 'important');
  el.style.setProperty('top', '0', 'important');
  el.style.setProperty('left', '0', 'important');
  el.style.setProperty('right', '0', 'important');
  el.style.setProperty('bottom', '0', 'important');
  el.style.setProperty('width', '100%', 'important');
  el.style.setProperty('height', '100%', 'important');
  el.style.setProperty('display', 'block', 'important');
  el.style.setProperty('margin', '0', 'important');
  el.style.setProperty('padding', '0', 'important');
  el.style.setProperty('border', '0', 'important');
  el.style.setProperty('background', 'transparent', 'important');
  el.style.setProperty('overflow', 'hidden', 'important');
  el.style.setProperty('cursor', 'crosshair', 'important');
  el.style.setProperty('user-select', 'none', 'important');
  el.style.setProperty('-webkit-user-select', 'none', 'important');
  el.style.setProperty('touch-action', 'none', 'important');
  el.style.setProperty('opacity', '1', 'important');
  el.style.setProperty('visibility', 'visible', 'important');
  el.style.setProperty('box-sizing', 'border-box', 'important');
  el.style.setProperty('font-family', 'system-ui, -apple-system, sans-serif', 'important');
  el.style.setProperty('font-size', '13px', 'important');
  el.style.setProperty('line-height', '1.4', 'important');
  el.style.setProperty('font-weight', '500', 'important');
  el.style.setProperty('color', '#ffffff', 'important');
  el.style.setProperty('text-align', 'center', 'important');
  el.style.setProperty('direction', 'ltr', 'important');
  el.style.setProperty('transform', 'none', 'important');
  el.style.setProperty('transition', 'none', 'important');
  el.style.setProperty('animation', 'none', 'important');
  el.style.setProperty('pointer-events', 'auto', 'important');
  // Highest possible stacking level — the overlay must win over sticky
  // headers, cookie banners and modal dialogs.
  el.style.setProperty('z-index', '2147483647', 'important');
}

function applyBoxStyles(el: HTMLElement): void {
  el.style.setProperty('all', 'initial');
  el.style.setProperty('position', 'absolute', 'important');
  el.style.setProperty('display', 'none', 'important');
  el.style.setProperty('box-sizing', 'border-box', 'important');
  el.style.setProperty('background', 'rgba(56, 189, 248, 0.25)', 'important');
  el.style.setProperty('border', '1px solid rgba(2, 132, 199, 0.95)', 'important');
  el.style.setProperty('pointer-events', 'none', 'important');
}

function applyLabelStyles(el: HTMLElement): void {
  el.style.setProperty('all', 'initial');
  el.style.setProperty('position', 'absolute', 'important');
  el.style.setProperty('display', 'none', 'important');
  el.style.setProperty('padding', '2px 6px', 'important');
  el.style.setProperty('border-radius', '4px', 'important');
  el.style.setProperty('background', 'rgba(2, 132, 199, 0.95)', 'important');
  el.style.setProperty('color', '#ffffff', 'important');
  el.style.setProperty('font-family', 'system-ui, -apple-system, sans-serif', 'important');
  el.style.setProperty('font-size', '12px', 'important');
  el.style.setProperty('line-height', '1.4', 'important');
  el.style.setProperty('white-space', 'nowrap', 'important');
  el.style.setProperty('pointer-events', 'none', 'important');
}

function applyToastStyles(el: HTMLElement): void {
  el.style.setProperty('all', 'initial');
  el.style.setProperty('position', 'absolute', 'important');
  el.style.setProperty('top', '16px', 'important');
  el.style.setProperty('left', '50%', 'important');
  el.style.setProperty('transform', 'translateX(-50%)', 'important');
  el.style.setProperty('padding', '6px 12px', 'important');
  el.style.setProperty('border-radius', '6px', 'important');
  el.style.setProperty('background', 'rgba(15, 23, 42, 0.85)', 'important');
  el.style.setProperty('color', '#ffffff', 'important');
  el.style.setProperty('font-family', 'system-ui, -apple-system, sans-serif', 'important');
  el.style.setProperty('font-size', '12px', 'important');
  el.style.setProperty('line-height', '1.4', 'important');
  el.style.setProperty('white-space', 'nowrap', 'important');
  el.style.setProperty('pointer-events', 'none', 'important');
  el.style.setProperty('z-index', '2', 'important');
}
