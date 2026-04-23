/**
 * Register the `install` topic on the cac instance.
 *
 * cac dispatches commands on the first positional arg only, so every
 * sub-action lives under a single `install <action>` command with an
 * action enum. Users still invoke the natural form:
 *   prove install init         [--project <cwd>] [--settings <path>] [--force]
 *   prove install init-hooks   [--settings <path>] [--force]
 *   prove install init-config  [--cwd <path>] [--force]
 *   prove install doctor
 *
 * Semantics:
 *   - init        : bootstrap both `.claude/settings.json` and `.claude/.prove.json`.
 *   - init-hooks  : idempotently merge prove-owned hook blocks into settings.json.
 *   - init-config : write `.claude/.prove.json` with auto-detected validators.
 *   - doctor      : report health of the prove installation (exit 1 on any failure).
 *
 * init* resolve the plugin root (env -> walk-up -> fallback), classify the
 * install as dev vs compiled, and build the runtime command prefix
 * (`bun run <pluginRoot>/packages/cli/bin/run.ts` in dev mode) before
 * delegating to the installer lib.
 */

import type { CAC } from 'cac';
import { handleDoctorAction } from './doctor';
import { runInit } from './init';
import { runInitConfig } from './init-config';
import { runInitHooks } from './init-hooks';

type InstallAction = 'init' | 'init-hooks' | 'init-config' | 'doctor';

const INSTALL_ACTIONS: InstallAction[] = ['init', 'init-hooks', 'init-config', 'doctor'];

interface InstallFlags {
  project?: string;
  cwd?: string;
  settings?: string;
  force?: boolean;
}

export function register(cli: CAC): void {
  cli
    .command(
      'install <action>',
      `Install Claude-side wiring (action: ${INSTALL_ACTIONS.join(' | ')})`,
    )
    .option('--project <path>', 'Project root for init (default: cwd)')
    .option('--cwd <path>', 'Target cwd for init-config (default: cwd)')
    .option(
      '--settings <path>',
      'Explicit settings.json path (default: <project>/.claude/settings.json)',
    )
    .option('--force', 'Rewrite existing files even when already in sync')
    .action((action: string, flags: InstallFlags) => {
      if (!isInstallAction(action)) {
        console.error(
          `prove install: unknown action '${action}'. expected one of: ${INSTALL_ACTIONS.join(', ')}`,
        );
        process.exit(1);
      }
      const code = dispatch(action, flags);
      process.exit(code);
    });
}

function isInstallAction(value: string): value is InstallAction {
  return (INSTALL_ACTIONS as string[]).includes(value);
}

function dispatch(action: InstallAction, flags: InstallFlags): number {
  try {
    switch (action) {
      case 'init':
        return runInit({
          project: flags.project,
          settings: flags.settings,
          force: flags.force ?? false,
        });
      case 'init-hooks':
        return runInitHooks({
          settings: flags.settings,
          force: flags.force ?? false,
        });
      case 'init-config':
        return runInitConfig({
          cwd: flags.cwd,
          force: flags.force ?? false,
        });
      case 'doctor':
        return handleDoctorAction();
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`prove install: ${msg}`);
    return 1;
  }
}
