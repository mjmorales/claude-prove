/**
 * Register the `install` topic on the cac instance.
 *
 * cac dispatches commands on the first positional arg only, so every
 * sub-action lives under a single `install <action>` command with an
 * action enum. Users still invoke the natural form:
 *   claude-prove install init                [--project <cwd>] [--settings <path>] [--force]
 *   claude-prove install init-hooks          [--settings <path>] [--force]
 *   claude-prove install init-config         [--cwd <path>] [--force]
 *   claude-prove install local-env           [--plugin-dir <path>] [--settings <path>]
 *   claude-prove install bootstrap-identity  [--cwd <path>] [--with-charter] [--with-team]
 *                                            [--full] [--contributor <id>] [--dry-run]
 *   claude-prove install doctor
 *   claude-prove install upgrade             [--prefix <dir>] [--tag <vX.Y.Z>]
 *   claude-prove install latest              [--offline]
 *
 * Semantics:
 *   - init               : bootstrap both `.claude/settings.json` and `.claude/.prove.json`.
 *   - init-hooks         : idempotently merge prove-owned hook blocks into settings.json.
 *   - init-config        : write `.claude/.prove.json` with auto-detected validators.
 *   - local-env          : write `env.CLAUDE_PROVE_PLUGIN_DIR` into the gitignored
 *                          `.claude/settings.local.json` so the portable
 *                          `${CLAUDE_PROVE_PLUGIN_DIR:-...}` artifacts resolve on this machine.
 *   - bootstrap-identity : run identity pre-flight checks and scaffold charter/team/
 *                          contributor artifacts (skip-if-exists); the mechanical half
 *                          of the project-identity bootstrap the `/prove:init` command drives.
 *   - doctor             : report health of the claude-prove installation (exit 1 on any failure).
 *   - upgrade            : fetch a release binary from GH Releases for the host target
 *                          (compiled mode only); `--tag <vX.Y.Z>` pins a specific release,
 *                          default is latest.
 *   - latest             : emit JSON { local, remote, upToDate } locating the newest installed
 *                          plugin cache and the latest GH release — definitive source for
 *                          `/prove:update` when picking which plugin dir to operate on.
 *
 * init* resolve the plugin root (env -> walk-up -> fallback), classify the
 * install as dev vs compiled, and build the runtime command prefix — in dev
 * mode the shell-interpolated
 * `bun run "${CLAUDE_PROVE_PLUGIN_DIR:-$HOME/.claude/plugins/prove}/packages/cli/bin/run.ts"`,
 * never a machine-absolute path — before delegating to the installer lib.
 */

import type { CAC } from 'cac';
import { runBootstrapIdentity } from './bootstrap-identity-cmd';
import { handleDoctorAction } from './doctor';
import { runInit } from './init';
import { runInitConfig } from './init-config';
import { runInitHooks } from './init-hooks';
import { type LatestFlags, runLatest } from './latest';
import { runLocalEnv } from './local-env';
import { type UpgradeFlags, runUpgrade } from './upgrade';

type InstallAction =
  | 'init'
  | 'init-hooks'
  | 'init-config'
  | 'local-env'
  | 'bootstrap-identity'
  | 'doctor'
  | 'upgrade'
  | 'latest';

const INSTALL_ACTIONS: InstallAction[] = [
  'init',
  'init-hooks',
  'init-config',
  'local-env',
  'bootstrap-identity',
  'doctor',
  'upgrade',
  'latest',
];

type InstallFlags = UpgradeFlags &
  LatestFlags & {
    project?: string;
    cwd?: string;
    settings?: string;
    pluginDir?: string;
    force?: boolean;
    withCharter?: boolean;
    withTeam?: boolean;
    full?: boolean;
    contributor?: string;
    dryRun?: boolean;
    json?: boolean;
  };

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
    .option(
      '--plugin-dir <path>',
      'local-env: plugin checkout directory (default: resolved plugin root)',
    )
    .option('--with-charter', 'bootstrap-identity: scaffold charter.md')
    .option('--with-team', 'bootstrap-identity: scaffold team.md')
    .option('--full', 'bootstrap-identity: scaffold charter, team, and contributor')
    .option('--contributor <id>', 'bootstrap-identity: contributor identity slug')
    .option('--dry-run', 'bootstrap-identity: run pre-flight checks only, write nothing')
    .option('--json', 'bootstrap-identity: emit the machine-readable JSON result')
    .option('--prefix <dir>', 'Target directory for upgrade (default: ~/.local/bin)')
    .option('--tag <vX.Y.Z>', 'upgrade: pin to a specific release tag (default: latest)')
    .option('--offline', 'Skip network calls (latest: omit remote release lookup)')
    .action(async (action: string, flags: InstallFlags) => {
      if (!isInstallAction(action)) {
        console.error(
          `claude-prove install: unknown action '${action}'. expected one of: ${INSTALL_ACTIONS.join(', ')}`,
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
      case 'local-env':
        return runLocalEnv({
          pluginDir: flags.pluginDir,
          settings: flags.settings,
        });
      case 'bootstrap-identity':
        return runBootstrapIdentity({
          cwd: flags.cwd,
          withCharter: flags.withCharter ?? false,
          withTeam: flags.withTeam ?? false,
          full: flags.full ?? false,
          contributor: flags.contributor,
          dryRun: flags.dryRun ?? false,
          json: flags.json ?? false,
        });
      case 'doctor':
        return await handleDoctorAction();
      case 'upgrade':
        return await runUpgrade({ prefix: flags.prefix, tag: flags.tag });
      case 'latest':
        return await runLatest({ offline: flags.offline ?? false });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`claude-prove install: ${msg}`);
    return 1;
  }
}
