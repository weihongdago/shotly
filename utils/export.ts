/**
 * Export helpers (architecture v1.2 §7 — capture / export pipeline)
 *
 * Pure functions only: MIME lookup, file naming and PDF page geometry.
 * Keeping them side-effect free makes them trivially unit-testable and
 * reusable from the popup, the background worker and the editor page.
 *
 * Privacy note: filenames are built from the *page title* only — never from
 * the URL — so no personal path leaks into the user's downloads folder.
 */

export type ExportFormat = 'png' | 'jpg' | 'pdf';

export const EXPORT_MIME: Record<ExportFormat, string> = caseInsensitiveTable({
  png: 'image/png',
  jpg: 'image/jpeg',
  pdf: 'application/pdf',
});

export const EXPORT_EXTENSION: Record<ExportFormat, string> = caseInsensitiveTable({
  png: 'png',
  jpg: 'jpg',
  pdf: 'pdf',
});

/** JPEG quality used by the canvas encoder (0..1) — visually lossless-ish. */
export const DEFAULT_JPEG_QUALITY = 0.92;

/** Characters that are illegal (or merely painful) in a file name. */
const UNFRIENDLY_CHARS = /[<>:"/\\|?*]/g;

/** Control characters — meaningless in a file name, dropped outright. */
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;

/** Longest file name we ever produce (keeps Windows' 255 byte limit safe). */
const MAX_FILENAME_LENGTH = 80;

/** Fallback used when a title sanitizes down to nothing. */
const FALLBACK_NAME = 'shotly';

/**
 * Turn arbitrary page titles into a safe file name fragment.
 *
 * Removes path separators and control characters, replaces the characters
 * Windows forbids, collapses whitespace runs into a single `_` and trims the
 * noisy edges. An empty result falls back to `shotly`.
 */
export function sanitizeFilename(input: string): string {
  const cleaned = input
    // any run of whitespace (spaces, tabs, newlines) becomes a single underscore
    .replace(/\s+/g, '_')
    // control characters carry no meaning for a file name — drop them outright
    .replace(CONTROL_CHARS, '')
    // characters that are illegal on Windows/macOS filesystems become '-'
    .replace(UNFRIENDLY_CHARS, '-')
    .replace(/^[_.-]+/, '')
    .replace(/[_.-]+$/, '');

  const clipped = cleaned.slice(0, MAX_FILENAME_LENGTH);
  return clipped.length > 0 ? clipped : FALLBACK_NAME;
}

/**
 * Build the final download name: `shotly-<title>-<yyyyMMdd-HHmmss>.<ext>`.
 *
 * The timestamp is local time on purpose — users recognise "what did I shoot
 * this morning" far better than a UTC stamp.
 */
export function buildExportFilename(input: {
  title: string;
  format: ExportFormat;
  timestamp?: number;
}): string {
  const rawTitle = input.title.trim().length > 0 ? input.title : 'screenshot';
  const title = sanitizeFilename(rawTitle);
  const stamp = formatTimestamp(input.timestamp ?? Date.now());
  return `shotly-${title}-${stamp}.${EXPORT_EXTENSION[input.format]}`;
}

/**
 * PDF page size for a screenshot, in PDF points (1/72 inch).
 *
 * pdf-lib measures pages in points while screenshots are measured in CSS
 * pixels (1/96 inch by default), so the pixel size has to be converted.
 */
export function pdfPageSizeFor(input: {
  widthPx: number;
  heightPx: number;
  dpi?: number;
}): { width: number; height: number } {
  const dpi = input.dpi ?? 96;
  assertPositive(input.widthPx, 'widthPx');
  assertPositive(input.heightPx, 'heightPx');
  assertPositive(dpi, 'dpi');

  return {
    width: pxToPoints(input.widthPx, dpi),
    height: pxToPoints(input.heightPx, dpi),
  };
}

/**
 * Type guard for the supported export formats.
 *
 * Case-insensitive and tolerant of the `jpeg` alias — the MIME / extension
 * tables resolve `JPEG` to the `jpg` entry as well.
 */
export function isFormatSupported(format: string): format is ExportFormat {
  const normalized = format.trim().toLowerCase();
  if (normalized === 'jpeg') return true;
  return normalized === 'png' || normalized === 'jpg' || normalized === 'pdf';
}

/** Pixels → PDF points, rounded, never smaller than a 1pt page. */
function pxToPoints(px: number, dpi: number): number {
  const points = Math.round((px * 72) / dpi);
  return Math.max(1, points);
}

/** `yyyyMMdd-HHmmss` in local time. */
function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const yyyy = String(date.getFullYear()).padStart(4, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
}

/** Guard for the PDF geometry — bad input would produce a broken document. */
function assertPositive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`[shotly:export] invalid ${name}: ${String(value)}`);
  }
}

/**
 * Case-insensitive view over the MIME / extension tables.
 *
 * `isFormatSupported` accepts 'PNG' and 'JPEG', so the lookup tables have to
 * behave the same way — otherwise `EXPORT_MIME[format]` would be `undefined`
 * for a perfectly valid (if shouty) format string.
 */
function caseInsensitiveTable<T extends Record<string, string>>(table: T): T {
  return new Proxy(table, {
    get(target, prop, receiver): unknown {
      if (typeof prop !== 'string') return Reflect.get(target, prop, receiver);
      // Own *and* inherited properties (`constructor`, `toString`, …) must be
      // passed through untouched — only the format keys are remapped.
      const direct = Reflect.get(target, prop, receiver);
      if (direct !== undefined) return direct;
      const wanted = prop.toLowerCase() === 'jpeg' ? 'jpg' : prop.toLowerCase();
      const found = Object.keys(target).find((key) => key.toLowerCase() === wanted);
      return found ? Reflect.get(target, found, receiver) : undefined;
    },
  });
}
