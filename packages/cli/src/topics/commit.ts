/**
 * Register the `commit` topic on the cac instance.
 *
 * Subcommand surface:
 *
 *   prove commit validate-msg <file>
 *
 * `validate-msg` is the pre-commit `commit-msg` hook entrypoint (wired via
 * `.pre-commit-config.yaml`). It enforces conventional-commits format and
 * checks scope registration against `.claude/.prove.json` — a 1:1 port of
 * the retired `scripts/validate_commit_msg.py`.
 *
 * Exit codes:
 *   0  valid message (or merge / revert auto-message passthrough)
 *   1  invalid format, unknown type, or unregistered scope
 */

import type { CAC } from 'cac';
import { runValidateMsgCmd } from './commit/validate-msg';

type CommitAction = 'validate-msg';

const COMMIT_ACTIONS: CommitAction[] = ['validate-msg'];

export function register(cli: CAC): void {
  cli
    .command('commit <action> [file]', 'Commit-message tooling (action: validate-msg)')
    .action((action: string, file: string | undefined) => {
      if (!isCommitAction(action)) {
        console.error(
          `error: unknown commit action '${action}'. expected one of: ${COMMIT_ACTIONS.join(', ')}`,
        );
        process.exit(1);
      }
      const code = dispatch(action, file);
      process.exit(code);
    });
}

function isCommitAction(value: string): value is CommitAction {
  return (COMMIT_ACTIONS as string[]).includes(value);
}

function dispatch(action: CommitAction, file: string | undefined): number {
  switch (action) {
    case 'validate-msg':
      if (!file) {
        console.error('error: commit validate-msg: missing <file> argument');
        console.error('usage: prove commit validate-msg <commit-msg-file>');
        return 1;
      }
      return runValidateMsgCmd(file);
  }
}
