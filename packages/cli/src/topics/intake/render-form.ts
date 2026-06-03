/**
 * intake/v1 static renderer — maps an `IntakeForm` (see `forms.ts`) to a single
 * self-contained interactive HTML page. Vendored and deterministic: inline CSS,
 * inline JS, no network references, every text node HTML-escaped, output
 * byte-stable for a given form (so it can be snapshot-tested).
 *
 * Interactivity is the whole point — unlike the read-only report/v1 renderer,
 * this page takes input back. The operator fills the fields and clicks Copy; the
 * in-page JS serializes the answers into an `IntakePayload` (the shape
 * `validate-payload.ts` checks), copies it to the clipboard, and falls back to a
 * selectable textarea when the Clipboard API is blocked (it often is on
 * `file://`). No data leaves the page — there is no network call anywhere.
 *
 * The form spec is embedded once in a `<script type="application/json">` block
 * (script-safe: `<`/`>`/`&` are `\uXXXX`-escaped), and the JS reads field shapes
 * from it. No untrusted value is ever interpolated into executable JS.
 */

import type { IntakeField, IntakeForm } from './forms';

/** Render an intake form to a complete, self-contained interactive HTML page. */
export function renderIntakeForm(form: IntakeForm): string {
  const fields = form.fields.map(renderField).join('\n');
  const description = form.description
    ? `<p class="form-desc">${escapeHtml(form.description)}</p>`
    : '';
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(form.title)}</title>`,
    `<style>${STYLE}</style>`,
    '</head>',
    '<body>',
    '<main class="intake">',
    `<h1 class="intake-title">${escapeHtml(form.title)}</h1>`,
    description,
    '<div class="callout callout-info"><div class="callout-body">Fill the fields below, click <strong>Copy payload</strong>, then paste the copied JSON back into the chat. Nothing is sent anywhere — this page makes no network requests.</div></div>',
    '<form id="intake-form" onsubmit="return false">',
    fields,
    '</form>',
    '<div class="actions">',
    '<button type="button" id="intake-copy">Copy payload</button>',
    '<span id="intake-status" class="status"></span>',
    '</div>',
    '<label class="payload-label" for="intake-payload">Payload (copied to clipboard; select and copy manually if needed)</label>',
    '<textarea id="intake-payload" class="payload" readonly rows="10" spellcheck="false"></textarea>',
    '</main>',
    embedSpec(form),
    `<script>${SCRIPT}</script>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/** Render one field's wrapper (label + input + help + error placeholder). */
function renderField(field: IntakeField): string {
  const req = field.required ? ' <span class="req" title="required">*</span>' : '';
  const help = field.help ? `<p class="field-help">${escapeHtml(field.help)}</p>` : '';
  const label =
    field.type === 'boolean'
      ? ''
      : `<label class="field-label" for="f-${escapeAttr(field.id)}">${escapeHtml(field.label)}${req}</label>`;
  return [
    `<div class="field" data-field="${escapeAttr(field.id)}">`,
    label,
    renderInput(field),
    help,
    '<p class="field-error" hidden>This field is required.</p>',
    '</div>',
  ].join('\n');
}

/** Render the input control for a field by type. */
function renderInput(field: IntakeField): string {
  const id = escapeAttr(field.id);
  const ph = field.placeholder ? ` placeholder="${escapeAttr(field.placeholder)}"` : '';
  switch (field.type) {
    case 'text':
      return `<input type="text" id="f-${id}"${ph} value="${escapeAttr(field.default ?? '')}">`;
    case 'textarea':
      return `<textarea id="f-${id}" rows="4"${ph}>${escapeHtml(field.default ?? '')}</textarea>`;
    case 'choice': {
      const opts = ['<option value="">— select —</option>']
        .concat(
          (field.choices ?? []).map((c) => {
            const sel = field.default === c ? ' selected' : '';
            return `<option value="${escapeAttr(c)}"${sel}>${escapeHtml(c)}</option>`;
          }),
        )
        .join('');
      return `<select id="f-${id}">${opts}</select>`;
    }
    case 'multichoice': {
      const boxes = (field.choices ?? [])
        .map(
          (c) =>
            `<label class="check"><input type="checkbox" name="f-${id}" value="${escapeAttr(c)}"> ${escapeHtml(c)}</label>`,
        )
        .join('\n');
      return `<div class="checks">\n${boxes}\n</div>`;
    }
    case 'boolean': {
      const checked = field.default === 'true' ? ' checked' : '';
      const req = field.required ? ' <span class="req" title="required">*</span>' : '';
      return `<label class="check"><input type="checkbox" id="f-${id}"${checked}> ${escapeHtml(field.label)}${req}</label>`;
    }
  }
}

/** Embed the form spec as script-safe JSON the in-page JS reads field shapes from. */
function embedSpec(form: IntakeForm): string {
  const json = JSON.stringify(form)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
  return `<script type="application/json" id="intake-spec">${json}</script>`;
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

/** Escape a value used inside a double-quoted HTML attribute. */
function escapeAttr(text: string): string {
  return escapeHtml(text);
}

/**
 * In-page payload builder. Reads field shapes from the embedded spec, gathers
 * answers from the DOM, does a soft required check (the authoritative check is
 * `intake validate`), writes the `IntakePayload` JSON into the textarea, and
 * copies it to the clipboard with an execCommand + manual-select fallback. Pure
 * client-side; no network. Authored as a static string — no value is interpolated.
 */
const SCRIPT = [
  '(function(){',
  "  var spec = JSON.parse(document.getElementById('intake-spec').textContent);",
  "  var out = document.getElementById('intake-payload');",
  "  var status = document.getElementById('intake-status');",
  '  function readField(field){',
  "    if (field.type === 'boolean') { var b = document.getElementById('f-' + field.id); return b ? b.checked : false; }",
  "    if (field.type === 'multichoice') {",
  '      var vals = [];',
  "      var boxes = document.querySelectorAll('input[name=\"f-' + field.id + '\"]');",
  '      for (var i = 0; i < boxes.length; i++) { if (boxes[i].checked) vals.push(boxes[i].value); }',
  '      return vals;',
  '    }',
  "    var el = document.getElementById('f-' + field.id);",
  "    return el ? el.value : '';",
  '  }',
  '  function isEmpty(field, val){',
  "    if (field.type === 'boolean') return false;",
  "    if (field.type === 'multichoice') return val.length === 0;",
  "    return String(val).trim() === '';",
  '  }',
  '  function build(){',
  '    var answers = {};',
  '    var missing = [];',
  '    for (var i = 0; i < spec.fields.length; i++) {',
  '      var field = spec.fields[i];',
  '      var val = readField(field);',
  '      answers[field.id] = val;',
  "      var fieldEl = document.querySelector('[data-field=\"' + field.id + '\"]');",
  "      var errEl = fieldEl ? fieldEl.querySelector('.field-error') : null;",
  '      var bad = !!field.required && isEmpty(field, val);',
  '      if (errEl) errEl.hidden = !bad;',
  "      if (fieldEl) { if (bad) fieldEl.classList.add('field-invalid'); else fieldEl.classList.remove('field-invalid'); }",
  '      if (bad) missing.push(field.label);',
  '    }',
  '    var payload = { schema_version: spec.schema_version, form: spec.form, answers: answers };',
  '    out.value = JSON.stringify(payload, null, 2);',
  '    return missing;',
  '  }',
  '  function setStatus(missing, ok){',
  "    var warn = missing.length ? ('\\u26a0 ' + missing.length + ' required field(s) empty: ' + missing.join(', ') + '. ') : '';",
  "    var copied = ok ? 'Payload copied — paste it back into the chat.' : 'Select the box below and copy manually.';",
  '    status.textContent = warn + copied;',
  "    status.className = 'status ' + (missing.length ? 'status-warn' : (ok ? 'status-ok' : 'status-warn'));",
  '  }',
  '  function copy(){',
  '    var missing = build();',
  '    out.focus(); out.select();',
  '    if (navigator.clipboard && navigator.clipboard.writeText) {',
  '      navigator.clipboard.writeText(out.value).then(function(){ setStatus(missing, true); }, function(){ setStatus(missing, false); });',
  '    } else {',
  "      var ok = false; try { ok = document.execCommand('copy'); } catch (e) { ok = false; }",
  '      setStatus(missing, ok);',
  '    }',
  '  }',
  "  document.getElementById('intake-copy').addEventListener('click', copy);",
  '  build();',
  '})();',
].join('\n');

/**
 * Vendored stylesheet — shares the report/v1 palette (system font, centered
 * column, info callout) and adds form controls. Inlined so the page needs no
 * network or sidecar.
 */
const STYLE = [
  ':root{--fg:#1a1a1a;--muted:#666;--border:#d6d6d6;--bg:#fff;--accent:#3b82f6}',
  '*{box-sizing:border-box}',
  'body{margin:0;background:#fafafa;color:var(--fg);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}',
  '.intake{max-width:720px;margin:0 auto;padding:2rem 1.5rem;background:var(--bg);min-height:100vh}',
  '.intake-title{font-size:1.6rem;margin:0 0 .5rem;padding-bottom:.5rem;border-bottom:2px solid var(--border)}',
  '.form-desc{color:var(--muted);margin:.25rem 0 1rem}',
  '.callout{margin:.75rem 0 1.5rem;padding:.75rem 1rem;border-left:4px solid;border-radius:4px}',
  '.callout-info{border-color:var(--accent);background:#eff6ff}',
  '.callout-body{white-space:pre-wrap}',
  '.field{margin:1.1rem 0}',
  '.field-label{display:block;font-weight:600;margin-bottom:.3rem}',
  '.req{color:#dc2626}',
  '.field-help{margin:.25rem 0 0;font-size:.85rem;color:var(--muted)}',
  '.field-error{margin:.25rem 0 0;font-size:.85rem;color:#dc2626;font-weight:600}',
  '.field-invalid input[type=text],.field-invalid textarea,.field-invalid select{border-color:#dc2626}',
  'input[type=text],textarea,select{width:100%;font:inherit;padding:.5rem .6rem;border:1px solid var(--border);border-radius:6px;background:#fff;color:var(--fg)}',
  'textarea{resize:vertical}',
  '.checks{display:grid;gap:.3rem;margin-top:.2rem}',
  '.check{display:flex;align-items:center;gap:.45rem;font-weight:400}',
  '.check input{width:auto}',
  '.actions{display:flex;align-items:center;gap:1rem;margin:1.5rem 0 .75rem}',
  'button{font:inherit;font-weight:600;padding:.55rem 1.1rem;border:0;border-radius:6px;background:var(--accent);color:#fff;cursor:pointer}',
  'button:hover{background:#2563eb}',
  '.status{font-size:.9rem}',
  '.status-ok{color:#166534}',
  '.status-warn{color:#92400e}',
  '.payload-label{display:block;font-size:.85rem;color:var(--muted);margin:.5rem 0 .25rem}',
  '.payload{width:100%;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding:.6rem;border:1px solid var(--border);border-radius:6px;background:#f7f7f7;color:var(--fg)}',
].join('');
