/**
 * PreToolUse hook — blocks direct Write/Edit/MultiEdit on `state.json`.
 *
 * `state.json` is the hot-path run state file. All mutations must route
 * through `prove run-state step|validator|task|dispatch ...` so transition
 * invariants hold. This hook denies raw Write/Edit calls whose file_path
 * resolves to any `<runs>/<branch>/<slug>/state.json`.
 *
 * Emergency override: `RUN_STATE_ALLOW_DIRECT=1` in the hook's environment.
 *
 * Port of `tools/run_state/hook_guard.py`. Stdout/stderr/exit bytes must
 * match the Python reference for the captured fixtures.
 */

import { pyJsonDump } from './json-compat';
import { EMPTY_HOOK_RESULT, type HookResult, readFilePathField, readToolName } from './types';

const MUTATING_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);

/** A path is a state.json candidate when its trailing segment is `state.json`
 * under any `.prove/runs/` ancestor. `\\` is normalized to `/` to cover
 * Windows-style file_paths the hook payload may carry. */
function isStateFile(path: string): boolean {
  const normalized = path.replace(/\\/g, '/');
  return normalized.endsWith('/state.json') && normalized.includes('/.prove/runs/');
}

export function runGuard(payload: Record<string, unknown> | null): HookResult {
  if (!payload) return EMPTY_HOOK_RESULT;

  const toolName = readToolName(payload);
  if (!MUTATING_TOOLS.has(toolName)) return EMPTY_HOOK_RESULT;

  const filePath = readFilePathField(payload);
  if (!filePath || !isStateFile(filePath)) return EMPTY_HOOK_RESULT;

  if (process.env.RUN_STATE_ALLOW_DIRECT === '1') return EMPTY_HOOK_RESULT;

  const message =
    `Direct edits to ${filePath} are blocked. ` +
    'Use `python3 -m tools.run_state step|validator|task|dispatch ...` to mutate state.json. ' +
    'Set RUN_STATE_ALLOW_DIRECT=1 only for emergency manual recovery.';

  const body = pyJsonDump({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: message,
    },
  });

  return { exitCode: 0, stdout: body, stderr: '' };
}
