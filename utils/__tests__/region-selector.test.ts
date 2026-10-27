import { describe, expect, it } from 'vitest';
import { OVERLAY_ATTR, sweepRegionOverlays } from '../region-selector';
import {
  MIN_REGION_SIZE,
  clampRegion,
  computeRegionCrop,
  isRegionLargeEnough,
  normalizeRegion,
  segmentsCoveringRegion,
  type RegionSlice,
} from '../region-selector';
import { REGION_MSG } from '../messaging';

// ─── Protocol contract ───────────────────────────────────────────────────────

describe('REGION_MSG protocol (architecture §3.2, decision B1)', () => {
  it('exposes the three region message types', () => {
    expect(REGION_MSG).toEqual({
      START: 'region:start',
      SELECTED: 'region:selected',
      CANCELLED: 'region:cancelled',
    });
  });

  it('MIN_REGION_SIZE is 100 (architecture B1: "最小支持 100x100")', () => {
    expect(MIN_REGION_SIZE).toBe(100);
  });
});

// ─── normalizeRegion ─────────────────────────────────────────────────────────

describe('normalizeRegion', () => {
  it('keeps a down-right drag as-is', () => {
    expect(normalizeRegion({ x: 10, y: 20 }, { x: 110, y: 220 })).toEqual({
      x: 10,
      y: 20,
      width: 100,
      height: 200,
    });
  });

  it('normalises an up-left drag (negative deltas)', () => {
    const region = normalizeRegion({ x: 300, y: 400 }, { x: 100, y: 150 });
    expect(region).toEqual({ x: 100, y: 150, width: 200, height: 250 });
    expect(region.width).toBeGreaterThan(0);
    expect(region.height).toBeGreaterThan(0);
  });

  it('normalises a mixed drag (right-up)', () => {
    expect(normalizeRegion({ x: 50, y: 500 }, { x: 250, y: 100 })).toEqual({
      x: 50,
      y: 100,
      width: 200,
      height: 400,
    });
  });

  it('returns a zero-sized rectangle for a click without drag', () => {
    expect(normalizeRegion({ x: 42, y: 42 }, { x: 42, y: 42 })).toEqual({
      x: 42,
      y: 42,
      width: 0,
      height: 0,
    });
  });
});

// ─── isRegionLargeEnough ─────────────────────────────────────────────────────

describe('isRegionLargeEnough', () => {
  it('accepts exactly 100x100', () => {
    expect(isRegionLargeEnough({ x: 0, y: 0, width: 100, height: 100 })).toBe(true);
  });

  it('rejects a 99px wide region', () => {
    expect(isRegionLargeEnough({ x: 0, y: 0, width: 99, height: 400 })).toBe(false);
  });

  it('rejects a 99px tall region', () => {
    expect(isRegionLargeEnough({ x: 0, y: 0, width: 400, height: 99 })).toBe(false);
  });

  it('honours a custom minimum size', () => {
    expect(isRegionLargeEnough({ x: 0, y: 0, width: 120, height: 120 }, 200)).toBe(false);
    expect(isRegionLargeEnough({ x: 0, y: 0, width: 220, height: 220 }, 200)).toBe(true);
  });
});

// ─── clampRegion ─────────────────────────────────────────────────────────────

describe('clampRegion', () => {
  it('clips a region to the given bounds', () => {
    const clamped = clampRegion(
      { x: 50, y: 50, width: 500, height: 500 },
      { left: 0, right: 400, top: 0, bottom: 300 },
    );
    expect(clamped).toEqual({ x: 50, y: 50, width: 350, height: 250 });
  });

  it('returns a zero-sized rectangle when there is no overlap', () => {
    const clamped = clampRegion(
      { x: 900, y: 900, width: 100, height: 100 },
      { left: 0, right: 400, top: 0, bottom: 300 },
    );
    expect(clamped).toEqual({ x: 900, y: 900, width: 0, height: 0 });
  });
});

// ─── segmentsCoveringRegion ──────────────────────────────────────────────────

describe('segmentsCoveringRegion', () => {
  const plan = { viewportHeight: 720, totalHeight: 10_000 };

  it('returns a single slice for a region inside one viewport', () => {
    const slices = segmentsCoveringRegion({ x: 0, y: 100, width: 200, height: 300 }, plan);
    expect(slices).toHaveLength(1);
    expect(slices[0]).toMatchObject({ index: 0, scrollY: 0, offsetY: 0, height: 300 });
  });

  it('splits a region spanning three viewports and keeps the heights consistent', () => {
    const region = { x: 0, y: 500, width: 200, height: 1500 };
    const slices: RegionSlice[] = segmentsCoveringRegion(region, plan);

    expect(slices).toHaveLength(3);
    // The pieces must tile the region exactly: no gap, no overlap.
    expect(slices.reduce((sum, s) => sum + s.height, 0)).toBe(region.height);
    expect(slices[0]).toMatchObject({ scrollY: 0, offsetY: 0, height: 220 });
    expect(slices[1]).toMatchObject({ scrollY: 720, offsetY: 220, height: 720 });
    expect(slices[2]).toMatchObject({ scrollY: 1440, offsetY: 940, height: 560 });
    // Each slice starts where the previous one ended.
    for (let i = 1; i < slices.length; i++) {
      expect(slices[i].offsetY).toBe(slices[i - 1].offsetY + slices[i - 1].height);
    }
  });

  it('does not spill into an extra slice when the region ends on a boundary', () => {
    const slices = segmentsCoveringRegion({ x: 0, y: 0, width: 100, height: 720 }, plan);
    expect(slices).toHaveLength(1);
    expect(slices[0].height).toBe(720);
  });

  it('clamps the scroll target at the end of the document', () => {
    // A 1000px document with a 720px viewport can only scroll to 280.
    const shortPlan = { viewportHeight: 720, totalHeight: 1000 };
    const slices = segmentsCoveringRegion({ x: 0, y: 900, width: 100, height: 100 }, shortPlan);
    expect(slices).toHaveLength(1);
    expect(slices[0].scrollY).toBe(280);
    // The whole region fits into the last (clamped) screen.
    expect(slices[0].offsetY).toBe(0);
    expect(slices[0].height).toBe(100);
  });

  it('returns nothing for an empty region or a broken plan', () => {
    expect(segmentsCoveringRegion({ x: 0, y: 0, width: 100, height: 0 }, plan)).toEqual([]);
    expect(
      segmentsCoveringRegion({ x: 0, y: 0, width: 100, height: 100 }, {
        viewportHeight: 0,
        totalHeight: 1000,
      }),
    ).toEqual([]);
  });
});

// ─── computeRegionCrop ───────────────────────────────────────────────────────

describe('computeRegionCrop', () => {
  const viewport = { width: 800, height: 600 };
  const scale = { x: 2, y: 2 }; // devicePixelRatio = 2

  it('crops the visible part of the region (first screen)', () => {
    const crop = computeRegionCrop(
      { x: 100, y: 50, width: 300, height: 200 },
      { x: 0, y: 0 },
      viewport,
      scale,
    );
    expect(crop).not.toBeNull();
    // Device pixels: 100*2 … 400*2 horizontally, 50*2 … 250*2 vertically.
    expect(crop?.sx).toBe(200);
    expect(crop?.sy).toBe(100);
    expect(crop?.sw).toBe(600);
    expect(crop?.sh).toBe(400);
    expect(crop?.offsetY).toBe(0);
    expect(crop?.cssHeight).toBe(200);
  });

  it('offsets the crop when the region starts above the viewport', () => {
    const crop = computeRegionCrop(
      { x: 0, y: 800, width: 200, height: 300 },
      { x: 0, y: 900 },
      viewport,
      scale,
    );
    // The region starts 100px above the viewport → only 200px are visible.
    expect(crop?.offsetY).toBe(100);
    expect(crop?.cssHeight).toBe(200);
    expect(crop?.sy).toBe(0);
    expect(crop?.sh).toBe(400);
  });

  it('crops the whole region when it is fully inside the viewport', () => {
    const crop = computeRegionCrop(
      { x: 0, y: 1000, width: 200, height: 300 },
      { x: 0, y: 900 },
      viewport,
      scale,
    );
    expect(crop?.offsetY).toBe(0);
    expect(crop?.cssHeight).toBe(300);
    expect(crop?.sy).toBe(200); // (1000 - 900) * 2
    expect(crop?.sh).toBe(600); // 300 * 2
  });

  it('accounts for a horizontal scroll offset', () => {
    const crop = computeRegionCrop(
      { x: 500, y: 0, width: 200, height: 200 },
      { x: 300, y: 0 },
      viewport,
      scale,
    );
    expect(crop?.sx).toBe(400); // (500 - 300) * 2
    expect(crop?.sw).toBe(400); // 200 * 2
  });

  it('returns null when the region is not visible at all', () => {
    const crop = computeRegionCrop(
      { x: 0, y: 5000, width: 200, height: 200 },
      { x: 0, y: 0 },
      viewport,
      scale,
    );
    expect(crop).toBeNull();
  });

  it('returns null when the region is horizontally out of view', () => {
    const crop = computeRegionCrop(
      { x: 5000, y: 0, width: 200, height: 200 },
      { x: 0, y: 0 },
      viewport,
      scale,
    );
    expect(crop).toBeNull();
  });
});

// ─── Overlay leftovers ───────────────────────────────────────────────────────

describe('sweepRegionOverlays', () => {
  function clearBody() {
    document.body.innerHTML = '';
  }

  it('removes a leftover overlay and reports the count', () => {
    clearBody();
    const overlay = document.createElement('div');
    overlay.setAttribute(OVERLAY_ATTR, '1');
    document.body.append(overlay);

    expect(sweepRegionOverlays()).toBe(1);
    expect(document.querySelector(`[${OVERLAY_ATTR}]`)).toBeNull();
  });

  it('leaves the page content alone', () => {
    clearBody();
    const keep = document.createElement('div');
    keep.className = 'page-content';
    const overlay = document.createElement('div');
    overlay.setAttribute(OVERLAY_ATTR, '1');
    document.body.append(keep, overlay);

    sweepRegionOverlays();

    expect(document.body.contains(keep)).toBe(true);
    expect(document.body.contains(overlay)).toBe(false);
  });

  it('is a no-op when there is no leftover', () => {
    clearBody();
    document.body.append(document.createElement('p'));
    expect(sweepRegionOverlays()).toBe(0);
  });

  it('the overlay attribute is the documented marker', () => {
    // The content script sweeps by this exact attribute name — if it
    // changes, both sides have to change together.
    expect(OVERLAY_ATTR).toBe('data-shotly-region-overlay');
  });
});
