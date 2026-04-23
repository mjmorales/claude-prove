/**
 * `prove scrum hook <event>`
 *
 * Dispatches stdin JSON (Claude Code hook payload) to the matching handler
 * in `../hook`:
 *   session-start  -> onSessionStart
 *   subagent-stop  -> onSubagentStop
 *   stop           -> onStop
 *
 * Malformed or empty stdin silently passes (Claude Code hook convention —
 * matches acb/hook-cmd.ts). The handlers own their own store lifecycle and
 * return a `HookResult` (`{ exitCode, stdout, stderr }`); we just flush
 * stdout/stderr and propagate the exit code.
 */

import { readFileSync } from 'node:fs';
import { type HookResult } from '../../run-state/hooks/types';
import { onSessionStart, onStop, onSubagentStop } from '../hook';

export interface HookCmdFlags {
  workspaceRoot?: string;
}

export type HookEvent = 'session-start' | 'subagent-stop' | 'stop';

const HOOK_EVENTS: readonly HookEvent[] = ['session-start', 'subagent-stop', 'stop'];

export function runHookCmd(event: string, _flags: HookCmdFlags): number {
  if (!isHookEvent(event)) {
    process.stderr.write(
      `error: unknown hook event '${event}' (expected: ${HOOK_EVENTS.join(' | ')})\n`,
    );
    return 1;
  }

  const raw = readStdinSync();
  if (raw.length === 0) return 0;

  let payload: Record<string, unknown> | null;
  try {
    const parsed = JSON.parse(raw);
    payload = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    // Silent pass — mirrors acb hook-cmd's JSONDecodeError handling.
    return 0;
  }

  const result: HookResult = dispatch(event, payload);
  if (result.stdout.length > 0) process.stdout.write(result.stdout);
  if (result.stderr.length > 0) process.stderr.write(result.stderr);
  return result.exitCode;
}

function isHookEvent(value: string): value is HookEvent {
  return (HOOK_EVENTS as readonly string[]).includes(value);
}

function dispatch(event: HookEvent, payload: Record<string, unknown> | null): HookResult {
  switch (event) {
    case 'session-start':
      return onSessionStart(payload);
    case 'subagent-stop':
      return onSubagentStop(payload);
    case 'stop':
      return onStop(payload);
  }
}

function readStdinSync(): string {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}
