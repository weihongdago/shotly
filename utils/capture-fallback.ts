/**
 * Capture with retry + fallback (architecture v1.2 §3.5.1)
 *
 * Strategy:
 *   1. Try plan A (scroll-and-stitch + captureVisibleTab) up to 3 times.
 *   2. Between retries, wait 1500ms.
 *   3. After 3 failures → fall back to plan B (DOM→canvas via html2canvas family).
 *   4. Report which plan succeeded via telemetry event.
 *
 * NOTE: This module is a skeleton on D+1. The real Plan A implementation
 * lives in screenshot-engine.ts and offscreen stitcher. Plan B requires
 * html2canvas + DOM serialization — slated for D+2~D+3.
 */

import { sleep } from './messaging';

export const MAX_RETRY = 3;
export const RETRY_DELAY_MS = 1500;

export type CaptureMethod = 'A' | 'B';

export interface CaptureOpts {
  tabId: number;
  mode: 'full' | 'visible' | 'region';
  segmentHeight?: number; // default 4096
}

export interface CaptureResult {
  blob: Blob;
  method: CaptureMethod;
  attempts: number;
  durationMs: number;
}

export interface CaptureTelemetry {
  report: (event: string, payload?: Record<string, unknown>) => void;
}

/**
 * Top-level wrapper — tries A then B (architecture §3.5.1).
 * Throws if both strategies fail.
 */
export async function captureWithFallback(
  planA: () => Promise<Blob | null>,
  planB: () => Promise<Blob | null>,
  opts: CaptureOpts,
  telemetry: CaptureTelemetry,
): Promise<CaptureResult> {
  const startedAt = Date.now();

  // === Plan A: scroll-and-stitch ===
  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    try {
      const blob = await planA();
      if (blob && (await validateStitchedImage(blob))) {
        return {
          blob,
          method: 'A',
          attempts: attempt,
          durationMs: Date.now() - startedAt,
        };
      }
      throw new Error('Plan A returned null or invalid blob');
    } catch (err) {
      console.warn(
        `[shotly] capture plan-A attempt ${attempt}/${MAX_RETRY} failed:`,
        err,
      );
      telemetry.report('screenshot.full.retry', {
        attempt,
        mode: opts.mode,
        reason: (err as Error).message,
      });
      if (attempt < MAX_RETRY) {
        await sleep(RETRY_DELAY_MS);
      }
    }
  }

  // === Plan B fallback: DOM render ===
  console.warn('[shotly] falling back to plan-B (html2canvas family)');
  telemetry.report('screenshot.full.fallback_b', { mode: opts.mode });
  const blobB = await planB();
  if (!blobB) {
    telemetry.report('screenshot.full.fail', {
      mode: opts.mode,
      reason: 'both_plans_failed',
    });
    throw new Error('[shotly] capture failed: both plan A (3 retries) and plan B failed');
  }
  return {
    blob: blobB,
    method: 'B',
    attempts: MAX_RETRY + 1,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Validate the produced blob — reject empty/tiny/corrupt outputs.
 * Cheap check: size + magic bytes (PNG 89 50 4E 47 / JPEG FF D8 FF).
 */
export async function validateStitchedImage(blob: Blob): Promise<boolean> {
  if (!blob || blob.size < 256) return false;
  const head = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
  // PNG signature: 89 50 4E 47 0D 0A 1A 0A
  if (
    head[0] === 0x89 &&
    head[1] === 0x50 &&
    head[2] === 0x4e &&
    head[3] === 0x47
  ) {
    return true;
  }
  // JPEG signature: FF D8 FF
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return true;
  }
  // WebP: RIFF????WEBP
  if (
    head[0] === 0x52 &&
    head[1] === 0x49 &&
    head[2] === 0x46 &&
    head[3] === 0x46 &&
    head[8] === 0x57 &&
    head[9] === 0x45 &&
    head[10] === 0x42 &&
    head[11] === 0x50
  ) {
    return true;
  }
  return false;
}