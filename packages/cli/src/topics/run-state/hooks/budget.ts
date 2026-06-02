/**
 * Per-task `tool_calls` budget enforcement for the PreToolUse bounds hook.
 *
 * A scrum task MAY declare `bounds.budgets.tool_calls` — a soft ceiling on how
 * many tool calls the worker may make while the task is active. This module
 * turns that advisory ceiling into a native wall: it keeps a per-task tool-call
 * counter, increments it on each relevant tool call, emits a non-blocking
 * stderr soft-warning as the count nears the budget, and emits the canonical
 * PreToolUse deny (permissionDecision:deny on stdout + exit 0) at or over the
 * budget.
 *
 * Two of the three declarable budgets are NOT metered here, by design:
 *
 *   wall_clock_s — bounded by the native subagent timeout. A PreToolUse hook
 *                  fires only when the agent calls a tool; it cannot observe
 *                  idle wall-clock, so the subagent dispatch timeout is the
 *                  authoritative wall-clock wall. This module does not meter it.
 *   tokens       — bounded by the workflow/run token budget. A PreToolUse hook
 *                  has no view of the conversation's token accounting (the
 *                  engine never sees the model's token counters from a hook), so
 *                  a token meter here would be a fabrication. This module does
 *                  not meter it.
 *
 * Counter persistence: the count lives in a plain integer file at
 * `<main-root>/.prove/budget/<task-id>.count`. A file (not a store column) is
 * the right home because the hook fires on the hot path — once per tool call —
 * and a single-integer read+write is a lock-free, contention-free operation,
 * whereas a `prove.db` write per tool call would contend with the worker
 * session's own store writes through the WAL. The file is keyed by task id, so
 * the counter is naturally per-task and per-run (a task runs under one run at a
 * time); resetting a task's budget is a single `rm` of its count file.
 *
 * Permissive by construction. Absent `bounds.budgets.tool_calls`, a counter
 * file that cannot be read or written, or any other failure all pass silently
 * (the caller treats a thrown error or a null/EMPTY result as "do not block").
 * The wall fires only on a clear, declared, met-or-exceeded budget.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { TaskBoundsBudgets } from '../../scrum/types';
import { pyJsonDump } from './json-compat';
import { EMPTY_HOOK_RESULT, type HookResult } from './types';

/**
 * Fraction of the budget at or above which a soft-warning is emitted before the
 * hard stop. At 0.8 the worker is warned over the final fifth of its budget so
 * it can wind down, while the hard stop still fires exactly at the ceiling.
 */
const SOFT_WARN_FRACTION = 0.8;

/**
 * Run the per-task `tool_calls` budget check for one PreToolUse call.
 *
 * `taskId` identifies the active bounded task (the counter file key);
 * `budgets` is its declared `bounds.budgets`; `projectRoot` is the main git
 * worktree root the counter directory lives under.
 *
 * Returns the canonical deny `HookResult` when this call meets or exceeds the
 * `tool_calls` budget, a soft-warning `HookResult` (stderr note, exit 0, no
 * block) when the count has entered the warning band, or `EMPTY_HOOK_RESULT`
 * when under the warning band or when no `tool_calls` budget is declared.
 *
 * Side effect: increments the on-disk counter by one per call. The increment
 * happens before the limit comparison, so the Nth call against a budget of N is
 * the call that is denied.
 */
export function checkToolCallBudget(
  taskId: string,
  budgets: TaskBoundsBudgets | undefined,
  projectRoot: string,
): HookResult {
  const limit = budgets?.tool_calls;
  if (typeof limit !== 'number' || limit <= 0) return EMPTY_HOOK_RESULT;

  const count = incrementCounter(projectRoot, taskId);
  // A failed read/write yields a non-finite count; treat as permissive — a
  // broken counter must never wall off an otherwise-valid tool call.
  if (!Number.isFinite(count)) return EMPTY_HOOK_RESULT;

  if (count >= limit) {
    return deny(budgetExceededReason(count, limit));
  }
  if (count >= Math.ceil(limit * SOFT_WARN_FRACTION)) {
    return softWarn(count, limit);
  }
  return EMPTY_HOOK_RESULT;
}

/**
 * Resolve the absolute counter-file path for a task. Files live under
 * `<main-root>/.prove/budget/`, one `<task-id>.count` per task. The task id is
 * encoded with `encodeURIComponent` so an id containing a path separator or
 * other filesystem-special character cannot escape the budget directory.
 */
export function counterPath(projectRoot: string, taskId: string): string {
  return resolve(projectRoot, '.prove', 'budget', `${encodeURIComponent(taskId)}.count`);
}

/**
 * Increment and persist the task's tool-call counter, returning the new count.
 * A missing or unparseable file is treated as count 0 (first call → 1). Returns
 * `NaN` when the directory or file cannot be created/written, signalling the
 * caller to pass permissively.
 */
function incrementCounter(projectRoot: string, taskId: string): number {
  const path = counterPath(projectRoot, taskId);
  const current = readCounter(path);
  const next = current + 1;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, String(next), 'utf8');
  } catch {
    return Number.NaN;
  }
  return next;
}

/**
 * Read the current count from a counter file. A missing file, a read error, or
 * non-integer contents all read as 0 — the budget starts fresh rather than
 * false-blocking on a corrupt counter.
 */
function readCounter(path: string): number {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return 0;
  }
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

/**
 * Build the hard-stop deny reason. Names the budget and the count so the agent
 * sees exactly which ceiling it hit and how to widen it.
 */
function budgetExceededReason(count: number, limit: number): string {
  return `Tool-call budget reached: ${count} of ${limit} calls used for the active task. Amend the task budget (\`claude-prove scrum task bounds set\`) to raise \`budgets.tool_calls\`, or wind down and complete the task. Further tool calls are blocked until the budget is widened.`;
}

/**
 * Build the non-blocking soft-warning. Emitted on stderr with exit 0 so the
 * call proceeds; the note tells the worker it is nearing its budget.
 */
function softWarn(count: number, limit: number): HookResult {
  const note = `[prove] tool-call budget warning: ${count} of ${limit} calls used for the active task. Approaching the limit — wind down and complete the task before the budget is reached.\n`;
  return { exitCode: 0, stdout: '', stderr: note };
}

/**
 * Emit the canonical PreToolUse deny payload — `permissionDecision: deny` on
 * stdout with exit 0, matching the bounds scope wall and the state-guard hook.
 * This both stops the tool call and surfaces `reason` back to the agent; an
 * exit-2 path would block but leave the reason on empty stderr.
 */
function deny(reason: string): HookResult {
  const body = pyJsonDump({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  });
  return { exitCode: 0, stdout: body, stderr: '' };
}
