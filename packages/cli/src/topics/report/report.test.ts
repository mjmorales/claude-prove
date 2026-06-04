/**
 * report/v1 model + renderer tests. Validation walks the closed block tree;
 * the renderer is deterministic, HTML-escaped, and self-contained.
 */

import { describe, expect, test } from 'bun:test';
import { type ReportDocument, codeSpan, validateReportDocument } from './blocks';
import { renderReportDocument } from './render';

function doc(overrides: Partial<ReportDocument> = {}): ReportDocument {
  return { schema_version: '2', title: 'Report', blocks: [], ...overrides };
}

describe('validateReportDocument', () => {
  test('a well-formed document with every block kind validates clean', () => {
    const d = doc({
      blocks: [
        { type: 'heading', level: 2, text: 'H' },
        { type: 'paragraph', text: 'p' },
        { type: 'list', ordered: true, items: ['a', 'b'] },
        { type: 'table', columns: ['c1'], rows: [['v1']] },
        { type: 'badge', label: 'done', tone: 'success' },
        { type: 'keyValue', items: [{ key: 'k', value: 'v' }] },
        { type: 'callout', tone: 'warn', title: 't', body: 'b' },
        { type: 'code', text: 'bun test', label: 'check' },
        { type: 'section', title: 's', blocks: [{ type: 'paragraph', text: 'nested' }] },
        { type: 'divider' },
      ],
    });
    expect(validateReportDocument(d)).toEqual([]);
  });

  test('rejects a wrong schema_version', () => {
    const errors = validateReportDocument(doc({ schema_version: '1' as never }));
    expect(errors.some((e) => e.includes('schema_version'))).toBe(true);
  });

  test('rejects a code block without text', () => {
    const errors = validateReportDocument(doc({ blocks: [{ type: 'code' } as never] }));
    expect(errors.some((e) => e.includes('blocks[0].text'))).toBe(true);
  });

  test('rejects an unknown block type', () => {
    const errors = validateReportDocument(doc({ blocks: [{ type: 'bogus' } as never] }));
    expect(errors.some((e) => e.includes('blocks[0].type'))).toBe(true);
  });

  test('rejects an off-enum tone', () => {
    const errors = validateReportDocument(
      doc({ blocks: [{ type: 'badge', label: 'x', tone: 'purple' as never }] }),
    );
    expect(errors.some((e) => e.includes('blocks[0].tone'))).toBe(true);
  });

  test('rejects a bad heading level', () => {
    const errors = validateReportDocument(
      doc({ blocks: [{ type: 'heading', level: 7 as never, text: 'x' }] }),
    );
    expect(errors.some((e) => e.includes('blocks[0].level'))).toBe(true);
  });

  test('reports errors inside a nested section with a path', () => {
    const errors = validateReportDocument(
      doc({
        blocks: [
          { type: 'section', blocks: [{ type: 'badge', label: 'x', tone: 'nope' as never }] },
        ],
      }),
    );
    expect(errors.some((e) => e.includes('blocks[0].blocks[0].tone'))).toBe(true);
  });

  test('a non-object document is rejected', () => {
    expect(validateReportDocument(null)).toEqual(['document must be a JSON object']);
    expect(validateReportDocument([])).toEqual(['document must be a JSON object']);
  });
});

describe('renderReportDocument', () => {
  test('emits a self-contained HTML page (no network references)', () => {
    const html = renderReportDocument(doc({ title: 'My Report' }));
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<title>My Report</title>');
    expect(html).toContain('<style>');
    expect(html).not.toContain('http://');
    expect(html).not.toContain('https://');
    expect(html).not.toContain('src=');
  });

  test('HTML-escapes every text node', () => {
    const html = renderReportDocument(
      doc({
        title: '<x>&"\'',
        blocks: [{ type: 'paragraph', text: '<script>alert(1)</script>' }],
      }),
    );
    expect(html).toContain('<title>&lt;x&gt;&amp;&quot;&#39;</title>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)');
  });

  test('renders each block kind to its element', () => {
    const html = renderReportDocument(
      doc({
        blocks: [
          { type: 'heading', level: 1, text: 'Head' },
          { type: 'list', ordered: false, items: ['one'] },
          { type: 'table', columns: ['Col'], rows: [['Cell']] },
          { type: 'badge', label: 'OK', tone: 'success' },
          { type: 'keyValue', items: [{ key: 'Branch', value: 'main' }] },
          { type: 'callout', tone: 'danger', title: 'Risk', body: 'careful' },
          { type: 'divider' },
        ],
      }),
    );
    expect(html).toContain('<h2>Head</h2>'); // heading level 1 -> h2 (h1 is the title)
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>one</li>');
    expect(html).toContain('<th>Col</th>');
    expect(html).toContain('<td>Cell</td>');
    expect(html).toContain('class="badge badge-success"');
    expect(html).toContain('<dt>Branch</dt><dd>main</dd>');
    expect(html).toContain('class="callout callout-danger"');
    expect(html).toContain('<hr>');
  });

  test('nests section blocks', () => {
    const html = renderReportDocument(
      doc({
        blocks: [
          { type: 'section', title: 'Group', blocks: [{ type: 'paragraph', text: 'inside' }] },
        ],
      }),
    );
    expect(html).toContain('<section class="block-section">');
    expect(html).toContain('class="section-title">Group</h2>');
    expect(html).toContain('<p>inside</p>');
  });

  test('is deterministic — same document renders byte-identical', () => {
    const d = doc({ blocks: [{ type: 'badge', label: 'x', tone: 'info' }] });
    expect(renderReportDocument(d)).toBe(renderReportDocument(d));
  });

  test('wraps the title in a masthead header and tables in an overflow figure', () => {
    const html = renderReportDocument(
      doc({ blocks: [{ type: 'table', columns: ['Col'], rows: [['Cell']] }] }),
    );
    expect(html).toContain('<header class="report-masthead">');
    expect(html).toContain('<figure class="table-wrap">');
    expect(html).toContain('</table>\n</figure>');
  });

  test('stylesheet ships dark-scheme, print, and reduced-motion media queries', () => {
    const html = renderReportDocument(doc());
    expect(html).toContain('@media (prefers-color-scheme:dark)');
    expect(html).toContain('@media print');
    expect(html).toContain('prefers-reduced-motion:no-preference');
  });

  test('backtick spans in flowing text render as inline code chips', () => {
    const html = renderReportDocument(
      doc({
        blocks: [
          { type: 'paragraph', text: 'run `bun test` locally' },
          { type: 'table', columns: ['Check'], rows: [['`go vet ./...`']] },
          { type: 'keyValue', items: [{ key: 'Commit', value: '`abc1234`' }] },
          { type: 'callout', tone: 'info', body: 'see `cli/app.py`' },
          { type: 'list', ordered: false, items: ['edit `blocks.ts`'] },
        ],
      }),
    );
    expect(html).toContain('run <code>bun test</code> locally');
    expect(html).toContain('<td><code>go vet ./...</code></td>');
    expect(html).toContain('<dd><code>abc1234</code></dd>');
    expect(html).toContain('see <code>cli/app.py</code>');
    expect(html).toContain('<li>edit <code>blocks.ts</code></li>');
  });

  test('an unpaired backtick stays literal and label voices never chip', () => {
    const html = renderReportDocument(
      doc({
        blocks: [
          { type: 'paragraph', text: 'a ` stray backtick' },
          { type: 'heading', level: 1, text: 'has `ticks`' },
          { type: 'badge', label: '`x`', tone: 'neutral' },
        ],
      }),
    );
    expect(html).toContain('<p>a ` stray backtick</p>');
    expect(html).toContain('<h2>has `ticks`</h2>');
    expect(html).toContain('>`x`</span>');
  });

  test('escaped markup inside a code span renders as text, not markup', () => {
    const html = renderReportDocument(
      doc({ blocks: [{ type: 'paragraph', text: 'use `<script>` carefully' }] }),
    );
    expect(html).toContain('<code>&lt;script&gt;</code>');
  });

  test('renders a code block as a labeled panel', () => {
    const html = renderReportDocument(
      doc({ blocks: [{ type: 'code', text: 'bun run build\nbun test', label: 'verify' }] }),
    );
    expect(html).toContain('<figure class="code-block">');
    expect(html).toContain('<figcaption class="code-label">verify</figcaption>');
    expect(html).toContain('<pre><code>bun run build\nbun test</code></pre>');
  });
});

describe('codeSpan', () => {
  test('wraps a value in backticks', () => {
    expect(codeSpan('bun test')).toBe('`bun test`');
  });

  test('leaves empty and backtick-bearing values untouched', () => {
    expect(codeSpan('')).toBe('');
    expect(codeSpan('echo `date`')).toBe('echo `date`');
  });
});
