/**
 * Register the `claude-md` topic on the cac instance.
 *
 * Historic parity: ported from the retired `skills/claude-md/__main__.py`
 * (plus `validators`, used as a plugin-dir-less fallback in the gather-context
 * script now at `skills/task/scripts/gather-context.sh`).
 * Hooks, the docs skill's `claude-md` subcommand, and direct invocations
 * call `prove claude-md`:
 *
 *   prove claude-md generate         [--project-root R] [--plugin-dir P]
 *   prove claude-md scan             [--project-root R] [--plugin-dir P]
 *   prove claude-md subagent-context [--project-root R] [--plugin-dir P]
 *   prove claude-md validators       [--project-root R]
 *
 * Subcommand dispatch follows the `schema` / `acb` pattern — a single
 * `claude-md <action>` command with an action enum. Default action is
 * `generate` to match the Python CLI's implicit-default behavior.
 *
 * Exit codes:
 *   0  success
 *   1  unknown action
 *   2  project-root is inside ~/.claude (plugin install guard)
 */

import type { CAC } from 'cac';
import {
  runGenerate,
  runScan,
  runSubagentContext,
  runValidators,
} from './claude-md/cli/generate-cmd';

type ClaudeMdAction = 'generate' | 'scan' | 'subagent-context' | 'validators';

const CLAUDE_MD_ACTIONS: ClaudeMdAction[] = ['generate', 'scan', 'subagent-context', 'validators'];

interface ClaudeMdFlags {
  projectRoot?: string;
  pluginDir?: string;
}

export function register(cli: CAC): void {
  cli
    .command(
      'claude-md [action]',
      'Generate or inspect an LLM-optimized CLAUDE.md (action: generate | scan | subagent-context | validators)',
    )
    .option('--project-root <r>', 'Target project root (default: cwd)')
    .option('--plugin-dir <p>', 'Path to the prove plugin directory (default: auto-derived)')
    .action((action: string | undefined, flags: ClaudeMdFlags) => {
      const resolved: ClaudeMdAction = action ? (action as ClaudeMdAction) : 'generate';
      if (!isClaudeMdAction(resolved)) {
        console.error(
          `error: unknown claude-md action '${action}'. expected one of: ${CLAUDE_MD_ACTIONS.join(', ')}`,
        );
        process.exit(1);
      }
      const code = dispatch(resolved, flags);
      process.exit(code);
    });
}

function isClaudeMdAction(value: string): value is ClaudeMdAction {
  return (CLAUDE_MD_ACTIONS as string[]).includes(value);
}

function dispatch(action: ClaudeMdAction, flags: ClaudeMdFlags): number {
  const opts = { projectRoot: flags.projectRoot, pluginDir: flags.pluginDir };
  switch (action) {
    case 'generate':
      return runGenerate(opts);
    case 'scan':
      return runScan(opts);
    case 'subagent-context':
      return runSubagentContext(opts);
    case 'validators':
      return runValidators(opts);
  }
}
