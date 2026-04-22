/**
 * Shared types for the Claude Code hook handlers.
 *
 * Every hook returns a `HookResult` — the CLI dispatcher (topics/run-state.ts)
 * writes `stdout`/`stderr` and exits with `exitCode`. Keeping the handler pure
 * (no direct process.* writes) makes unit tests trivial: call the function
 * with a parsed payload, assert the three return fields.
 */

export interface HookResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export const EMPTY_HOOK_RESULT: HookResult = { exitCode: 0, stdout: '', stderr: '' };

/**
 * Parse a raw stdin chunk as JSON; returns `null` on empty input or parse
 * failure. Matches Python's `try: json.load(sys.stdin) except (...)` fall-
 * through to a silent-noop hook.
 */
export function parseHookPayload(raw: string): Record<string, unknown> | null {
  if (!raw.trim()) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/** Safe narrow for a nested tool_input.file_path string. */
export function readFilePathField(payload: Record<string, unknown>): string {
  const ti = payload.tool_input;
  if (!ti || typeof ti !== 'object') return '';
  const fp = (ti as Record<string, unknown>).file_path;
  return typeof fp === 'string' ? fp : '';
}

export function readToolName(payload: Record<string, unknown>): string {
  const n = payload.tool_name;
  return typeof n === 'string' ? n : '';
}

export function readCwd(payload: Record<string, unknown>): string {
  const c = payload.cwd;
  return typeof c === 'string' ? c : '';
}
