/**
 * Register the `notify` topic on the cac instance.
 *
 * Subcommand surface:
 *
 *   prove notify dispatch <event-type> [--project-root R] [--config C] [--branch B] [--slug S]
 *   prove notify test     [event-type] [--project-root R]
 *
 * `dispatch` replaces `scripts/dispatch-event.sh` — the orchestrator hook
 * layer invokes it whenever a step lifecycle event fires. `test` replaces
 * `scripts/notify-test.sh` — operator-facing probe invoked via
 * `/prove:notify test`.
 *
 * Exit codes:
 *   0  success (dispatch is best-effort and always returns 0)
 *   1  unknown action, config missing, or test setup failure
 *   2  test: no reporters matched the event
 */

import type { CAC } from 'cac';
import { runNotifyDispatch } from './notify/dispatch';
import { runNotifyTest } from './notify/test';

type NotifyAction = 'dispatch' | 'test';

const NOTIFY_ACTIONS: NotifyAction[] = ['dispatch', 'test'];

interface NotifyFlags {
  projectRoot?: string;
  config?: string;
  branch?: string;
  slug?: string;
}

export function register(cli: CAC): void {
  cli
    .command('notify <action> [event]', 'Reporter event dispatcher (action: dispatch | test)')
    .option('--project-root <r>', 'Project root containing .claude/.prove.json (default: cwd)')
    .option('--config <c>', 'Config path override (default: <project-root>/.claude/.prove.json)')
    .option('--branch <b>', 'PROVE_RUN_BRANCH override (dispatch only)')
    .option('--slug <s>', 'PROVE_RUN_SLUG override (dispatch only)')
    .action((action: string, event: string | undefined, flags: NotifyFlags) => {
      if (!isNotifyAction(action)) {
        console.error(
          `error: unknown notify action '${action}'. expected one of: ${NOTIFY_ACTIONS.join(', ')}`,
        );
        process.exit(1);
      }
      const code = dispatch(action, event, flags);
      process.exit(code);
    });
}

function isNotifyAction(value: string): value is NotifyAction {
  return (NOTIFY_ACTIONS as string[]).includes(value);
}

function dispatch(action: NotifyAction, event: string | undefined, flags: NotifyFlags): number {
  switch (action) {
    case 'dispatch':
      if (!event) {
        console.error('error: notify dispatch: missing <event-type> argument');
        console.error('usage: prove notify dispatch <event-type>');
        return 1;
      }
      return runNotifyDispatch({
        eventType: event,
        projectRoot: flags.projectRoot,
        configPath: flags.config,
        branch: flags.branch,
        slug: flags.slug,
      });
    case 'test':
      return runNotifyTest({
        eventType: event,
        projectRoot: flags.projectRoot,
      });
  }
}
