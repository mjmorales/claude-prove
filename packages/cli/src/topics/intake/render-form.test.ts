/**
 * intake/v1 renderer tests. The page is self-contained (no network), every text
 * node is HTML-escaped, the spec is embedded script-safely, each field type maps
 * to its control, and the output is byte-stable for a given form.
 */

import { describe, expect, test } from 'bun:test';
import type { IntakeForm } from './forms';
import { renderIntakeForm } from './render-form';

function form(overrides: Partial<IntakeForm> = {}): IntakeForm {
  return {
    schema_version: '1',
    form: 'demo',
    title: 'Demo',
    fields: [{ id: 'name', label: 'Name', type: 'text' }],
    ...overrides,
  };
}

describe('renderIntakeForm', () => {
  test('emits a self-contained HTML page (no network references)', () => {
    const html = renderIntakeForm(form({ title: 'My Form' }));
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<title>My Form</title>');
    expect(html).toContain('<style>');
    expect(html).not.toContain('http://');
    expect(html).not.toContain('https://');
    expect(html).not.toContain('src=');
  });

  test('includes the copy control, status line, and payload textarea', () => {
    const html = renderIntakeForm(form());
    expect(html).toContain('id="intake-copy"');
    expect(html).toContain('id="intake-status"');
    expect(html).toContain('id="intake-payload"');
    expect(html).toContain('navigator.clipboard'); // the in-page builder
    expect(html).toContain('execCommand'); // and its fallback
  });

  test('embeds the form spec as script-safe JSON', () => {
    const html = renderIntakeForm(form());
    expect(html).toContain('<script type="application/json" id="intake-spec">');
    // a literal closing tag must never appear inside the embedded JSON
    const start = html.indexOf('id="intake-spec">') + 'id="intake-spec">'.length;
    const json = html.slice(start, html.indexOf('</script>', start));
    expect(json).not.toContain('</');
    expect(
      JSON.parse(
        json
          .replace(/\\u003c/g, '<')
          .replace(/\\u003e/g, '>')
          .replace(/\\u0026/g, '&'),
      ).form,
    ).toBe('demo');
  });

  test('renders each field type to its control', () => {
    const html = renderIntakeForm(
      form({
        fields: [
          { id: 'a', label: 'A', type: 'text', default: 'dv' },
          { id: 'b', label: 'B', type: 'textarea' },
          { id: 'c', label: 'C', type: 'choice', choices: ['x', 'y'], default: 'y' },
          { id: 'd', label: 'D', type: 'multichoice', choices: ['p', 'q'] },
          { id: 'e', label: 'E', type: 'boolean' },
        ],
      }),
    );
    expect(html).toContain('<input type="text" id="f-a"');
    expect(html).toContain('value="dv"');
    expect(html).toContain('<textarea id="f-b"');
    expect(html).toContain('<select id="f-c">');
    expect(html).toContain('<option value="y" selected>y</option>');
    expect(html).toContain('name="f-d" value="p"');
    expect(html).toContain('<input type="checkbox" id="f-e">');
  });

  test('marks required fields and renders help text', () => {
    const html = renderIntakeForm(
      form({ fields: [{ id: 'a', label: 'A', type: 'text', required: true, help: 'why' }] }),
    );
    expect(html).toContain('class="req"');
    expect(html).toContain('class="field-help">why</p>');
  });

  test('HTML-escapes labels, help, and choices', () => {
    const html = renderIntakeForm(
      form({
        title: '<x>&"',
        fields: [{ id: 'a', label: '<b>L</b>', type: 'choice', choices: ['<o>'] }],
      }),
    );
    expect(html).toContain('<title>&lt;x&gt;&amp;&quot;</title>');
    expect(html).toContain('&lt;b&gt;L&lt;/b&gt;');
    expect(html).toContain('<option value="&lt;o&gt;"');
    expect(html).not.toContain('<b>L</b>');
  });

  test('is deterministic — same form renders byte-identical', () => {
    const f = form({ fields: [{ id: 'a', label: 'A', type: 'choice', choices: ['x'] }] });
    expect(renderIntakeForm(f)).toBe(renderIntakeForm(f));
  });
});
