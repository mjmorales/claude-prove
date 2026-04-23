/**
 * Task 5 placeholder for Task 4's hook handlers.
 *
 * Task 4 (reconciler-and-hooks) owns the real implementations of
 * `onSessionStart`, `onSubagentStop`, and `onStop`. At Task 5 commit time
 * Task 4's `hook.ts` has not yet landed, so this file exists only to let
 * `cli/hook-cmd.ts` import the handler names at typecheck time.
 *
 * The orchestrator's merge step replaces this file with Task 4's real
 * implementation — keep the exported symbol names identical so the
 * import in `cli/hook-cmd.ts` keeps resolving cleanly.
 */

import type { ScrumStore } from './store';

export interface ScrumHookContext {
  workspaceRoot: string;
  store: ScrumStore;
  /** Parsed Claude Code hook payload — shape fixed by Task 4. */
  payload: unknown;
}

export interface ScrumHookResult {
  /** Bytes to write to stdout, if any (Claude Code block decision JSON). */
  stdout: string;
  /** Process exit code — always 0 for Claude Code hooks. */
  exit: number;
}

/**
 * SessionStart hook — Task 4 will implement the task/session linkage
 * logic. Until then, the dispatch throws so `prove scrum hook
 * session-start` fails loudly rather than silently returning empty.
 */
export function onSessionStart(_ctx: ScrumHookContext): ScrumHookResult {
  throw new Error('scrum hook handlers not yet available (Task 4 pending)');
}

/** SubagentStop hook — see onSessionStart. */
export function onSubagentStop(_ctx: ScrumHookContext): ScrumHookResult {
  throw new Error('scrum hook handlers not yet available (Task 4 pending)');
}

/** Stop hook — see onSessionStart. */
export function onStop(_ctx: ScrumHookContext): ScrumHookResult {
  throw new Error('scrum hook handlers not yet available (Task 4 pending)');
}
