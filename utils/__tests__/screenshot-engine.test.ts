import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SEGMENT_HEIGHT,
  HARD_PAGE_LIMIT_PX,
  MAX_CANVAS_DIMENSION_PX,
  PER_SEGMENT_BUFFER_MS,
  exceedsCanvasLimit,
  hideFixedElements,
  isPageTooLong,
  maxAllowedCssHeight,
  planCapture,
  primeLazyImages,
  resolveDeviceScale,
  restoreFixedElements,
  waitForIframesReady,
  waitForPaint,
  type ScreenshotPlan,
} from '../screenshot-engine';

// ─── helpers ─────────────────────────────────────────────────────────────────

function setViewport(width: number, height: number, dpr = 1) {
  Object.defineProperty(window, 'innerWidth', { value: width, writable: true, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: height, writable: true, configurable: true });
  Object.defineProperty(window, 'devicePixelRatio', { value: dpr, writable: true, configurable: true });
}

function setDocumentHeight(totalHeight: number) {
  Object.defineProperty(document.documentElement, 'scrollHeight', { value: totalHeight, configurable: true });
  Object.defineProperty(document.body, 'scrollHeight', { value: totalHeight, configurable: true });
  Object.defineProperty(document.documentElement, 'offsetHeight', { value: totalHeight, configurable: true });
  Object.defineProperty(document.body, 'offsetHeight', { value: totalHeight, configurable: true });
}

function makeEl(
  tag: string,
  styles: Partial<CSSStyleDeclaration>,
  attrs: Record<string, string> = {},
  rect: { width: number; height: number } = { width: 400, height: 300 },
): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  Object.entries(styles).forEach(([k, v]) => {
    try { (el.style as any)[k] = String(v); } catch { /* ignored */ }
  });
  // happy-dom defaults getBoundingClientRect to 0×0 — override for filter tests
  Object.defineProperty(el, 'getBoundingClientRect', {
    value: () => ({
      width: rect.width,
      height: rect.height,
      top: 0,
      left: 0,
      right: rect.width,
      bottom: rect.height,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
    configurable: true,
  });
  return el;
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe('screenshot-engine constants (architecture §3)', () => {
  it('DEFAULT_SEGMENT_HEIGHT = 4096 (architecture §3.1 locked)', () => {
    expect(DEFAULT_SEGMENT_HEIGHT).toBe(4096);
  });

  it('HARD_PAGE_LIMIT_PX = 50_000 (architecture §3.6 PoC ceiling)', () => {
    expect(HARD_PAGE_LIMIT_PX).toBe(50_000);
  });

  it('PER_SEGMENT_BUFFER_MS = 1500 (architecture §3.3 lazy-load buffer)', () => {
    expect(PER_SEGMENT_BUFFER_MS).toBe(1500);
  });
});

describe('planCapture', () => {
  beforeEach(() => {
    setViewport(1280, 720, 2);
    setDocumentHeight(8000);
  });

  it('returns plan with correct total/viewport/dpr', () => {
    const plan = planCapture();
    expect(plan.totalHeight).toBe(8000);
    expect(plan.viewportWidth).toBe(1280);
    expect(plan.viewportHeight).toBe(720);
    expect(plan.devicePixelRatio).toBe(2);
  });

  it('splits 8_000px into 2 segments of 4_096 (default)', () => {
    const plan = planCapture();
    expect(plan.segments).toHaveLength(2);
    expect(plan.segments[0]).toMatchObject({ startY: 0, endY: 4096, height: 4096 });
    expect(plan.segments[1]).toMatchObject({ startY: 4096, endY: 8000, height: 3904 });
  });

  it('honors custom segmentHeight', () => {
    const plan = planCapture(2000);
    expect(plan.segments).toHaveLength(4);
    expect(plan.segments.map((s) => s.startY)).toEqual([0, 2000, 4000, 6000]);
  });

  it('handles exact multiple of segment height', () => {
    setDocumentHeight(8192); // exactly 2 × 4096
    const plan = planCapture();
    expect(plan.segments).toHaveLength(2);
    expect(plan.segments[1].endY).toBe(8192);
    expect(plan.segments[1].height).toBe(4096);
  });

  it('handles tiny page (under one segment)', () => {
    setDocumentHeight(500);
    const plan = planCapture();
    expect(plan.segments).toHaveLength(1);
    expect(plan.segments[0]).toMatchObject({ startY: 0, endY: 500, height: 500 });
  });

  it('handles zero-height page', () => {
    setDocumentHeight(0);
    const plan = planCapture();
    expect(plan.segments).toHaveLength(0);
    expect(plan.totalHeight).toBe(0);
  });

  it('produces contiguous, non-overlapping segments', () => {
    const plan = planCapture(1500);
    for (let i = 1; i < plan.segments.length; i++) {
      expect(plan.segments[i].startY).toBe(plan.segments[i - 1].endY);
    }
  });

  it('index field increments from 0', () => {
    const plan = planCapture(2000);
    expect(plan.segments.map((s) => s.index)).toEqual([0, 1, 2, 3]);
  });

  it('50_000px page = 13 segments at default (last partial)', () => {
    setDocumentHeight(50_000);
    const plan = planCapture();
    expect(plan.segments).toHaveLength(13);
    expect(plan.segments.at(-1)?.height).toBe(50_000 - 12 * 4096); // 832
  });
});

describe('isPageTooLong', () => {
  const basePlan: ScreenshotPlan = {
    totalHeight: 0,
    viewportHeight: 720,
    viewportWidth: 1280,
    devicePixelRatio: 1,
    segments: [],
  };

  it('returns false under 50_000', () => {
    expect(isPageTooLong({ ...basePlan, totalHeight: 49_999 })).toBe(false);
  });
  it('returns false at exactly 50_000', () => {
    expect(isPageTooLong({ ...basePlan, totalHeight: 50_000 })).toBe(false);
  });
  it('returns true over 50_000', () => {
    expect(isPageTooLong({ ...basePlan, totalHeight: 50_001 })).toBe(true);
  });
});

describe('hideFixedElements / restoreFixedElements', () => {
  let appended: HTMLElement[] = [];

  beforeEach(() => {
    appended = [];
  });
  afterEach(() => {
    appended.forEach((el) => el.remove());
    appended = [];
  });

  function addEl(el: HTMLElement) {
    document.body.appendChild(el);
    appended.push(el);
    return el;
  }

  it('hides position:fixed with z-index >= 1', () => {
    const el = addEl(makeEl('div', { position: 'fixed', zIndex: '10' } as any));
    const hidden = hideFixedElements();
    expect(hidden).toHaveLength(1);
    expect(hidden[0].el).toBe(el);
    expect(el.style.visibility).toBe('hidden');
  });

  it('hides position:sticky with z-index >= 1', () => {
    const el = addEl(makeEl('div', { position: 'sticky', zIndex: '5' } as any));
    const hidden = hideFixedElements();
    expect(hidden.some((h) => h.el === el)).toBe(true);
    expect(el.style.visibility).toBe('hidden');
  });

  it('does NOT hide position:static', () => {
    const el = addEl(makeEl('div', { position: 'static' } as any));
    const hidden = hideFixedElements();
    expect(hidden.some((h) => h.el === el)).toBe(false);
    expect(el.style.visibility).not.toBe('hidden');
  });

  it('does NOT hide fixed elements without z-index', () => {
    const el = addEl(makeEl('div', { position: 'fixed' } as any));
    const hidden = hideFixedElements();
    expect(hidden.some((h) => h.el === el)).toBe(false);
  });

  it('does NOT hide tiny fixed badges (<24x24)', () => {
    const el = addEl(makeEl('div', { position: 'fixed', zIndex: '100' } as any, {}, { width: 16, height: 16 }));
    const hidden = hideFixedElements();
    expect(hidden.some((h) => h.el === el)).toBe(false);
  });

  it('restoreFixedElements restores visibility', () => {
    const el = addEl(makeEl('div', { position: 'fixed', zIndex: '10', visibility: 'visible' } as any));
    const hidden = hideFixedElements();
    expect(el.style.visibility).toBe('hidden');
    restoreFixedElements(hidden);
    expect(el.style.visibility).toBe('visible');
  });

  it('restoreFixedElements handles empty list (no-op)', () => {
    expect(() => restoreFixedElements([])).not.toThrow();
  });

  it('round-trip preserves original inline styles', () => {
    const el = addEl(makeEl('div', { position: 'fixed', zIndex: '10' } as any));
    el.style.display = 'flex';
    el.style.visibility = 'visible';
    const hidden = hideFixedElements();
    restoreFixedElements(hidden);
    expect(el.style.display).toBe('flex');
    expect(el.style.visibility).toBe('visible');
  });
});

describe('primeLazyImages', () => {
  afterEach(() => {
    document.querySelectorAll('img').forEach((i) => i.remove());
  });

  it('returns 0 when no images present', () => {
    expect(primeLazyImages()).toBe(0);
  });

  it('switches loading="lazy" to loading="eager" and counts them', () => {
    const a = document.createElement('img');
    a.setAttribute('loading', 'lazy');
    const b = document.createElement('img');
    b.setAttribute('loading', 'lazy');
    const c = document.createElement('img'); // no loading attr
    document.body.append(a, b, c);

    const count = primeLazyImages();
    expect(count).toBe(2);
    expect(a.getAttribute('loading')).toBe('eager');
    expect(b.getAttribute('loading')).toBe('eager');
    expect(c.getAttribute('loading')).toBeNull();
  });

  it('does not touch images already eager', () => {
    const a = document.createElement('img');
    a.setAttribute('loading', 'eager');
    document.body.append(a);
    expect(primeLazyImages()).toBe(0);
  });
});

describe('ScreenshotPlan shape (compile + runtime sanity)', () => {
  it('planCapture returns a well-typed ScreenshotPlan', () => {
    setViewport(1024, 768);
    setDocumentHeight(2048);
    const plan: ScreenshotPlan = planCapture();
    expect(plan).toHaveProperty('totalHeight');
    expect(plan).toHaveProperty('viewportHeight');
    expect(plan).toHaveProperty('viewportWidth');
    expect(plan).toHaveProperty('devicePixelRatio');
    expect(Array.isArray(plan.segments)).toBe(true);
  });
});

// ─── Device-pixel limits (DPR-aware) ─────────────────────────────────────────

describe('device-pixel canvas limits', () => {
  it('MAX_CANVAS_DIMENSION_PX = 65_535 (Chrome max canvas dimension)', () => {
    // Measured, not guessed — see test-infra/probe-canvas-limits.mjs:
    // 2560×60_000 works, 2560×70_000 fails, even though the latter has
    // *more* pixels. The binding constraint is the dimension, not the area.
    expect(MAX_CANVAS_DIMENSION_PX).toBe(65_535);
  });

  it('maxAllowedCssHeight at DPR=1 is the architecture limit', () => {
    expect(maxAllowedCssHeight(1)).toBe(HARD_PAGE_LIMIT_PX);
    expect(maxAllowedCssHeight(1)).toBe(50_000);
  });

  it('maxAllowedCssHeight shrinks as the DPR grows', () => {
    expect(maxAllowedCssHeight(2)).toBe(32_767);
    expect(maxAllowedCssHeight(3)).toBe(21_845);
    expect(maxAllowedCssHeight(2)).toBeLessThan(maxAllowedCssHeight(1));
  });

  it('maxAllowedCssHeight treats a nonsense scale as 1', () => {
    expect(maxAllowedCssHeight(0)).toBe(HARD_PAGE_LIMIT_PX);
    expect(maxAllowedCssHeight(-1)).toBe(HARD_PAGE_LIMIT_PX);
    expect(maxAllowedCssHeight(Number.NaN)).toBe(HARD_PAGE_LIMIT_PX);
  });

  it('exceedsCanvasLimit allows a 50k page at DPR=1', () => {
    expect(exceedsCanvasLimit(1280, 50_000, 1)).toBe(false);
  });

  it('exceedsCanvasLimit rejects the same page at DPR=2', () => {
    // 50_000 CSS px × 2 = 100_000 device px > 65_535 → refused up front.
    expect(exceedsCanvasLimit(1280, 50_000, 2)).toBe(true);
  });

  it('exceedsCanvasLimit allows the PoC-D3 S2 target at DPR=2', () => {
    // 30_000 CSS px × 2 = 60_000 device px — still inside the limit.
    expect(exceedsCanvasLimit(1280, 30_000, 2)).toBe(false);
  });

  it('exceedsCanvasLimit also guards the width', () => {
    expect(exceedsCanvasLimit(70_000, 800, 1)).toBe(true);
    expect(exceedsCanvasLimit(1280, 800, 1)).toBe(false);
  });

  it('exceedsCanvasLimit treats a nonsense scale as 1', () => {
    expect(exceedsCanvasLimit(1280, 50_000, 0)).toBe(false);
    expect(exceedsCanvasLimit(1280, 50_000, Number.NaN)).toBe(false);
  });
});

// ─── Device scale resolution ─────────────────────────────────────────────────

describe('waitForIframesReady (S3 race)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    Object.defineProperty(window, 'location', {
      value: { href: 'https://example.com/' },
      writable: true,
      configurable: true,
    });
  });
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('returns 0 when there are no iframes', async () => {
    await expect(waitForIframesReady(50)).resolves.toBe(0);
  });

  it('waits for a same-origin iframe and resolves once it has loaded', async () => {
    const frame = document.createElement('iframe');
    frame.src = 'child.html';
    document.body.append(frame);

    // Simulate "still loading": the document is not complete yet.
    Object.defineProperty(frame, 'contentDocument', {
      get: () => ({ readyState: 'loading' }) as unknown as Document,
      configurable: true,
    });

    const pending = waitForIframesReady(1_000);
    setTimeout(() => frame.dispatchEvent(new Event('load')), 10);
    await expect(pending).resolves.toBe(1);
  });

  it('does not wait for a cross-origin iframe (it becomes a placeholder)', async () => {
    const frame = document.createElement('iframe');
    frame.src = 'https://youtube.com/embed/1';
    document.body.append(frame);
    Object.defineProperty(frame, 'contentDocument', {
      get: () => {
        throw new DOMException('cross-origin', 'SecurityError');
      },
      configurable: true,
    });

    // Resolves immediately — no cross-origin frame is waited on.
    await expect(waitForIframesReady(200)).resolves.toBe(0);
  });

  it('gives up after the timeout instead of hanging forever', async () => {
    const frame = document.createElement('iframe');
    frame.src = 'child.html';
    document.body.append(frame);
    Object.defineProperty(frame, 'contentDocument', {
      get: () => ({ readyState: 'loading' }) as unknown as Document,
      configurable: true,
    });

    const started = Date.now();
    await expect(waitForIframesReady(60)).resolves.toBe(1);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('waitForPaint', () => {
  it('waits for two animation frames (one frame is a race)', async () => {
    let frames = 0;
    const original = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      frames += 1;
      // Fire asynchronously, like the real thing.
      return setTimeout(() => cb(performance.now()), 0) as unknown as number;
    }) as typeof requestAnimationFrame;

    try {
      await waitForPaint();
      expect(frames).toBe(2);
    } finally {
      globalThis.requestAnimationFrame = original;
    }
  });

  it('resolves even when requestAnimationFrame is unavailable', async () => {
    const original = globalThis.requestAnimationFrame;
    // @ts-expect-error — deliberately removing the API
    delete globalThis.requestAnimationFrame;
    try {
      await expect(waitForPaint()).resolves.toBeUndefined();
    } finally {
      globalThis.requestAnimationFrame = original;
    }
  });
});

describe('resolveDeviceScale', () => {
  it('trusts the page DPR when the bitmap can hold the viewport at that scale', () => {
    // A real Retina browser: layout viewport 1280×800, raster 2560×1600.
    const r = resolveDeviceScale(1280, 800, 2560, 1600, 2);
    expect(r).toEqual({ scale: 2, source: 'dpr' });
  });

  it('ignores widget overhang (bitmap LARGER than the layout viewport)', () => {
    // ⚠️ The bug this whole function exists for. `captureVisibleTab`
    // grabs the browser *widget*, which can be bigger than the page's
    // layout viewport (measured: a 1282×839 widget rasterising a
    // 1280×800 layout viewport → 2564×1678 device px).
    //
    // Naively computing bitmap.height / viewportHeight gives 1678/800 =
    // 2.0975 — a 4.9% vertical stretch, silently, with no error. The
    // marker probe (probe-marker-mapping.mjs) proves the real scale is
    // exactly 2: markers at CSS y=100/300/500/700 landed on bitmap rows
    // 200/600/1000/1400.
    const r = resolveDeviceScale(1280, 800, 2564, 1678, 2);
    expect(r).toEqual({ scale: 2, source: 'dpr' });
  });

  it('falls back to the bitmap when the raster is coarser than the DPR claims', () => {
    // Playwright's CDP deviceScaleFactor emulation: the page believes it
    // is on a 2× screen, but the widget still rasters at 1×. Trusting the
    // DPR here would upscale a 1× bitmap into a 2× canvas — soft, blurry,
    // twice the memory for no extra detail.
    const r = resolveDeviceScale(1280, 800, 1282, 839, 2);
    expect(r.source).toBe('bitmap');
    expect(r.scale).toBeCloseTo(1.0015, 3);
  });

  it('uses the smaller ratio when falling back (widget overhang inflates it)', () => {
    // width ratio 1.0015, height ratio 1.0488 → the tighter (width) fit
    // is the honest one.
    const r = resolveDeviceScale(1280, 800, 1282, 839, 2);
    expect(r.scale).toBeLessThan(1.0488);
  });

  it('treats a nonsensical DPR as 1', () => {
    expect(resolveDeviceScale(1280, 800, 1280, 800, 0).scale).toBe(1);
    expect(resolveDeviceScale(1280, 800, 1280, 800, Number.NaN).scale).toBe(1);
    expect(resolveDeviceScale(1280, 800, 1280, 800, -3).scale).toBe(1);
  });

  it('survives a zero-sized viewport', () => {
    const r = resolveDeviceScale(0, 0, 0, 0, 2);
    expect(Number.isFinite(r.scale)).toBe(true);
    expect(r.scale).toBeGreaterThan(0);
  });
});
