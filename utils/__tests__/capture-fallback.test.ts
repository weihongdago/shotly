import { describe, expect, it } from 'vitest';
import {
  MAX_RETRY,
  RETRY_DELAY_MS,
  captureWithFallback,
  validateStitchedImage,
} from '../capture-fallback';
import { PROTOCOL_VERSION } from '../messaging';

// Build a blob with the proper magic bytes AND ≥ 256B total (matches
// validateStitchedImage's minimum size check).
function pngBlob(paddingBytes = 1024): Blob {
  const head = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const padding = new Uint8Array(paddingBytes);
  return new Blob([head, padding], { type: 'image/png' });
}

function jpegBlob(paddingBytes = 1024): Blob {
  const head = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
  const padding = new Uint8Array(paddingBytes);
  return new Blob([head, padding], { type: 'image/jpeg' });
}

describe('architecture v1.2 §2.3 / §3.5', () => {
  it('messaging protocol version is 1', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it('retry budget is 3 attempts with 1.5s backoff', () => {
    expect(MAX_RETRY).toBe(3);
    expect(RETRY_DELAY_MS).toBe(1500);
  });

  it('captureWithFallback: plan A succeeds on first try → method A, attempts=1', async () => {
    const result = await captureWithFallback(
      async () => pngBlob(),
      async () => null,
      { tabId: 1, mode: 'full' },
      { report: () => {} },
    );
    expect(result.method).toBe('A');
    expect(result.attempts).toBe(1);
  });

  it('captureWithFallback: plan A fails 3x → falls back to plan B', async () => {
    const blobB = jpegBlob();
    const events: string[] = [];
    const result = await captureWithFallback(
      async () => null,
      async () => blobB,
      { tabId: 1, mode: 'full' },
      { report: (e) => events.push(e) },
    );
    expect(result.method).toBe('B');
    expect(result.attempts).toBe(4); // 3 retries + 1 fallback
    expect(events).toContain('screenshot.full.fallback_b');
  });

  it('captureWithFallback: both plans fail → throws', async () => {
    await expect(
      captureWithFallback(
        async () => null,
        async () => null,
        { tabId: 1, mode: 'full' },
        { report: () => {} },
      ),
    ).rejects.toThrow(/both.*failed/);
  });
});

describe('validateStitchedImage', () => {
  it('accepts PNG signature with sufficient size', async () => {
    expect(await validateStitchedImage(pngBlob())).toBe(true);
  });

  it('accepts JPEG signature with sufficient size', async () => {
    expect(await validateStitchedImage(jpegBlob())).toBe(true);
  });

  it('rejects tiny blob (< 256 bytes) even with PNG signature', async () => {
    const tiny = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])]);
    expect(await validateStitchedImage(tiny)).toBe(false);
  });

  it('rejects garbage bytes', async () => {
    const garbage = new Blob([new Uint8Array(512).fill(0xab)]);
    expect(await validateStitchedImage(garbage)).toBe(false);
  });

  it('rejects zero-byte blob', async () => {
    expect(await validateStitchedImage(new Blob([]))).toBe(false);
  });
});