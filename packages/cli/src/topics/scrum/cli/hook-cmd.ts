/**
 * `prove scrum hook <event> [--workspace-root W]`
 *
 * Dispatches stdin JSON (Claude Code hook payload) to the respective
 * Task 4 handler in `../hook`:
 *   session-start  -> onSessionStart
 *   subagent-stop  -> onSubagentStop
 *   stop           -> onStop
 *
 * Malformed or empty stdin silently passes (Claude Code hook convention —
 * matches acb/hook-cmd.ts). Exit is always 0 for `session-start` and
 * `subagent-stop`/`stop` success; hook implementations may throw if not
 * yet available (Task 4 pending), in which case exit is 1.
 *
 * Stdout/stderr contract:
 *   - stdout: handler-provided bytes (usually empty; Claude Code hooks
 *     communicate block decisions via JSON to stdout).
 *   - stderr: human one-liner on error.
 */

import { readFileSync } from 'node:fs';
import { mainWorktreeRoot } from '@claude-prove/shared';
import { type ScrumHookContext, onSessionStart, onStop, onSubagentStop } from '../hook';
import { openScrumStore } from '../store';

export interface HookCmdFlags {
  workspaceRoot?: string;
}

export type HookEvent = 'session-start' | 'subagent-stop' | 'stop';

const HOOK_EVENTS: readonly HookEvent[] = ['session-start', 'subagent-stop', 'stop'];

export function runHookCmd(event: string, flags: HookCmdFlags): number {
  if (!isHookEvent(event)) {
    process.stderr.write(
      `error: unknown hook event '${event}' (expected: ${HOOK_EVENTS.join(' | ')})\n`,
    );
    return 1;
  }

  const workspaceRoot = resolveWorkspaceRoot(flags.workspaceRoot);
  const raw = readStdinSync();
  if (raw.length === 0) return 0;

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    // Silent pass — mirrors acb hook-cmd's JSONDecodeError handling.
    return 0;
  }

  const store = openScrumStore();
  try {
    const ctx: ScrumHookContext = { workspaceRoot, store, payload };
    const result = dispatch(event, ctx);
    if (result.stdout.length > 0) process.stdout.write(result.stdout);
    return result.exit;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`scrum hook ${event}: ${msg}\n`);
    return 1;
  } finally {
    store.close();
  }
}

function isHookEvent(value: string): value is HookEvent {
  return (HOOK_EVENTS as readonly string[]).includes(value);
}

function dispatch(event: HookEvent, ctx: ScrumHookContext) {
  switch (event) {
    case 'session-start':
      return onSessionStart(ctx);
    case 'subagent-stop':
      return onSubagentStop(ctx);
    case 'stop':
      return onStop(ctx);
  }
}

function resolveWorkspaceRoot(flag: string | undefined): string {
  if (flag !== undefined && flag.length > 0) return flag;
  return mainWorktreeRoot() ?? process.cwd();
}

function readStdinSync(): string {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}
