/**
 * Python-compatible JSON serializer for hook stdout payloads.
 *
 * Claude Code hooks parse the stdout JSON; the Python reference emits
 * `json.dump(obj, sys.stdout)` which defaults to `", "` / `": "` separators
 * and `ensure_ascii=True` (non-ASCII escaped as `\uXXXX`). Matching both
 * preserves byte-parity across captured fixtures so the TS port drops in
 * under the same settings.json wiring.
 */
export function pyJsonDump(value: unknown): string {
  return stringify(value);
}

function stringify(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return numberToJson(value);
  if (typeof value === 'string') return stringToJson(value);
  if (Array.isArray(value)) {
    const parts = value.map((v) => stringify(v));
    return `[${parts.join(', ')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    const parts = entries.map(([k, v]) => `${stringToJson(k)}: ${stringify(v)}`);
    return `{${parts.join(', ')}}`;
  }
  return 'null';
}

function numberToJson(n: number): string {
  if (!Number.isFinite(n)) return 'null';
  return n.toString();
}

/**
 * Match Python `json.dumps(..., ensure_ascii=True)`:
 *  - escape `"` and `\` like `JSON.stringify`
 *  - escape control chars (U+0000 - U+001F) via `\uXXXX`
 *  - escape every non-ASCII code point (>= U+0080) via `\uXXXX`, including
 *    surrogate pairs which Python emits as two consecutive `\uXXXX` escapes
 *    (mirrors UTF-16 encoding of astral-plane characters).
 */
function stringToJson(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code === 0x22) {
      out += '\\"';
    } else if (code === 0x5c) {
      out += '\\\\';
    } else if (code === 0x08) {
      out += '\\b';
    } else if (code === 0x09) {
      out += '\\t';
    } else if (code === 0x0a) {
      out += '\\n';
    } else if (code === 0x0c) {
      out += '\\f';
    } else if (code === 0x0d) {
      out += '\\r';
    } else if (code < 0x20 || code >= 0x7f) {
      out += `\\u${code.toString(16).padStart(4, '0')}`;
    } else {
      out += s[i];
    }
  }
  out += '"';
  return out;
}
