/**
 * report/v1 static renderer — maps a `ReportDocument` (see `blocks.ts`) to a
 * single self-contained HTML page. Vendored and deterministic: inline CSS, no
 * network references, every text node HTML-escaped, output byte-stable for a
 * given document (so it can be snapshot-tested). This is the one renderer every
 * HTML surface in the plugin compiles through — producers emit blocks, never
 * markup.
 */

import type { Block, ReportDocument, Tone } from './blocks';

/** Render a report document to a complete, self-contained HTML page. */
export function renderReportDocument(doc: ReportDocument): string {
  const body = doc.blocks.map(renderBlock).join('\n');
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(doc.title)}</title>`,
    `<style>${STYLE}</style>`,
    '</head>',
    '<body>',
    '<main class="report">',
    `<h1 class="report-title">${escapeHtml(doc.title)}</h1>`,
    body,
    '</main>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/** Render one block to an HTML fragment. `section` recurses. */
function renderBlock(block: Block): string {
  switch (block.type) {
    case 'heading':
      return `<h${block.level + 1}>${escapeHtml(block.text)}</h${block.level + 1}>`;
    case 'paragraph':
      return `<p>${escapeHtml(block.text)}</p>`;
    case 'list': {
      const tag = block.ordered ? 'ol' : 'ul';
      const items = block.items.map((i) => `  <li>${escapeHtml(i)}</li>`).join('\n');
      return `<${tag}>\n${items}\n</${tag}>`;
    }
    case 'table': {
      const head = block.columns.map((c) => `<th>${escapeHtml(c)}</th>`).join('');
      const rows = block.rows
        .map((row) => `  <tr>${row.map((c) => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`)
        .join('\n');
      return `<table>\n  <thead><tr>${head}</tr></thead>\n  <tbody>\n${rows}\n  </tbody>\n</table>`;
    }
    case 'badge':
      return `<span class="badge badge-${toneClass(block.tone)}">${escapeHtml(block.label)}</span>`;
    case 'keyValue': {
      const rows = block.items
        .map(
          (p) =>
            `  <div class="kv-row"><dt>${escapeHtml(p.key)}</dt><dd>${escapeHtml(p.value)}</dd></div>`,
        )
        .join('\n');
      return `<dl class="kv">\n${rows}\n</dl>`;
    }
    case 'callout': {
      const title = block.title
        ? `<div class="callout-title">${escapeHtml(block.title)}</div>`
        : '';
      return `<div class="callout callout-${toneClass(block.tone)}">${title}<div class="callout-body">${escapeHtml(block.body)}</div></div>`;
    }
    case 'section': {
      const title = block.title ? `<h2 class="section-title">${escapeHtml(block.title)}</h2>` : '';
      const inner = block.blocks.map(renderBlock).join('\n');
      return `<section class="block-section">${title}\n${inner}\n</section>`;
    }
    case 'divider':
      return '<hr>';
  }
}

/** Map a tone to its CSS class suffix (closed — mirrors the `Tone` enum). */
function toneClass(tone: Tone): string {
  return tone;
}

/** HTML-escape a text node. Order matters: `&` first. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Vendored stylesheet — system font, centered max-width column, tone palette for
 * badges and callouts. Inlined so the output file needs no network or sidecar.
 */
const STYLE = [
  ':root{--fg:#1a1a1a;--muted:#666;--border:#e2e2e2;--bg:#fff}',
  '*{box-sizing:border-box}',
  'body{margin:0;background:#fafafa;color:var(--fg);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}',
  '.report{max-width:860px;margin:0 auto;padding:2rem 1.5rem;background:var(--bg);min-height:100vh}',
  '.report-title{font-size:1.6rem;margin:0 0 1.25rem;padding-bottom:.5rem;border-bottom:2px solid var(--border)}',
  'h2,h3,h4{line-height:1.3;margin:1.5rem 0 .5rem}',
  '.section-title{font-size:1.15rem;border-bottom:1px solid var(--border);padding-bottom:.25rem}',
  '.block-section{margin:1.25rem 0}',
  'p{margin:.5rem 0}',
  'ul,ol{margin:.5rem 0;padding-left:1.5rem}',
  'li{margin:.2rem 0}',
  'table{border-collapse:collapse;width:100%;margin:.75rem 0;font-size:.92rem}',
  'th,td{border:1px solid var(--border);padding:.4rem .6rem;text-align:left;vertical-align:top}',
  'th{background:#f4f4f4;font-weight:600}',
  'hr{border:0;border-top:1px solid var(--border);margin:1.5rem 0}',
  '.kv{margin:.75rem 0;display:grid;gap:.25rem}',
  '.kv-row{display:flex;gap:.75rem}',
  '.kv dt{font-weight:600;min-width:11rem;color:var(--muted)}',
  '.kv dd{margin:0}',
  '.badge{display:inline-block;padding:.1rem .55rem;border-radius:999px;font-size:.8rem;font-weight:600;line-height:1.5}',
  '.callout{margin:.75rem 0;padding:.75rem 1rem;border-left:4px solid;border-radius:4px}',
  '.callout-title{font-weight:700;margin-bottom:.25rem}',
  '.callout-body{white-space:pre-wrap}',
  '.badge-neutral{background:#ececec;color:#444}',
  '.callout-neutral{border-color:#bdbdbd;background:#f5f5f5}',
  '.badge-info{background:#dbeafe;color:#1e40af}',
  '.callout-info{border-color:#3b82f6;background:#eff6ff}',
  '.badge-success{background:#dcfce7;color:#166534}',
  '.callout-success{border-color:#22c55e;background:#f0fdf4}',
  '.badge-warn{background:#fef3c7;color:#92400e}',
  '.callout-warn{border-color:#f59e0b;background:#fffbeb}',
  '.badge-danger{background:#fee2e2;color:#991b1b}',
  '.callout-danger{border-color:#ef4444;background:#fef2f2}',
].join('');
