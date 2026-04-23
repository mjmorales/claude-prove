/**
 * Conventional-commits validator used by `.pre-commit-config.yaml`.
 *
 * Ported 1:1 from `scripts/validate_commit_msg.py` (stdlib-only). Preserves:
 *   - `TYPES` set (11 canonical conventional-commits types)
 *   - `BUILTIN_SCOPES` set (always-allowed cross-cutting scopes)
 *   - `PATTERN` regex (type, optional scope, optional `!`, `: `, description)
 *   - Scopes discovery via `.claude/.prove.json` `scopes` map keys
 *   - Merge / Revert "auto-message" passthrough
 *   - Error message text and exit codes (0 valid / 1 invalid)
 *
 * Invocation: `prove commit validate-msg <path-to-commit-msg-file>`.
 * Pre-commit runs the hook from the repo root, so `.claude/.prove.json` is
 * looked up relative to `process.cwd()` — matches the Python resolution
 * (`Path(__file__).resolve().parent.parent / ".claude/.prove.json"`), which
 * also pointed at the repo root when the script lived in `scripts/`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const TYPES: ReadonlySet<string> = new Set([
  'feat',
  'fix',
  'chore',
  'docs',
  'style',
  'refactor',
  'perf',
  'test',
  'build',
  'ci',
  'revert',
]);

// Built-in scopes always allowed (see skills/commit/SKILL.md).
export const BUILTIN_SCOPES: ReadonlySet<string> = new Set(['docs', 'repo', 'config', 'release']);

// type(scope): description  OR  type: description  (optional `!` before `:`)
// Matches the Python re verbatim — see scripts/validate_commit_msg.py.
export const PATTERN = /^(?<type>[a-z]+)(?:\((?<scope>[a-z][a-z0-9_-]*)\))?!?: (?<description>.+)/;

/**
 * Load user-registered scopes from `.claude/.prove.json` at `cwd`. Missing
 * file or malformed JSON → empty set (matches Python's `Path.exists()`
 * short-circuit; malformed JSON would raise in Python, but we downgrade to
 * empty-set to keep the hook non-fatal on transient edits).
 */
export function loadScopes(cwd: string = process.cwd()): Set<string> {
  const proveJson = join(cwd, '.claude', '.prove.json');
  if (!existsSync(proveJson)) return new Set();
  try {
    const raw = readFileSync(proveJson, 'utf8');
    const config = JSON.parse(raw) as { scopes?: Record<string, unknown> };
    const scopes = config.scopes ?? {};
    return new Set(Object.keys(scopes));
  } catch {
    return new Set();
  }
}

/**
 * Validate the first line of the commit-message file. Returns 0 on valid,
 * 1 on invalid. Errors are written to stderr so pre-commit surfaces them
 * cleanly and callers can grep the stream (the Python source used
 * `print()` / stdout, but pre-commit captures both streams so this shift
 * preserves the user-facing hook output while giving CLI callers a clean
 * separation).
 */
export function runValidateMsgCmd(msgFile: string, cwd: string = process.cwd()): number {
  const contents = readFileSync(msgFile, 'utf8');
  const firstLine = (contents.split('\n', 1)[0] ?? '').trim();

  // Allow merge commits and revert auto-messages (git's own templates).
  if (firstLine.startsWith('Merge ') || firstLine.startsWith('Revert "')) {
    return 0;
  }

  const match = PATTERN.exec(firstLine);
  if (!match || !match.groups) {
    console.error('ERROR: commit message does not follow conventional commits format');
    console.error('  Expected: type(scope): description');
    console.error(`  Got:      ${firstLine}`);
    console.error(`  Valid types: ${sortedJoin(TYPES)}`);
    return 1;
  }

  const commitType = match.groups.type ?? '';
  const scope = match.groups.scope;

  if (!TYPES.has(commitType)) {
    console.error(`ERROR: unknown commit type '${commitType}'`);
    console.error(`  Valid types: ${sortedJoin(TYPES)}`);
    return 1;
  }

  if (scope) {
    const allowed = loadScopes(cwd);
    if (allowed.size > 0 && !allowed.has(scope) && !BUILTIN_SCOPES.has(scope)) {
      const union = new Set<string>([...allowed, ...BUILTIN_SCOPES]);
      console.error(`ERROR: scope '${scope}' is not registered in .claude/.prove.json`);
      console.error(`  Allowed scopes: ${sortedJoin(union)}`);
      console.error("  To add a new scope, update .claude/.prove.json 'scopes' field");
      return 1;
    }
  }

  return 0;
}

function sortedJoin(values: ReadonlySet<string>): string {
  return [...values].sort().join(', ');
}
