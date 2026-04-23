/**
 * `prove acb hook post-commit --workspace-root W`
 *
 * CLI wrapper around `runHookPostCommit`. Reads Claude Code hook JSON from
 * stdin, parses it into a `ClaudeCodeHookPayload`, dispatches, and writes
 * the resulting `HookDecision` JSON (or empty string) to stdout.
 *
 * Exit code is always 0 — Claude Code treats `{decision:"block"}` JSON as
 * the block signal; exit is not the channel. Malformed stdin also exits 0
 * with a silent pass (mirrors Python's `except JSONDecodeError: return`).
 */

import type { ClaudeCodeHookPayload } from '../hook';
import { runHookPostCommit } from '../hook';

export interface HookCmdFlags {
  workspaceRoot: string;
}

/** Read all of stdin into a string. Returns '' on EOF or read error. */
async function readStdin(): Promise<string> {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
  } catch {
    return '';
  }
}

export async function runHookCmd(flags: HookCmdFlags): Promise<number> {
  const raw = await readStdin();
  if (raw.length === 0) return 0;

  let payload: ClaudeCodeHookPayload;
  try {
    payload = JSON.parse(raw) as ClaudeCodeHookPayload;
  } catch {
    return 0;
  }

  const result = runHookPostCommit({ workspaceRoot: flags.workspaceRoot, payload });
  if (result.stdout.length > 0) process.stdout.write(result.stdout);
  return result.exit;
}
