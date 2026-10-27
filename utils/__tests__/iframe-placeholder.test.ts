import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  countCrossOriginIframes,
  installIframePlaceholders,
  isCrossOriginIframe,
  restoreIframes,
  type PlaceholderRecord,
} from '../iframe-placeholder';

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * The page origin every test pretends to live on.
 *
 * Detection is URL-based (see `isCrossOriginIframe`), so the tests must
 * use URLs relative to THIS origin — otherwise "same-origin" and
 * "cross-origin" would depend on the test runner's own location.
 */
const PAGE_ORIGIN = 'https://example.com';

function makeIframe(src: string, isCrossOrigin = true): HTMLIFrameElement {
  const iframe = document.createElement('iframe');
  iframe.src = src;
  Object.defineProperty(iframe, 'contentDocument', {
    get() {
      if (isCrossOrigin) throw new DOMException('cross-origin', 'SecurityError');
      return {} as Document;
    },
    configurable: true,
  });
  Object.defineProperty(iframe, 'getBoundingClientRect', {
    value: () => ({ width: 400, height: 300, top: 0, left: 0, right: 400, bottom: 300, x: 0, y: 0, toJSON: () => {} }),
    configurable: true,
  });
  return iframe;
}

/** Same-origin iframe (relative URL, inherits the page origin). */
function makeSameOriginIframe(src = '/child.html'): HTMLIFrameElement {
  return makeIframe(src, false);
}

function clearBody() {
  document.body.innerHTML = '';
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe('iframe-placeholder (architecture §3.2)', () => {
  beforeEach(() => {
    clearBody();
    Object.defineProperty(window, 'location', {
      value: { href: `${PAGE_ORIGIN}/` },
      writable: true,
      configurable: true,
    });
  });

  afterEach(clearBody);

  it('returns empty array when no iframes', () => {
    expect(installIframePlaceholders()).toEqual([]);
  });

  it('leaves same-origin iframes alone', () => {
    const iframe = makeSameOriginIframe();
    document.body.append(iframe);
    expect(installIframePlaceholders()).toEqual([]);
    expect(iframe.parentNode).toBe(document.body);
  });

  it('replaces cross-origin iframe with placeholder', () => {
    const iframe = makeIframe('https://youtube.com/embed/abc', true);
    document.body.append(iframe);
    const records = installIframePlaceholders();
    expect(records).toHaveLength(1);
    const rec = records[0];
    expect(rec.iframe).toBe(iframe);
    expect(rec.placeholder.classList.contains('shotly-iframe-placeholder')).toBe(true);
    expect(rec.placeholder.getAttribute('data-shotly-placeholder')).toBe('true');
    expect(rec.placeholder.parentNode).toBe(document.body);
    expect(iframe.parentNode).toBeNull();
  });

  it('placeholder has 4px mint left border (#2DD4BF)', () => {
    const iframe = makeIframe('https://youtube.com/embed/xyz', true);
    document.body.append(iframe);
    const [rec] = installIframePlaceholders();
    expect(rec.placeholder.style.borderLeft).toContain('4px');
    expect(rec.placeholder.style.borderLeft).toContain('#2DD4BF');
  });

  it('placeholder shows hostname in text', () => {
    const iframe = makeIframe('https://vimeo.com/video/1', true);
    document.body.append(iframe);
    const [rec] = installIframePlaceholders();
    expect(rec.placeholder.innerHTML).toContain('vimeo.com');
    expect(rec.placeholder.innerHTML).toContain('📎');
    expect(rec.placeholder.innerHTML).toContain('(embedded)');
  });

  it('hostname is URL-parsed (query strings do not leak into display)', () => {
    // Hostnames cannot contain <, >, ", ' — URL parser strips them.
    // Verify a query with bad chars does NOT pollute the displayed hostname.
    const iframe = makeIframe('https://malicious.evil.com/embed?id=<bad>"\'x', true);
    document.body.append(iframe);
    const [rec] = installIframePlaceholders();
    expect(rec.placeholder.innerHTML).toContain('malicious.evil.com');
    // No raw angle brackets or quotes in the rendered HTML
    expect(rec.placeholder.innerHTML).not.toContain('<bad>');
    expect(rec.placeholder.innerHTML).not.toContain('"<');
  });

  it('an iframe without src is same-origin and left alone', () => {
    // `<iframe>` with no src loads about:blank, which inherits the page
    // origin — so it is NOT an embed from another site and must not get a
    // placeholder.
    const iframe = makeIframe('', true);
    document.body.append(iframe);
    expect(installIframePlaceholders()).toEqual([]);
    expect(iframe.parentNode).toBe(document.body);
  });

  it('placeholder has min dimensions (width>=120, height>=60)', () => {
    const iframe = makeIframe('https://youtube.com/embed/1', true);
    Object.defineProperty(iframe, 'getBoundingClientRect', {
      value: () => ({ width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10, x: 0, y: 0, toJSON: () => {} }),
      configurable: true,
    });
    document.body.append(iframe);
    const [rec] = installIframePlaceholders();
    expect(rec.placeholder.style.width).toContain('120px');
    expect(rec.placeholder.style.height).toContain('60px');
  });

  it('restoreIframes puts iframe back at original position', () => {
    const iframe = makeIframe('https://youtube.com/embed/abc', true);
    document.body.append(iframe);
    const records = installIframePlaceholders();
    expect(iframe.parentNode).toBeNull();
    restoreIframes(records);
    expect(iframe.parentNode).toBe(document.body);
  });

  it('restoreIframes restores inline display style', () => {
    const iframe = makeIframe('https://youtube.com/embed/abc', true);
    iframe.style.display = 'block';
    document.body.append(iframe);
    const records = installIframePlaceholders();
    restoreIframes(records);
    expect(iframe.style.display).toBe('block');
  });

  it('restoreIframes is idempotent (second call is no-op)', () => {
    const iframe = makeIframe('https://youtube.com/embed/abc', true);
    document.body.append(iframe);
    const records = installIframePlaceholders();
    restoreIframes(records);
    expect(() => restoreIframes(records)).not.toThrow();
  });

  it('handles multiple cross-origin iframes', () => {
    const a = makeIframe('https://youtube.com/embed/1', true);
    const b = makeIframe('https://vimeo.com/video/2', true);
    document.body.append(a, b);
    const records = installIframePlaceholders();
    expect(records).toHaveLength(2);
    expect(a.parentNode).toBeNull();
    expect(b.parentNode).toBeNull();
  });

  it('mixed same-origin + cross-origin → only cross replaced', () => {
    const same = makeSameOriginIframe();
    const cross = makeIframe('https://youtube.com/embed/abc', true);
    document.body.append(same, cross);
    const records = installIframePlaceholders();
    expect(records).toHaveLength(1);
    expect(records[0].iframe).toBe(cross);
    expect(same.parentNode).toBe(document.body);
    expect(cross.parentNode).toBeNull();
  });

  it('preserves nextSibling for accurate restoration', () => {
    clearBody();
    const iframe = makeIframe('https://youtube.com/embed/1', true);
    const tail = document.createElement('div');
    document.body.append(iframe, tail);
    const records = installIframePlaceholders();
    expect(records[0].nextSibling).toBe(tail);
    restoreIframes(records);
    // After restore, tail should still come right after iframe
    expect(iframe.nextSibling).toBe(tail);
  });
});

describe('countCrossOriginIframes (architecture §3.2 telemetry)', () => {
  beforeEach(() => {
    clearBody();
    Object.defineProperty(window, 'location', {
      value: { href: `${PAGE_ORIGIN}/` },
      writable: true,
      configurable: true,
    });
  });
  afterEach(() => clearBody);

  it('returns 0 when no iframes', () => {
    expect(countCrossOriginIframes()).toBe(0);
  });

  it('counts only cross-origin', () => {
    document.body.append(
      makeSameOriginIframe(),
      makeIframe('https://youtube.com/embed/1', true),
      makeIframe('https://vimeo.com/video/2', true),
    );
    expect(countCrossOriginIframes()).toBe(2);
  });

  it('does not modify DOM (read-only)', () => {
    document.body.append(makeIframe('https://youtube.com/embed/1', true));
    const before = document.body.innerHTML;
    countCrossOriginIframes();
    expect(document.body.innerHTML).toBe(before);
  });
});

describe('PlaceholderRecord shape', () => {
  it('exposes iframe, parent, nextSibling, placeholder, originalDisplay', () => {
    clearBody();
    const iframe = makeIframe('https://youtube.com/embed/1', true);
    const tail = document.createElement('div');
    document.body.append(iframe, tail);
    const records: PlaceholderRecord[] = installIframePlaceholders();
    expect(records).toHaveLength(1);
    const rec = records[0];
    expect(rec.iframe).toBe(iframe);
    expect(rec.parent).toBe(document.body);
    expect(rec.nextSibling).toBe(tail);
    expect(rec.placeholder).toBeInstanceOf(HTMLElement);
    expect(typeof rec.originalDisplay).toBe('string');
  });
});

// ─── The detection race (regression) ─────────────────────────────────────────

describe('isCrossOriginIframe — URL-based detection (not contentDocument)', () => {
  beforeEach(() => {
    clearBody();
    Object.defineProperty(window, 'location', {
      value: { href: `${PAGE_ORIGIN}/` },
      writable: true,
      configurable: true,
    });
  });
  afterEach(clearBody);

  it('still detects a cross-origin iframe that has NOT loaded yet', () => {
    // ⚠️ This is the regression. The old implementation asked
    // `iframe.contentDocument` and caught the SecurityError. A cross-origin
    // iframe that has not finished loading still exposes its initial
    // about:blank document — the access SUCCEEDS, so the old code treated
    // it as same-origin and left it alone. The embed then showed up as a
    // blank hole in the stitched screenshot, with zero errors anywhere.
    // On a slow connection (when a screenshot matters most) this was
    // guaranteed.
    const iframe = document.createElement('iframe');
    iframe.src = 'https://slow.example.org/embed';
    Object.defineProperty(iframe, 'contentDocument', {
      get() {
        // Pretend the frame has not navigated yet → about:blank, readable.
        return {} as Document;
      },
      configurable: true,
    });
    document.body.append(iframe);

    expect(isCrossOriginIframe(iframe)).toBe(true);
    const records = installIframePlaceholders();
    expect(records).toHaveLength(1);
    expect(iframe.parentNode).toBeNull();
  });

  it('treats an about:blank iframe as same-origin', () => {
    const iframe = document.createElement('iframe');
    iframe.src = 'about:blank';
    document.body.append(iframe);
    expect(isCrossOriginIframe(iframe)).toBe(false);
  });

  it('treats a srcdoc iframe as same-origin', () => {
    const iframe = document.createElement('iframe');
    iframe.setAttribute('srcdoc', '<p>hello</p>');
    document.body.append(iframe);
    expect(isCrossOriginIframe(iframe)).toBe(false);
  });

  it('treats a relative URL as same-origin', () => {
    const iframe = document.createElement('iframe');
    iframe.src = 'child.html';
    document.body.append(iframe);
    expect(isCrossOriginIframe(iframe)).toBe(false);
  });

  it('treats a different port on the same host as cross-origin', () => {
    const iframe = document.createElement('iframe');
    iframe.src = `${PAGE_ORIGIN}:8443/embed`;
    document.body.append(iframe);
    expect(isCrossOriginIframe(iframe)).toBe(true);
  });

  it('treats http vs https on the same host as cross-origin', () => {
    const iframe = document.createElement('iframe');
    iframe.src = 'http://example.com/embed';
    document.body.append(iframe);
    expect(isCrossOriginIframe(iframe)).toBe(true);
  });
});

void vi;
