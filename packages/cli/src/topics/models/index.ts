/**
 * Register the `models` topic on the cac instance — the dedicated service
 * space for recommended model configuration and advisor management.
 *
 * cac dispatches commands on the first positional arg only, so every
 * sub-action lives under a single `models <action>` command with an action
 * enum. Users invoke the natural form:
 *   claude-prove models set     [--preset <name>] [--main <m>] [--advisor <m>]
 *                               [--fallback <csv>] [--effort <level>]
 *                               [--planning <prove|native|auto>] [--cwd <path>]
 *   claude-prove models apply   [--cwd <path>] [--settings <path>] [--dry-run]
 *   claude-prove models status  [--cwd <path>] [--settings <path>]
 *   claude-prove models presets
 *   claude-prove models routing [--cwd <path>]
 *
 * Semantics:
 *   - set     : declare/amend the committed `models` block in `.claude/.prove.json`
 *               (the project's recommendation — validated against PROVE_SCHEMA).
 *               `--preset` replaces the block with a named preset; field flags
 *               override individual preset fields.
 *   - apply   : materialize the declared block into the auto-gitignored
 *               `.claude/settings.local.json` (`model`, `advisorModel`,
 *               `fallbackModel`, `env.CLAUDE_CODE_EFFORT_LEVEL`). The explicit
 *               per-machine opt-in — model choice is operator- and
 *               billing-dependent, so no other verb ever writes these keys.
 *               `planning` is prove-side routing and is never materialized.
 *   - status  : read-only report of declared vs materialized state plus the
 *               advisory pairing diagnostics.
 *   - presets : read-only list of the closed preset table (name, block, use case).
 *   - routing : print the resolved planning route (`native` | `prove`) — the
 *               one-word contract planning-phase skills branch on.
 */

import type { CAC } from 'cac';
import { runApply } from './apply';
import { runPresets } from './presets';
import { runRouting } from './routing';
import { runSet } from './set';
import { runStatus } from './status';

type ModelsAction = 'set' | 'apply' | 'status' | 'presets' | 'routing';

const MODELS_ACTIONS: ModelsAction[] = ['set', 'apply', 'status', 'presets', 'routing'];

interface ModelsFlags {
  cwd?: string;
  settings?: string;
  dryRun?: boolean;
  preset?: string;
  main?: string;
  advisor?: string;
  fallback?: string;
  effort?: string;
  planning?: string;
}

export function register(cli: CAC): void {
  cli
    .command(
      'models <action>',
      `Recommended model config + advisor management (action: ${MODELS_ACTIONS.join(' | ')})`,
    )
    .option('--cwd <path>', 'Project root holding .claude/.prove.json (default: cwd)')
    .option(
      '--settings <path>',
      'Explicit settings.local.json path (default: <cwd>/.claude/settings.local.json)',
    )
    .option('--dry-run', 'apply: report what would be written without writing')
    .option('--preset <name>', 'set: replace the block with a named preset (see `models presets`)')
    .option('--main <model>', 'set: main-model alias or ID (e.g. opusplan); "" clears')
    .option('--advisor <model>', 'set: advisor model alias or ID (e.g. opus); "" clears')
    .option('--fallback <csv>', 'set: comma-separated fallback chain; "" clears')
    .option('--effort <level>', 'set: effort level (low|medium|high|xhigh|max); "" clears')
    .option('--planning <mode>', 'set: planning-phase routing (prove|native|auto); "" clears')
    .action((action: string, flags: ModelsFlags) => {
      if (!isModelsAction(action)) {
        console.error(
          `claude-prove models: unknown action '${action}'. expected one of: ${MODELS_ACTIONS.join(', ')}`,
        );
        process.exit(1);
      }
      process.exit(dispatch(action, flags));
    });
}

function isModelsAction(value: string): value is ModelsAction {
  return (MODELS_ACTIONS as string[]).includes(value);
}

function dispatch(action: ModelsAction, flags: ModelsFlags): number {
  try {
    switch (action) {
      case 'set':
        return runSet({
          cwd: flags.cwd,
          preset: flags.preset,
          main: flags.main,
          advisor: flags.advisor,
          fallback: flags.fallback,
          effort: flags.effort,
          planning: flags.planning,
        });
      case 'apply':
        return runApply({
          cwd: flags.cwd,
          settings: flags.settings,
          dryRun: flags.dryRun ?? false,
        });
      case 'status':
        return runStatus({ cwd: flags.cwd, settings: flags.settings });
      case 'presets':
        return runPresets();
      case 'routing':
        return runRouting({ cwd: flags.cwd });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`claude-prove models: ${msg}`);
    return 1;
  }
}
