/**
 * report/v1 static renderer — maps a `ReportDocument` (see `blocks.ts`) to a
 * single self-contained HTML page. Vendored and deterministic: inline CSS, no
 * network references, every text node HTML-escaped, output byte-stable for a
 * given document (so it can be snapshot-tested). This is the one renderer every
 * HTML surface in the plugin compiles through — producers emit blocks, never
 * markup.
 *
 * Design language: "galley proof" — a print-grade editorial document, not a
 * dashboard. Warm paper ground, ink text, a single rust accent, hairline rules,
 * square corners. System serif stacks (Charter/Sitka body, Iowan/Palatino
 * display) and a monospace micro-label voice for table heads, key-value keys,
 * badges, and callout titles. Tables render as open ledgers (rules, not grids).
 * All interaction is CSS-only: staggered load reveal (guarded by
 * prefers-reduced-motion), automatic dark scheme via prefers-color-scheme, and
 * a print stylesheet. Zero JavaScript, zero web fonts — the self-contained
 * contract above is non-negotiable.
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
    '<header class="report-masthead">',
    `<h1 class="report-title">${escapeHtml(doc.title)}</h1>`,
    '</header>',
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
      return `<p>${renderInline(block.text)}</p>`;
    case 'list': {
      const tag = block.ordered ? 'ol' : 'ul';
      const items = block.items.map((i) => `  <li>${renderInline(i)}</li>`).join('\n');
      return `<${tag}>\n${items}\n</${tag}>`;
    }
    case 'table': {
      const head = block.columns.map((c) => `<th>${escapeHtml(c)}</th>`).join('');
      const rows = block.rows
        .map((row) => `  <tr>${row.map((c) => `<td>${renderInline(c)}</td>`).join('')}</tr>`)
        .join('\n');
      // figure wrapper gives wide tables horizontal overflow instead of breaking the column
      return `<figure class="table-wrap">\n<table>\n  <thead><tr>${head}</tr></thead>\n  <tbody>\n${rows}\n  </tbody>\n</table>\n</figure>`;
    }
    case 'badge':
      return `<span class="badge badge-${toneClass(block.tone)}">${escapeHtml(block.label)}</span>`;
    case 'keyValue': {
      const rows = block.items
        .map(
          (p) =>
            `  <div class="kv-row"><dt>${escapeHtml(p.key)}</dt><dd>${renderInline(p.value)}</dd></div>`,
        )
        .join('\n');
      return `<dl class="kv">\n${rows}\n</dl>`;
    }
    case 'callout': {
      const title = block.title
        ? `<div class="callout-title">${escapeHtml(block.title)}</div>`
        : '';
      return `<div class="callout callout-${toneClass(block.tone)}">${title}<div class="callout-body">${renderInline(block.body)}</div></div>`;
    }
    case 'code': {
      const label = block.label
        ? `<figcaption class="code-label">${escapeHtml(block.label)}</figcaption>\n`
        : '';
      return `<figure class="code-block">\n${label}<pre><code>${escapeHtml(block.text)}</code></pre>\n</figure>`;
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

/**
 * Render a flowing text node: HTML-escape, then turn backtick-delimited spans
 * into inline `<code>` chips (the model's inline code convention — see
 * `blocks.ts`). Escaping happens first, so a chip can safely display markup.
 * An unpaired backtick stays a literal backtick.
 */
function renderInline(text: string): string {
  return escapeHtml(text).replace(/`([^`]+)`/g, '<code>$1</code>');
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
 * Vendored "galley proof" stylesheet. Inlined so the output file needs no
 * network or sidecar. Organized as: tokens (light + dark via
 * prefers-color-scheme) → page ground → masthead → sections/headings → prose →
 * ledger tables → key-value dockets → badge stamps → callout notes → divider →
 * motion (screen + reduced-motion guard) → print.
 */
const STYLE = [
  // ---- tokens: paper/ink/accent + a {ink,line,wash} triplet per tone ----
  ':root{color-scheme:light dark;',
  '--paper:#f6f1e7;--ink:#221d14;--muted:#71675a;--faint:#a99d8c;--hairline:#d8cdb9;--accent:#b34a1f;',
  '--glow:rgba(156,59,26,.06);--grain:rgba(33,28,18,.015);--row-hover:rgba(156,59,26,.05);',
  '--neutral-ink:#5b5244;--neutral-line:rgba(91,82,68,.45);--neutral-wash:rgba(91,82,68,.07);',
  '--info-ink:#2f5a8f;--info-line:rgba(47,90,143,.45);--info-wash:rgba(47,90,143,.08);',
  '--success-ink:#34703f;--success-line:rgba(52,112,63,.45);--success-wash:rgba(52,112,63,.09);',
  '--warn-ink:#94600d;--warn-line:rgba(148,96,13,.5);--warn-wash:rgba(148,96,13,.1);',
  '--danger-ink:#a32318;--danger-line:rgba(163,35,24,.45);--danger-wash:rgba(163,35,24,.08);',
  '--code-wash:rgba(33,28,18,.055);--code-line:rgba(33,28,18,.14);--code-panel:rgba(33,28,18,.04);',
  '--font-body:"Charter","Bitstream Charter","Sitka Text",Cambria,Georgia,serif;',
  '--font-display:"Iowan Old Style","Palatino Linotype",Palatino,"Book Antiqua",Georgia,serif;',
  '--font-mono:ui-monospace,"SF Mono","Cascadia Code",Menlo,Consolas,"DejaVu Sans Mono",monospace}',
  '@media (prefers-color-scheme:dark){:root{',
  '--paper:#16120c;--ink:#e9e1d0;--muted:#a2937d;--faint:#6f6450;--hairline:#352d21;--accent:#d8743f;',
  '--glow:rgba(216,116,63,.07);--grain:rgba(233,225,208,.012);--row-hover:rgba(216,116,63,.08);',
  '--neutral-ink:#b4a78f;--neutral-line:rgba(180,167,143,.4);--neutral-wash:rgba(180,167,143,.08);',
  '--info-ink:#85aede;--info-line:rgba(133,174,222,.4);--info-wash:rgba(133,174,222,.09);',
  '--success-ink:#8ec199;--success-line:rgba(142,193,153,.4);--success-wash:rgba(142,193,153,.09);',
  '--warn-ink:#d9a84e;--warn-line:rgba(217,168,78,.4);--warn-wash:rgba(217,168,78,.1);',
  '--danger-ink:#e08074;--danger-line:rgba(224,128,116,.4);--danger-wash:rgba(224,128,116,.09);',
  '--code-wash:rgba(233,225,208,.08);--code-line:rgba(233,225,208,.18);--code-panel:rgba(233,225,208,.05)}}',
  // ---- page ground: warm paper, faint laid-line grain, top glow ----
  '*{box-sizing:border-box}',
  'body{margin:0;background-color:var(--paper);',
  'background-image:radial-gradient(1100px 500px at 50% -120px,var(--glow),transparent 70%),repeating-linear-gradient(0deg,var(--grain) 0 1px,transparent 1px 4px);',
  'color:var(--ink);font-family:var(--font-body);font-size:1.0625rem;line-height:1.7;',
  '-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}',
  '::selection{background:rgba(179,74,31,.25)}',
  '.report{max-width:74ch;margin:0 auto;padding:clamp(2.5rem,6vw,4.5rem) clamp(1.25rem,4vw,2rem) 6rem}',
  // ---- masthead: double rule above a large display-serif title ----
  '.report-masthead{margin:0 0 3.25rem;border-top:3px solid var(--ink)}',
  '.report-masthead::before{content:"";display:block;border-top:1px solid var(--ink);margin-top:4px}',
  '.report-title{font-family:var(--font-display);font-weight:700;font-size:clamp(1.9rem,5vw,2.6rem);line-height:1.12;letter-spacing:-.015em;margin:1.5rem 0 0;text-wrap:balance}',
  // ---- sections and headings ----
  '.block-section{margin:2.75rem 0;scroll-margin-top:2rem}',
  'h2,h3{font-family:var(--font-display);line-height:1.25;margin:1.9rem 0 .6rem;letter-spacing:-.008em}',
  'h2{font-size:1.45rem}h3{font-size:1.18rem}',
  'h4{font-family:var(--font-mono);font-size:.78rem;font-weight:600;text-transform:uppercase;letter-spacing:.12em;color:var(--muted);margin:1.7rem 0 .5rem}',
  '.section-title{font-size:1.42rem;margin:0 0 1rem;border:0;padding:0}',
  '.section-title::after{content:"";display:block;width:3.5rem;border-top:3px solid var(--accent);margin-top:.55rem}',
  // ---- prose ----
  'p{margin:.85rem 0}',
  'ul,ol{margin:.85rem 0;padding-left:1.5rem}',
  'li{margin:.35rem 0}',
  'li::marker{color:var(--accent);font-weight:600}',
  // ---- code: chips inline, panels block — the prose/code boundary ----
  'code{font-family:var(--font-mono);font-size:.82em;background:var(--code-wash);border:1px solid var(--code-line);border-radius:3px;padding:.08em .38em;overflow-wrap:anywhere;-webkit-box-decoration-break:clone;box-decoration-break:clone}',
  '.code-block{margin:1.4rem 0;border:1px solid var(--code-line);border-radius:3px;background:var(--code-panel)}',
  'figure.code-block{padding:0}',
  '.code-label{font-family:var(--font-mono);font-size:.68rem;font-weight:600;text-transform:uppercase;letter-spacing:.12em;color:var(--muted);padding:.5rem 1rem;border-bottom:1px solid var(--code-line)}',
  '.code-block pre{margin:0;padding:.85rem 1rem;overflow-x:auto}',
  '.code-block code{font-size:.82rem;line-height:1.6;background:none;border:0;border-radius:0;padding:0;overflow-wrap:normal;tab-size:2}',
  // ---- tables: open ledger — rules not grids, mono column heads, hover tint ----
  '.table-wrap{margin:1.4rem 0;overflow-x:auto}',
  'figure.table-wrap{padding:0}',
  'table{border-collapse:collapse;width:100%;font-size:.88rem;line-height:1.55;font-variant-numeric:tabular-nums}',
  'th,td{border:0;padding:.6rem .9rem .6rem 0;text-align:left;vertical-align:top}',
  'th:last-child,td:last-child{padding-right:0}',
  'th{font-family:var(--font-mono);font-size:.68rem;font-weight:600;text-transform:uppercase;letter-spacing:.12em;color:var(--muted);background:none}',
  'thead tr{border-bottom:2px solid var(--ink)}',
  'tbody tr{border-bottom:1px solid var(--hairline)}',
  'tbody tr:hover{background:var(--row-hover)}',
  // ---- key-value: docket block with an accent rail and mono keys ----
  '.kv{margin:1.2rem 0;display:grid;gap:.5rem;padding:.35rem 0 .35rem 1.1rem;border-left:2px solid var(--accent)}',
  '.kv-row{display:grid;grid-template-columns:11rem 1fr;gap:1rem}',
  '.kv dt{font-family:var(--font-mono);font-size:.7rem;font-weight:600;text-transform:uppercase;letter-spacing:.12em;color:var(--muted);padding-top:.3rem}',
  '.kv dd{margin:0}',
  '@media (max-width:560px){.kv-row{grid-template-columns:1fr;gap:.1rem}}',
  // ---- badges: inked stamps — bordered mono small caps, square corners ----
  '.badge{display:inline-block;font-family:var(--font-mono);font-size:.68rem;font-weight:600;text-transform:uppercase;letter-spacing:.12em;line-height:1.4;padding:.22rem .6rem .18rem;border:1px solid;border-radius:2px}',
  '.badge-neutral{color:var(--neutral-ink);border-color:var(--neutral-line);background:var(--neutral-wash)}',
  '.badge-info{color:var(--info-ink);border-color:var(--info-line);background:var(--info-wash)}',
  '.badge-success{color:var(--success-ink);border-color:var(--success-line);background:var(--success-wash)}',
  '.badge-warn{color:var(--warn-ink);border-color:var(--warn-line);background:var(--warn-wash)}',
  '.badge-danger{color:var(--danger-ink);border-color:var(--danger-line);background:var(--danger-wash)}',
  // ---- callouts: stamped marginal notes — hairline frame, heavy tone rail ----
  '.callout{margin:1.4rem 0;padding:1rem 1.2rem;border:1px solid;border-left:3px solid;border-radius:0}',
  '.callout-title{font-family:var(--font-mono);font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.14em;margin-bottom:.45rem}',
  '.callout-body{white-space:pre-wrap;font-size:.97rem}',
  '.callout-neutral{border-color:var(--neutral-line);border-left-color:var(--neutral-ink);background:var(--neutral-wash)}',
  '.callout-neutral .callout-title{color:var(--neutral-ink)}',
  '.callout-info{border-color:var(--info-line);border-left-color:var(--info-ink);background:var(--info-wash)}',
  '.callout-info .callout-title{color:var(--info-ink)}',
  '.callout-success{border-color:var(--success-line);border-left-color:var(--success-ink);background:var(--success-wash)}',
  '.callout-success .callout-title{color:var(--success-ink)}',
  '.callout-warn{border-color:var(--warn-line);border-left-color:var(--warn-ink);background:var(--warn-wash)}',
  '.callout-warn .callout-title{color:var(--warn-ink)}',
  '.callout-danger{border-color:var(--danger-line);border-left-color:var(--danger-ink);background:var(--danger-wash)}',
  '.callout-danger .callout-title{color:var(--danger-ink)}',
  // ---- divider: an asterism, not a line ----
  'hr{border:0;margin:3rem 0;text-align:center;line-height:1}',
  'hr::after{content:"\\2042";color:var(--faint);font-size:1.15rem;font-family:var(--font-display)}',
  // ---- motion: staggered load reveal; screen-only and reduced-motion guarded.
  // Children past the 12th share the longest delay (they sit below the fold).
  '@media screen and (prefers-reduced-motion:no-preference){',
  'html{scroll-behavior:smooth}',
  '@keyframes rise{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}',
  '.report>*{animation:rise .55s cubic-bezier(.22,.65,.3,1) both;animation-delay:.62s}',
  '.report>:nth-child(1){animation-delay:.05s}.report>:nth-child(2){animation-delay:.1s}',
  '.report>:nth-child(3){animation-delay:.15s}.report>:nth-child(4){animation-delay:.2s}',
  '.report>:nth-child(5){animation-delay:.25s}.report>:nth-child(6){animation-delay:.3s}',
  '.report>:nth-child(7){animation-delay:.35s}.report>:nth-child(8){animation-delay:.4s}',
  '.report>:nth-child(9){animation-delay:.45s}.report>:nth-child(10){animation-delay:.5s}',
  '.report>:nth-child(11){animation-delay:.55s}.report>:nth-child(12){animation-delay:.6s}',
  '}',
  // ---- print: white ground, no clipped overflow, keep blocks intact ----
  '@media print{',
  'body{background:#fff;font-size:10.5pt}',
  '.report{max-width:none;padding:0}',
  '.table-wrap{overflow-x:visible}',
  '.code-block pre{overflow-x:visible;white-space:pre-wrap}',
  '.block-section,table,.callout,.kv,.code-block{break-inside:avoid}',
  '}',
].join('');
