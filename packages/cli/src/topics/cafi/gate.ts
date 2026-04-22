/**
 * Claude Code PreToolUse hook for CAFI context injection.
 *
 * Intercepts Glob and Grep tool calls, extracts a search keyword from the
 * tool input, runs a CAFI lookup, and injects matching file descriptions
 * as `additionalContext` so Claude sees relevant index entries before
 * search results arrive.
 *
 * Ported from `tools/cafi/cafi_gate.py`. Regex and fallback semantics are
 * preserved exactly; divergences are limited to JSON whitespace (see
 * `runGate` JSDoc).
 */

import { lookup } from './indexer';

const MIN_KEYWORD_LEN = 2;

// -- Keyword extraction ------------------------------------------------------

/** Glob wildcards and brackets stripped before splitting on `/`. */
const GLOB_STRIP_RE = /[*?{}[\]]/g;
/** Trailing file extension (e.g. `.tsx`, `.yaml`), max 6 chars. */
const EXT_RE = /\.[a-zA-Z0-9]{1,6}$/;

/**
 * Extract a meaningful keyword from a Glob pattern.
 *
 * Strategy:
 * 1. Strip glob wildcards and extensions.
 * 2. Split on `/` and take the last non-empty segment that isn't purely
 *    a glob artifact (e.g. `**`).
 * 3. Fall back to the `path` field's last directory segment.
 *
 * Examples:
 *   `**\/*.tsx`                    -> null   (too generic)
 *   `src/components/**\/*.tsx`     -> "components"
 *   `**\/user_repository.*`        -> "user_repository"
 *   `crates/flite-parser/**\/*.rs` -> "flite-parser"
 */
export function extractGlobKeyword(toolInput: Record<string, unknown>): string | null {
  const pattern = typeof toolInput.pattern === 'string' ? toolInput.pattern : '';

  // Strip wildcards, then trailing extension, then any bare trailing dots.
  let cleaned = pattern.replace(GLOB_STRIP_RE, '');
  cleaned = cleaned.replace(EXT_RE, '');
  cleaned = cleaned.replace(/\.+$/, '');

  const segments = cleaned.split('/').filter((s) => s.replace(/\./g, '').length > 0);

  if (segments.length > 0) {
    const candidate = segments[segments.length - 1] as string;
    if (candidate.length >= MIN_KEYWORD_LEN) {
      return candidate;
    }
  }

  // Fall back to the path field.
  const path = typeof toolInput.path === 'string' ? toolInput.path : '';
  if (path) {
    const pathSegments = path
      .replace(/\/+$/, '')
      .split('/')
      .filter((s) => s.length > 0);
    if (pathSegments.length > 0) {
      const candidate = pathSegments[pathSegments.length - 1] as string;
      if (candidate.length >= MIN_KEYWORD_LEN) {
        return candidate;
      }
    }
  }

  return null;
}

/** Regex metacharacters stripped to plain text. */
const REGEX_META_RE = /[\\^$.|?*+(){}[\]]/g;
/** Common escape sequences (\s, \S, \w, \W, \d, \D, \b, \B). */
const WHITESPACE_ESC_RE = /\\[sSwWdDbB]/g;

/**
 * Extract a meaningful keyword from a Grep pattern.
 *
 * Strategy:
 * 1. Strip common regex escape sequences (`\s`, `\w`, etc.).
 * 2. Strip regex metacharacters.
 * 3. Split on whitespace and pick the longest remaining token.
 *
 * Examples:
 *   `fn\s+parse_expr`  -> "parse_expr"
 *   `class\s+UserRepo` -> "UserRepo"
 *   `log.*Error`       -> "Error"
 *   `interface\{\}`    -> "interface"
 */
export function extractGrepKeyword(toolInput: Record<string, unknown>): string | null {
  const pattern = typeof toolInput.pattern === 'string' ? toolInput.pattern : '';

  // Strip escape sequences first so `\s` becomes a space rather than `s`.
  let cleaned = pattern.replace(WHITESPACE_ESC_RE, ' ');
  cleaned = cleaned.replace(REGEX_META_RE, ' ');

  const tokens = cleaned.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return null;

  // Longest token is most likely the meaningful identifier.
  let candidate = tokens[0] as string;
  for (const t of tokens) {
    if (t.length > candidate.length) candidate = t;
  }
  if (candidate.length >= MIN_KEYWORD_LEN) return candidate;

  return null;
}

// -- Hook entry point ---------------------------------------------------------

export interface HookPayload {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  cwd?: string;
}

export interface GateResult {
  stdout: string;
}

/**
 * Run the gate against a raw stdin payload and return the stdout to emit.
 *
 * Returns `{ stdout: '' }` for any non-matching tool, malformed input,
 * missing keyword, or empty lookup result. On a hit, emits a
 * `PreToolUse` hookSpecificOutput JSON document.
 *
 * JSON whitespace differs from `cafi_gate.py` (Python's default separators
 * include a space after `:` and `,`; JSON.stringify without an indent
 * argument does not). Consumers parse as JSON, so the payload is
 * semantically equivalent.
 */
export function runGate(rawStdin: string, env?: { cwd?: string }): GateResult {
  let payload: HookPayload;
  try {
    payload = JSON.parse(rawStdin) as HookPayload;
  } catch {
    return { stdout: '' };
  }

  const toolName = payload.tool_name;
  if (toolName !== 'Glob' && toolName !== 'Grep') {
    return { stdout: '' };
  }

  const toolInput = payload.tool_input ?? {};
  const keyword =
    toolName === 'Glob' ? extractGlobKeyword(toolInput) : extractGrepKeyword(toolInput);
  if (!keyword) return { stdout: '' };

  const projectRoot = payload.cwd ?? env?.cwd ?? process.cwd();

  let results: Array<{ path: string; description: string }>;
  try {
    results = lookup(projectRoot, keyword);
  } catch {
    return { stdout: '' };
  }

  if (results.length === 0) return { stdout: '' };

  const lines: string[] = [`CAFI index matches for '${keyword}':`];
  for (const r of results) {
    const desc = r.description || '(no description)';
    lines.push(`- \`${r.path}\`: ${desc}`);
  }
  const additionalContext = lines.join('\n');

  return {
    stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        additionalContext,
      },
    }),
  };
}
