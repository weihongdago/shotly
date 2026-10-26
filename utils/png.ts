/**
 * PNG header parsing helpers.
 *
 * Extracted from `entrypoints/background.ts` so the base64-vs-percent
 * decoding decision is unit-testable — that decision was the source of a
 * real bug (see `utils/__tests__/png.test.ts`).
 */

/** PNG signature: 89 50 4E 47 0D 0A 1A 0A */
export function isPngHeader(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  );
}

function decodeBase64Bytes(payload: string): Uint8Array {
  return Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
}

/**
 * Decode a percent-encoded payload **into bytes**.
 *
 * ⚠️ Must NOT go through `decodeURIComponent` + `TextEncoder`. That path
 * decodes to a JS string first, and any byte >= 0x80 becomes a lone
 * surrogate-ish code point that `TextEncoder` then re-encodes as two
 * UTF-8 bytes — e.g. PNG byte 0x89 becomes `0xC2 0x89`. The PNG
 * signature check then fails and every percent-encoded data URL is
 * rejected with `not a PNG`.
 */
function decodePercentBytes(payload: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < payload.length; i += 1) {
    const ch = payload[i];
    if (ch === '%' && i + 2 < payload.length) {
      const byte = Number.parseInt(payload.slice(i + 1, i + 3), 16);
      if (!Number.isNaN(byte)) {
        out.push(byte & 0xff);
        i += 2;
        continue;
      }
    }
    // Not an escape — take the UTF-8 bytes of the literal character.
    for (const b of new TextEncoder().encode(ch)) out.push(b);
  }
  return Uint8Array.from(out);
}

/**
 * Read PNG IHDR for width/height without decoding the full image.
 *
 * Works for `data:image/png;base64,...` and `data:image/png,...`
 * (percent-encoded binary).
 *
 * Two things this gets right that a naive version does not:
 *
 * 1. **The encoding is decided by the `;base64` marker**, not by sniffing
 *    the first payload character. The old heuristic used `/^[!-/]/` to
 *    spot percent-encoded text. That range covers `+` (0x2B) and `/`
 *    (0x2F), which are valid base64 characters. In practice a PNG's base64
 *    always begins `iVBORw0KGgo` (the signature is fixed) so the guess
 *    happened to work — but it was correct by coincidence, not by design.
 *
 * 2. **The decode window is sized per encoding.** A PNG header needs 24
 *    bytes. Base64 encodes 3 bytes into 4 chars, so 32 chars is exactly
 *    enough. Percent-encoding uses 3 chars per byte, so 32 chars only
 *    yields ~10 bytes — the old code sliced 32 chars for BOTH encodings,
 *    which made every percent-encoded PNG data URL fail with
 *    `not a PNG`. The window is now generous for both.
 */
export async function readPngDimensions(
  dataUrl: string,
): Promise<{ width: number; height: number }> {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) throw new Error('invalid dataUrl');
  const meta = dataUrl.slice(0, comma);
  const raw = dataUrl.slice(comma + 1);

  const isBase64 = /;base64/i.test(meta);
  const decodeCandidates = isBase64
    ? [() => decodeBase64Bytes(takeBase64Window(raw, 256))]
    : [
        () => decodePercentBytes(takePercentWindow(raw, 256)),
        () => decodeBase64Bytes(takeBase64Window(raw, 256)),
      ];

  let bytes: Uint8Array | null = null;
  for (const decode of decodeCandidates) {
    try {
      const candidate = decode();
      if (isPngHeader(candidate)) {
        bytes = candidate;
        break;
      }
    } catch {
      // try the next strategy
    }
  }
  if (!bytes) throw new Error('not a PNG');

  // PNG signature 8B + IHDR length 4B + 'IHDR' 4B = 16B before width/height
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  return { width, height };
}

/**
 * Decode window for base64 payloads: keep the length a multiple of 4 so
 * we never split a base64 quantum (`atob` throws otherwise).
 */
function takeBase64Window(raw: string, max: number): string {
  if (raw.length <= max) return raw;
  const end = max - (max % 4);
  return raw.slice(0, end);
}

/**
 * Decode window for percent-encoded payloads: never cut a `%XX` escape in
 * half (`decodeURIComponent` throws on a dangling `%`).
 */
function takePercentWindow(raw: string, max: number): string {
  if (raw.length <= max) return raw;
  let end = max;
  const tail = raw.slice(Math.max(0, end - 3), end);
  const pct = tail.lastIndexOf('%');
  if (pct >= 0 && tail.length - pct < 3) {
    end -= 3 - (tail.length - pct);
  }
  return raw.slice(0, end);
}
