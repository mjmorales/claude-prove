/**
 * `claude-prove acb hook post-commit --workspace-root W`
 *
 * CLI wrapper around `runHookPostCommit`. Reads Claude Code hook JSON from
 * stdin, parses it into a `ClaudeCodeHookPayload`, dispatches, and writes
 * the resulting `HookDecision` JSON (or empty string) to stdout.
 *
 * Exit code is always 0 — Claude Code treats `{decision:"block"}` JSON as
 * the block signal; exit is not the channel. Malformed stdin also exits 0
 * with a silent pass (mirrors Python's `except JSONDecodeError: return`).
 */

import { readFileSync } from 'node:fs';
import { mainWorktreeRoot } from '@claude-prove/shared';
import type { ClaudeCodeHookPayload } from '../hook';
import { runHookPostCommit } from '../hook';
import { ensureLegacyImported } from '../importer';

export interface HookCmdFlags {
  workspaceRoot?: string;
}

/** Synchronously drain stdin (FD 0). Matches run-state/hooks/dispatch.ts. */
function readStdinSync(): string {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/**
 * `claude-prove acb hook post-commit [--workspace-root W]`
 *
 * Claude Code pipes the PostToolUse payload as JSON on stdin. Malformed or
 * empty stdin silently passes (Python's `except JSONDecodeError: return`).
 * Exit is always 0 — the `{decision:"block"}` JSON on stdout is Claude
 * Code's block signal; exit code is not the channel.
 */
export function runHookCmd(flags: HookCmdFlags): number {
  const workspaceRoot =
    flags.workspaceRoot && flags.workspaceRoot.length > 0
      ? flags.workspaceRoot
      : (mainWorktreeRoot() ?? process.cwd());

  ensureLegacyImported(workspaceRoot);

  const raw = readStdinSync();
  if (raw.length === 0) return 0;

  let payload: ClaudeCodeHookPayload;
  try {
    payload = JSON.parse(raw) as ClaudeCodeHookPayload;
  } catch {
    return 0;
  }

  const result = runHookPostCommit({ workspaceRoot, payload });
  if (result.stdout.length > 0) process.stdout.write(result.stdout);
  return result.exit;
}
