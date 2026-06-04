/**
 * Register the `review-ui` topic on the cac instance.
 *
 * cac dispatches on the first positional arg only, so sub-actions live
 * under a single `review-ui <action>` command:
 *
 *   claude-prove review-ui config                              [--cwd <path>]
 *   claude-prove review-ui project <hide|remove|add|list> [path]
 *   claude-prove review-ui serve   <start|stop|status|restart> [--cwd <path>]
 *
 * Semantics:
 *   - config  : emit `{ port, image, tag }` as a JSON line on stdout,
 *               filling in hardcoded defaults for any missing key — an
 *               inspection surface for the resolved review-ui settings.
 *   - project : operate the machine-global project registry — hide / remove /
 *               add a project root, or list visible projects (prune-on-read).
 *               The sub-verb is the second positional (or `--project-verb`);
 *               the `[path]` positional rides the third arg and mutating verbs
 *               default it to cwd.
 *   - serve   : drive the long-lived loopback review-ui server through the
 *               pidfile daemon — start (spawn detached + poll health), stop,
 *               status (JSON on stdout), restart. The hidden `serve __child`
 *               token is the detached child's own entry, not an operator verb.
 */

import type { CAC } from 'cac';
import { type RunConfigOptions, runConfig } from './config';
import { runProject } from './project';
import { SERVE_CHILD_TOKEN, SERVE_VERBS, runServe } from './serve';
import { serveChild } from './serve-child';

type ReviewUiAction = 'config' | 'project' | 'serve';

const REVIEW_UI_ACTIONS: ReviewUiAction[] = ['config', 'project', 'serve'];

interface ReviewUiFlags {
  cwd?: string;
  projectVerb?: string;
  port?: string | number;
}

export function register(cli: CAC): void {
  cli
    .command(
      'review-ui <action> [sub] [path]',
      `Review UI helpers (action: ${REVIEW_UI_ACTIONS.join(
        ' | ',
      )}; project sub-action: hide | remove | add | list; serve sub-action: ${SERVE_VERBS.join(
        ' | ',
      )})`,
    )
    .option('--cwd <path>', 'Project root to resolve .claude/.prove.json from (default: cwd)')
    // cac's per-command `--help` renders option descriptions but not the command
    // description, so the project sub-verbs are named here to keep them
    // discoverable from `review-ui project --help`. The flag is an alternative
    // to the positional sub-action; when both are given the positional wins.
    .option(
      '--project-verb <v>',
      'project sub-action: hide | remove | add | list (or pass it positionally)',
    )
    .option('--port <n>', 'serve start/restart: pin the listen port (skips config + busy-scan)')
    .action(
      async (
        action: string,
        sub: string | undefined,
        path: string | undefined,
        flags: ReviewUiFlags,
      ) => {
        if (!isReviewUiAction(action)) {
          console.error(
            `claude-prove review-ui: unknown action '${action}'. expected one of: ${REVIEW_UI_ACTIONS.join(
              ', ',
            )}`,
          );
          process.exit(1);
        }
        const code = await dispatch(action, sub, path, flags);
        process.exit(code);
      },
    );
}

function isReviewUiAction(value: string): value is ReviewUiAction {
  return (REVIEW_UI_ACTIONS as string[]).includes(value);
}

async function dispatch(
  action: ReviewUiAction,
  sub: string | undefined,
  path: string | undefined,
  flags: ReviewUiFlags,
): Promise<number> {
  switch (action) {
    case 'config': {
      const opts: RunConfigOptions = { cwd: flags.cwd };
      return runConfig(opts);
    }
    case 'project': {
      // The positional sub-action is primary; `--project-verb` is the
      // help-discoverable fallback. With neither, runProject prints usage
      // naming hide/remove/add/list and exits 1.
      const verb = sub ?? flags.projectVerb ?? '';
      return runProject({ action: verb, path });
    }
    case 'serve': {
      // The hidden child token is the detached server's own boot path, not an
      // operator verb — route it straight into the in-process server.
      if (sub === SERVE_CHILD_TOKEN) {
        await serveChild();
        // serveChild's listener keeps the process alive; we only reach here if
        // it returns (it never should under a bound server), so report success.
        return 0;
      }
      // Empty sub prints usage naming the four verbs and exits 1.
      if (flags.port !== undefined) {
        const pinned = Number(flags.port);
        if (!Number.isInteger(pinned) || pinned <= 0) {
          console.error(`claude-prove review-ui serve: invalid --port '${flags.port}'`);
          return 1;
        }
        return runServe({ verb: sub ?? '', cwd: flags.cwd, port: pinned });
      }
      return runServe({ verb: sub ?? '', cwd: flags.cwd });
    }
  }
}
