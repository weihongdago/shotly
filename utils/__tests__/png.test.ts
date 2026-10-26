import { describe, expect, it } from 'vitest';
import { isPngHeader, readPngDimensions } from '../png';

/**
 * Regression coverage for the data-URL decoding logic.
 *
 * Two real defects are locked down here:
 *
 * 1. **Percent-encoded PNG data URLs never worked.** The old code sliced
 *    a 32-char window for every encoding. Base64 packs 3 bytes into 4
 *    chars (32 chars = 24 bytes, just enough for the PNG header), but
 *    percent-encoding uses 3 chars per byte — so 32 chars yielded only
 *    ~10 bytes and every percent-encoded URL failed with `not a PNG`.
 *
 * 2. **The encoding was guessed from the first character** (`/^[!-/]/`).
 *    That range includes `+` (0x2B) and `/` (0x2F), both valid base64
 *    characters. A PNG's base64 always begins `iVBORw0KGgo` so the guess
 *    happened to work, but it was correct by coincidence, not by design.
 *    The `;base64` marker is now authoritative.
 */

function makePngBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(40);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13, false); // IHDR length
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // 'IHDR'
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  return bytes;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

describe('utils/png', () => {
  it('isPngHeader accepts a real PNG header', () => {
    expect(isPngHeader(makePngBytes(1280, 4800))).toBe(true);
  });

  it('isPngHeader rejects a non-PNG buffer', () => {
    expect(isPngHeader(new Uint8Array(40))).toBe(false);
    expect(isPngHeader(new Uint8Array(4))).toBe(false);
  });

  it('reads dimensions from a base64 data URL', async () => {
    const url = `data:image/png;base64,${toBase64(makePngBytes(1280, 4800))}`;
    await expect(readPngDimensions(url)).resolves.toEqual({
      width: 1280,
      height: 4800,
    });
  });

  it('reads dimensions from a percent-encoded data URL', async () => {
    const bytes = makePngBytes(640, 480);
    const percent = Array.from(bytes)
      .map((b) => `%${b.toString(16).padStart(2, '0')}`)
      .join('');
    const url = `data:image/png,${percent}`;
    await expect(readPngDimensions(url)).resolves.toEqual({
      width: 640,
      height: 480,
    });
  });

  it('handles a base64 payload WITHOUT the ";base64" marker', async () => {
    // The old implementation only got this right by luck: it sniffed the
    // first character and PNG base64 always starts with "i" (0x69), which
    // is outside the `!`-`/` range it used to detect percent-encoding.
    // Now the fallback chain handles it explicitly.
    const url = `data:image/png,${toBase64(makePngBytes(300, 700))}`;
    await expect(readPngDimensions(url)).resolves.toEqual({
      width: 300,
      height: 700,
    });
  });

  it('decodes a long percent-encoded payload past the 32-char window', async () => {
    // Regression: the old 32-char window produced ~10 bytes for
    // percent-encoded payloads — fewer than the 24 needed to read IHDR.
    const bytes = new Uint8Array(4096);
    bytes.set(makePngBytes(1024, 2048), 0);
    const percent = Array.from(bytes)
      .map((b) => `%${b.toString(16).padStart(2, '0')}`)
      .join('');
    const url = `data:image/png,${percent}`;
    await expect(readPngDimensions(url)).resolves.toEqual({
      width: 1024,
      height: 2048,
    });
  });

  it('does not choke on a truncated percent escape at the window edge', async () => {
    const bytes = makePngBytes(16, 16);
    const percent = Array.from(bytes)
      .map((b) => `%${b.toString(16).padStart(2, '0')}`)
      .join('');
    // 120 chars of PNG + 135 filler = 255, so the 256-char window ends
    // exactly on a dangling "%" — the decoder must trim it rather than
    // throw URIError.
    const url = `data:image/png,${percent}${'x'.repeat(135)}%8${'y'.repeat(100)}`;
    await expect(readPngDimensions(url)).resolves.toMatchObject({ width: 16 });
  });

  it('rejects a data URL without a comma', async () => {
    await expect(readPngDimensions('data:image/png;base64')).rejects.toThrow(
      'invalid dataUrl',
    );
  });

  it('rejects a payload that is not a PNG', async () => {
    const url = `data:image/png;base64,${toBase64(new Uint8Array(40))}`;
    await expect(readPngDimensions(url)).rejects.toThrow('not a PNG');
  });
});
