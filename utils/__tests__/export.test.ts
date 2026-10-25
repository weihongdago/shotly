import { describe, expect, it } from 'vitest';
import {
  DEFAULT_JPEG_QUALITY,
  EXPORT_EXTENSION,
  EXPORT_MIME,
  buildExportFilename,
  isFormatSupported,
  pdfPageSizeFor,
  sanitizeFilename,
  type ExportFormat,
} from '../export';

// ─── constants ───────────────────────────────────────────────────────────────

describe('export constants', () => {
  it('maps every format to its MIME type', () => {
    expect(EXPORT_MIME).toEqual({
      png: 'image/png',
      jpg: 'image/jpeg',
      pdf: 'application/pdf',
    });
    expect(EXPORT_MIME).toStrictEqual({
      png: 'image/png',
      jpg: 'image/jpeg',
      pdf: 'application/pdf',
    });
    expect(Object.keys(EXPORT_MIME)).toEqual(['png', 'jpg', 'pdf']);
  });

  it('maps every format to its file extension', () => {
    expect(EXPORT_EXTENSION).toEqual({
      png: 'png',
      jpg: 'jpg',
      pdf: 'pdf',
    });
    expect(EXPORT_EXTENSION).toStrictEqual({
      png: 'png',
      jpg: 'jpg',
      pdf: 'pdf',
    });
    expect(Object.keys(EXPORT_EXTENSION)).toEqual(['png', 'jpg', 'pdf']);
  });

  it('uses 0.92 as the default JPEG quality', () => {
    expect(DEFAULT_JPEG_QUALITY).toBe(0.92);
  });
});

// ─── sanitizeFilename ────────────────────────────────────────────────────────

describe('sanitizeFilename', () => {
  it('keeps a clean title untouched', () => {
    expect(sanitizeFilename('Screenshot')).toBe('Screenshot');
  });

  it('collapses whitespace runs into a single underscore', () => {
    expect(sanitizeFilename('Hello   World')).toBe('Hello_World');
    expect(sanitizeFilename('a\t\nb')).toBe('a_b');
  });

  it('trims leading and trailing separators', () => {
    expect(sanitizeFilename('  padded  ')).toBe('padded');
    expect(sanitizeFilename('__edge__')).toBe('edge');
    expect(sanitizeFilename('...dots...')).toBe('dots');
  });

  it('replaces filesystem-hostile characters with a dash', () => {
    expect(sanitizeFilename('a<b>c:d"e|f?g*h')).toBe('a-b-c-d-e-f-g-h');
  });

  it('removes path separators so no directory can be escaped', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('etc-passwd');
    expect(sanitizeFilename('C:\\Users\\me')).toBe('C--Users-me');
    expect(sanitizeFilename('a/b')).toBe('a-b');
  });

  it('drops control characters', () => {
    expect(sanitizeFilename('a\u0000b')).toBe('ab');
    expect(sanitizeFilename('a\u001Fb')).toBe('ab');
    expect(sanitizeFilename('a\u007Fb')).toBe('ab');
  });

  it('falls back to "shotly" for empty input', () => {
    expect(sanitizeFilename('')).toBe('shotly');
    expect(sanitizeFilename('   ')).toBe('shotly');
    expect(sanitizeFilename('...')).toBe('shotly');
  });

  it('clips long titles to 80 characters', () => {
    const long = 'x'.repeat(200);
    expect(sanitizeFilename(long)).toHaveLength(80);
  });
});

// ─── buildExportFilename ─────────────────────────────────────────────────────

describe('buildExportFilename', () => {
  /** Independent re-implementation of the local timestamp format. */
  function expectedStamp(timestamp: number): string {
    const d = new Date(timestamp);
    const pad = (n: number) => String(n).padStart(2, '0');
    return [
      d.getFullYear(),
      pad(d.getMonth() + 1),
      pad(d.getDate()),
    ].join('') + `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  }

  it('builds shotly-<title>-<timestamp>.<ext>', () => {
    const timestamp = new Date(2026, 9, 25, 16, 13, 45).getTime();
    const name = buildExportFilename({ title: 'My Page', format: 'png', timestamp });
    expect(name).toBe(`shotly-My_Page-${expectedStamp(timestamp)}.png`);
  });

  it('falls back to "screenshot" for an empty title', () => {
    const timestamp = new Date(2026, 0, 2, 3, 4, 5).getTime();
    expect(buildExportFilename({ title: '', format: 'jpg', timestamp })).toBe(
      `shotly-screenshot-${expectedStamp(timestamp)}.jpg`,
    );
    expect(buildExportFilename({ title: '   ', format: 'pdf', timestamp })).toBe(
      `shotly-screenshot-${expectedStamp(timestamp)}.pdf`,
    );
  });

  it('uses the extension of the requested format', () => {
    const timestamp = Date.now();
    expect(buildExportFilename({ title: 'a', format: 'png', timestamp }).endsWith('.png')).toBe(true);
    expect(buildExportFilename({ title: 'a', format: 'jpg', timestamp }).endsWith('.jpg')).toBe(true);
    expect(buildExportFilename({ title: 'a', format: 'pdf', timestamp }).endsWith('.pdf')).toBe(true);
  });

  it('sanitizes the title before embedding it', () => {
    const name = buildExportFilename({ title: 'a/b:c', format: 'png', timestamp: 0 });
    expect(name).toMatch(/^shotly-a-b-c-\d{8}-\d{6}\.png$/);
    expect(name).not.toContain('/');
  });

  it('defaults the timestamp to now', () => {
    const before = Date.now();
    const name = buildExportFilename({ title: 'now', format: 'png' });
    const after = Date.now();
    const stamp = name.slice('shotly-now-'.length, -'.png'.length);
    const parsed = Date.parse(
      `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}`,
    );
    expect(parsed).toBeGreaterThanOrEqual(before - 1000);
    expect(parsed).toBeLessThanOrEqual(after + 1000);
  });
});

// ─── pdfPageSizeFor ──────────────────────────────────────────────────────────

describe('pdfPageSizeFor', () => {
  it('converts CSS pixels to PDF points (96 dpi)', () => {
    expect(pdfPageSizeFor({ widthPx: 1920, heightPx: 1080 })).toEqual({ width: 1440, height: 810 });
    expect(pdfPageSizeFor({ widthPx: 96, heightPx: 96 })).toEqual({ width: 72, height: 72 });
  });

  it('honours a custom dpi', () => {
    expect(pdfPageSizeFor({ widthPx: 1440, heightPx: 1080, dpi: 144 })).toEqual({
      width: 720,
      height: 540,
    });
  });

  it('rounds to whole points', () => {
    const size = pdfPageSizeFor({ widthPx: 100, heightPx: 100 });
    expect(Number.isInteger(size.width)).toBe(true);
    expect(Number.isInteger(size.height)).toBe(true);
  });

  it('never goes below one point', () => {
    expect(pdfPageSizeFor({ widthPx: 1, heightPx: 1 })).toEqual({ width: 1, height: 1 });
  });

  it('throws on non-positive or non-finite input', () => {
    expect(() => pdfPageSizeFor({ widthPx: 0, heightPx: 100 })).toThrow(/widthPx/);
    expect(() => pdfPageSizeFor({ widthPx: 100, heightPx: -1 })).toThrow(/heightPx/);
    expect(() => pdfPageSizeFor({ widthPx: Number.NaN, heightPx: 100 })).toThrow(/widthPx/);
    expect(() => pdfPageSizeFor({ widthPx: 100, heightPx: Number.POSITIVE_INFINITY })).toThrow(
      /heightPx/,
    );
    expect(() => pdfPageSizeFor({ widthPx: 100, heightPx: 100, dpi: 0 })).toThrow(/dpi/);
  });
});

// ─── isFormatSupported ───────────────────────────────────────────────────────

describe('isFormatSupported', () => {
  it('accepts the three supported formats, case-insensitively', () => {
    expect(isFormatSupported('png')).toBe(true);
    expect(isFormatSupported('PNG')).toBe(true);
    expect(isFormatSupported('Jpg')).toBe(true);
    expect(isFormatSupported('PDF')).toBe(true);
    expect(isFormatSupported(' pdf ')).toBe(true);
  });

  it('accepts the jpeg alias', () => {
    expect(isFormatSupported('jpeg')).toBe(true);
    expect(isFormatSupported('JPEG')).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isFormatSupported('gif')).toBe(false);
    expect(isFormatSupported('webp')).toBe(false);
    expect(isFormatSupported('')).toBe(false);
    expect(isFormatSupported('png ')).toBe(true);
    expect(isFormatSupported('image/png')).toBe(false);
  });

  it('narrows the type so the MIME map can be indexed', () => {
    const candidate: string = 'PDF';
    if (!isFormatSupported(candidate)) throw new Error('expected PDF to be supported');
    const narrowed: ExportFormat = candidate;
    expect(EXPORT_MIME[narrowed]).toBe('application/pdf');
    expect(EXPORT_EXTENSION[narrowed]).toBe('pdf');
  });

  it('resolves the MIME table case-insensitively (the guard is too)', () => {
    const mime = EXPORT_MIME as Record<string, string>;
    const extension = EXPORT_EXTENSION as Record<string, string>;
    expect(mime.PNG).toBe('image/png');
    expect(mime.JPEG).toBe('image/jpeg');
    expect(extension.PNG).toBe('png');
  });
});
