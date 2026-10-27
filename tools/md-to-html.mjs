/**
 * A tiny Markdown → HTML converter.
 *
 * Why not a dependency: the public site has exactly ONE document to render
 * (PRIVACY.md), and pulling a markdown library into the extension's
 * dependency tree for that would be silly — the extension must stay small
 * and dependency-light, and the build must work offline.
 *
 * Supported subset (enough for PRIVACY.md):
 *   - ATX headings (# … ######)
 *   - paragraphs
 *   - **bold**, *italic*, `inline code`, [links](url)
 *   - unordered lists (- ) and ordered lists (1. )
 *   - tables (| a | b | with a | --- | --- | separator row)
 *   - horizontal rules (---)
 *   - blockquotes (> )
 *
 * Everything else is passed through as plain text. That is deliberate:
 * a half-rendered document is better than a silently mangled one, and the
 * output is checked by eye after every build.
 */

const ESCAPE = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ESCAPE[c]);
}

/** Inline formatting. Input is already HTML-escaped. */
function inline(text) {
  return text
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
}

function isTableSeparator(line) {
  return line.includes('-') && /^\s*\|?[\s:-]*-[\s|:-]*\|?\s*$/.test(line);
}

function splitRow(line) {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((c) => c.trim());
}

export function markdownToHtml(md) {
  const lines = md.split(/\r?\n/);
  const out = [];
  let i = 0;

  const flushParagraph = (buf) => {
    if (buf.length === 0) return;
    out.push(`<p>${inline(escapeHtml(buf.join(' ')))}</p>`);
    buf.length = 0;
  };

  const para = [];

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === '') {
      flushParagraph(para);
      i++;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line.trim())) {
      flushParagraph(para);
      out.push('<hr />');
      i++;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph(para);
      const level = heading[1].length;
      const text = inline(escapeHtml(heading[2].trim()));
      out.push(`<h${level}>${text}</h${level}>`);
      i++;
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      flushParagraph(para);
      const header = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        rows.push(splitRow(lines[i]));
        i++;
      }
      const th = header.map((c) => `<th>${inline(escapeHtml(c))}</th>`).join('');
      const body = rows
        .map((r) => `<tr>${r.map((c) => `<td>${inline(escapeHtml(c))}</td>`).join('')}</tr>`)
        .join('\n');
      out.push(`<table>\n<thead><tr>${th}</tr></thead>\n<tbody>\n${body}\n</tbody>\n</table>`);
      continue;
    }

    if (/^>\s?/.test(line)) {
      flushParagraph(para);
      const quote = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${inline(escapeHtml(quote.join(' ')))}</blockquote>`);
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/;
    const ordered = /^\s*\d+[.)]\s+(.*)$/;
    if (bullet.test(line) || ordered.test(line)) {
      flushParagraph(para);
      const isOrdered = ordered.test(line);
      const re = isOrdered ? ordered : bullet;
      const items = [];
      while (i < lines.length && re.test(lines[i])) {
        items.push(re.exec(lines[i])[1]);
        i++;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const lis = items.map((it) => `<li>${inline(escapeHtml(it))}</li>`).join('\n');
      out.push(`<${tag}>\n${lis}\n</${tag}>`);
      continue;
    }

    para.push(line.trim());
    i++;
  }

  flushParagraph(para);
  return out.join('\n');
}

/** Wrap rendered HTML in a minimal, self-contained document. */
export function page({ title, description, body, lang = 'en' }) {
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}" />
<link rel="stylesheet" href="./styles.css" />
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
}
