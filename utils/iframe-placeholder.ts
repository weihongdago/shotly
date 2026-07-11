/**
 * Iframe placeholder (architecture v1.2 §3.2)
 *
 * MV3 content scripts run in isolated world — they cannot reach cross-origin
 * iframe content. We replace each cross-origin iframe with a placeholder div
 * so the stitched screenshot stays readable (user sees "there was an embed").
 *
 * Placeholder spec (v1.2):
 *   text:     "📎 {hostname} (embedded)"
 *   style:    light bg #F4F4F5 + 1px border + 12px radius + mint left bar #2DD4BF
 *   restore:  original iframe elements are preserved, restored after capture
 */

export interface PlaceholderRecord {
  iframe: HTMLIFrameElement;
  parent: Node;
  nextSibling: Node | null;
  placeholder: HTMLElement;
  originalDisplay: string;
}

/**
 * Walk the document, find cross-origin iframes, swap them with placeholders.
 * Returns a list of records so the caller can restore after capture.
 *
 * Note: same-origin iframes are still kept (B-plan in v1.1 may recurse).
 */
export function installIframePlaceholders(): PlaceholderRecord[] {
  const records: PlaceholderRecord[] = [];
  const iframes = document.querySelectorAll('iframe');

  for (const iframe of Array.from(iframes)) {
    try {
      // Same-origin → leave alone (we can recurse later in v1.1)
      // Note: accessing iframe.contentDocument throws on cross-origin
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      iframe.contentDocument;
      continue;
    } catch {
      // Cross-origin — fall through to placeholder
    }

    const src = iframe.src || '';
    let hostname = 'unknown';
    try {
      hostname = new URL(src, location.href).hostname || 'inline-frame';
    } catch {
      hostname = 'inline-frame';
    }

    const rect = iframe.getBoundingClientRect();
    const placeholder = document.createElement('div');
    placeholder.className = 'shotly-iframe-placeholder';
    placeholder.dataset.shotlyPlaceholder = 'true';
    placeholder.style.cssText = [
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'flex-direction:column',
      'gap:6px',
      'width:' + Math.max(rect.width, 120) + 'px',
      'height:' + Math.max(rect.height, 60) + 'px',
      'min-height:60px',
      'background:#F4F4F5',
      'border:1px solid #E4E4E7',
      'border-left:4px solid #2DD4BF',
      'border-radius:12px',
      'color:#52525B',
      'font:13px/1.4 system-ui,-apple-system,sans-serif',
      'box-sizing:border-box',
      'padding:12px',
      'text-align:center',
      'word-break:break-all',
    ].join(';');
    placeholder.innerHTML =
      `<div style="font-size:18px">📎</div>` +
      `<div><strong>${escapeHtml(hostname)}</strong> <span style="color:#71717A">(embedded)</span></div>`;

    const parent = iframe.parentNode;
    if (!parent) continue;
    const nextSibling = iframe.nextSibling;
    parent.replaceChild(placeholder, iframe);

    records.push({
      iframe,
      parent,
      nextSibling,
      placeholder,
      originalDisplay: iframe.style.display,
    });
  }

  return records;
}

/** Restore all iframes from the records returned by `installIframePlaceholders`. */
export function restoreIframes(records: PlaceholderRecord[]): void {
  for (const r of records) {
    if (r.placeholder.parentNode === r.parent) {
      r.parent.replaceChild(r.iframe, r.placeholder);
    }
    r.iframe.style.display = r.originalDisplay;
  }
}

/** Count how many cross-origin iframes exist (for telemetry, not UI). */
export function countCrossOriginIframes(): number {
  let n = 0;
  for (const iframe of Array.from(document.querySelectorAll('iframe'))) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      iframe.contentDocument;
    } catch {
      n++;
    }
  }
  return n;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    })[c]!,
  );
}