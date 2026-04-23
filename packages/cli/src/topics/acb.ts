/**
 * Register the `acb` topic on the cac instance.
 *
 * Mirrors `tools/acb/__main__.py` + `tools/acb/hook.py` + migrate-legacy-db
 * so hooks, skills, and orchestrator wrappers flip from the Python
 * entrypoints to `prove acb` without interface drift:
 *
 *   prove acb save-manifest     [--branch B] [--sha S] [--slug G] [--workspace-root W]
 *   prove acb assemble          [--branch B] [--base main] [--workspace-root W]
 *   prove acb hook <event>      [--workspace-root W]   (event: post-commit)
 *   prove acb migrate-legacy-db [--workspace-root W]
 *
 * `ensureLegacyImported(workspaceRoot)` runs at the top of every non-migrate
 * handler so the standalone `.prove/acb.db` gets absorbed into the unified
 * `.prove/prove.db` on the first `prove acb` call in a workspace. The
 * `migrate-legacy-db` subcommand is the user-triggered version and bypasses
 * the memoized wrapper intentionally (see `cli/migrate-legacy-cmd.ts`).
 *
 * Stdout/stderr split matches Python:
 *   - stdout: machine-readable JSON (consumed by agents and pipelines)
 *   - stderr: one-line human summary
 *
 * Exit codes:
 *   0  success
 *   1  unknown action, usage error, HEAD/base unresolvable, stdin parse
 *      error, or schema-invalid manifest
 */

import type { CAC } from 'cac';
import { runAssemble } from './acb/cli/assemble-cmd';
import { runHookCmd } from './acb/cli/hook-cmd';
import { runMigrateLegacy } from './acb/cli/migrate-legacy-cmd';
import { runSaveManifest } from './acb/cli/save-manifest-cmd';

type AcbAction = 'save-manifest' | 'assemble' | 'hook' | 'migrate-legacy-db';

const ACB_ACTIONS: AcbAction[] = ['save-manifest', 'assemble', 'hook', 'migrate-legacy-db'];

type HookEvent = 'post-commit';

const HOOK_EVENTS: readonly HookEvent[] = ['post-commit'];

interface AcbFlags {
  branch?: string;
  sha?: string;
  slug?: string;
  base?: string;
  workspaceRoot?: string;
}

export function register(cli: CAC): void {
  cli
    .command(
      'acb <action> [arg]',
      'Agent change brief — save intent manifests, assemble ACB docs, commit-hook gate',
    )
    .option('--branch <b>', 'Branch name (default: current git branch)')
    .option('--sha <s>', 'Commit SHA (save-manifest; default: current HEAD)')
    .option('--slug <g>', 'Orchestrator run slug (save-manifest; default: PROVE_RUN_SLUG)')
    .option('--base <b>', 'Base branch for diff (assemble; default: main)')
    .option(
      '--workspace-root <w>',
      'Main worktree root; pins store to <root>/.prove/prove.db (default: git common-dir)',
    )
    .action((action: string, arg: string | undefined, flags: AcbFlags) => {
      if (!isAcbAction(action)) {
        console.error(
          `error: unknown acb action '${action}'. expected one of: ${ACB_ACTIONS.join(', ')}`,
        );
        process.exit(1);
      }
      const code = dispatch(action, arg, flags);
      process.exit(code);
    });
}

function isAcbAction(value: string): value is AcbAction {
  return (ACB_ACTIONS as string[]).includes(value);
}

function isHookEvent(value: string): value is HookEvent {
  return (HOOK_EVENTS as readonly string[]).includes(value);
}

function dispatch(action: AcbAction, arg: string | undefined, flags: AcbFlags): number {
  switch (action) {
    case 'save-manifest':
      return runSaveManifest({
        branch: flags.branch,
        sha: flags.sha,
        slug: flags.slug,
        workspaceRoot: flags.workspaceRoot,
      });

    case 'assemble':
      return runAssemble({
        branch: flags.branch,
        base: flags.base,
        workspaceRoot: flags.workspaceRoot,
      });

    case 'hook': {
      const event = arg;
      if (!event) {
        console.error(
          `error: the following arguments are required: hook event (one of: ${HOOK_EVENTS.join(', ')})`,
        );
        return 1;
      }
      if (!isHookEvent(event)) {
        console.error(
          `error: unknown hook event '${event}' (expected: ${HOOK_EVENTS.join(' | ')})`,
        );
        return 1;
      }
      return runHookCmd({ workspaceRoot: flags.workspaceRoot });
    }

    case 'migrate-legacy-db':
      return runMigrateLegacy({ workspaceRoot: flags.workspaceRoot });
  }
}
