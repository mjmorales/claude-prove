/**
 * CLI-level dispatcher for `claude-prove run-state hook <event>`.
 *
 * Reads the hook payload from stdin, routes to the matching hook module,
 * and writes `stdout`/`stderr` + exits with the module's code. Keeping the
 * stdin-read and process-write here (rather than in each hook) makes the
 * hook modules pure and unit-testable.
 */

import { readFileSync } from 'node:fs';
import { runGuard } from './guard';
import { runSessionStart } from './session-start';
import { runStop } from './stop';
import { runSubagentStop } from './subagent-stop';
import { type HookResult, parseHookPayload } from './types';
import { runValidateHook } from './validate';

export type HookEvent = 'guard' | 'validate' | 'session-start' | 'stop' | 'subagent-stop';

export const HOOK_EVENTS: readonly HookEvent[] = [
  'guard',
  'validate',
  'session-start',
  'stop',
  'subagent-stop',
];

export function isHookEvent(value: string): value is HookEvent {
  return (HOOK_EVENTS as readonly string[]).includes(value);
}

/** Dispatch to a single hook. Pure (no I/O) — caller provides the payload
 *  and writes the result. */
export function dispatchHook(
  event: HookEvent,
  payload: Record<string, unknown> | null,
): HookResult {
  switch (event) {
    case 'guard':
      return runGuard(payload);
    case 'validate':
      return runValidateHook(payload);
    case 'session-start':
      return runSessionStart(payload);
    case 'stop':
      return runStop(payload);
    case 'subagent-stop':
      return runSubagentStop(payload);
  }
}

/** CLI entry point. Reads stdin, parses, dispatches, writes stdout/stderr,
 *  returns the exit code (the caller invokes `process.exit`). */
export function runHookFromStdin(event: HookEvent): number {
  const raw = readStdinSync();
  const payload = parseHookPayload(raw);
  const result = dispatchHook(event, payload);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.exitCode;
}

/** Synchronously drain stdin (FD 0) into a UTF-8 string. Claude Code always
 *  pipes the hook payload as JSON on stdin; TTYs would never reach this
 *  path, but we guard regardless. */
function readStdinSync(): string {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}
