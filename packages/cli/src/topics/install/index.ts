/**
 * Register the `install` topic on the cac instance.
 *
 * cac matches the first positional arg to a command name, so the topic
 * uses the same `<topic> <action>` shape as `schema`/`acb`:
 *
 *   prove install upgrade [--prefix <dir>]
 *
 * Wave 2 of phase 10 splits installer actions across parallel worktrees:
 *   - task 4: init, init-hooks, init-config
 *   - task 5: doctor
 *   - task 6 (this branch): upgrade
 *
 * The orchestrator merges all three branches sequentially; action
 * handlers dispatch from the `INSTALL_ACTIONS` enum below. Each merge
 * unions the enum and the switch arm — a straightforward textual merge
 * because the other branches only touch disjoint lines.
 */

import type { CAC } from 'cac';
import { type UpgradeFlags, runUpgrade } from './upgrade';

type InstallAction = 'upgrade';

const INSTALL_ACTIONS: InstallAction[] = ['upgrade'];

interface InstallFlags extends UpgradeFlags {}

export function register(cli: CAC): void {
  cli
    .command('install <action>', `Installer subcommands (action: ${INSTALL_ACTIONS.join(' | ')})`)
    .option('--prefix <dir>', 'Target directory for the prove binary (upgrade only)')
    .action(async (action: string, flags: InstallFlags) => {
      if (!isInstallAction(action)) {
        process.stderr.write(
          `prove install: unknown action '${action}'. expected one of: ${INSTALL_ACTIONS.join(', ')}\n`,
        );
        process.exit(1);
      }
      const code = await dispatch(action, flags);
      process.exit(code);
    });
}

function isInstallAction(value: string): value is InstallAction {
  return (INSTALL_ACTIONS as string[]).includes(value);
}

async function dispatch(action: InstallAction, flags: InstallFlags): Promise<number> {
  switch (action) {
    case 'upgrade':
      return runUpgrade({ prefix: flags.prefix });
  }
}
