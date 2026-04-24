/**
 * Register the `pcd` topic on the cac instance.
 *
 * Mirrors `tools/pcd/__main__.py` 1:1 so hooks, skills, and orchestrator
 * wrappers flip from the Python entrypoint to `claude-prove pcd` without interface
 * drift:
 *
 *   claude-prove pcd map      [--scope FILE,...] [--project-root PATH]
 *   claude-prove pcd collapse [--token-budget N] [--project-root PATH]
 *   claude-prove pcd batch    [--max-files N]    [--project-root PATH]
 *   claude-prove pcd status                      [--project-root PATH]
 *
 * Stdout/stderr split matches Python:
 *   - stdout: machine-readable JSON (consumed by LLM agents)
 *   - stderr: human summary, prefixed by `PCD: project_root=<abspath>`
 *
 * Exit codes:
 *   0  success
 *   1  missing input artifact, unknown subcommand, or unexpected error
 */

import type { CAC } from 'cac';
import { runBatch } from './pcd/cli/batch-cmd';
import { runCollapse } from './pcd/cli/collapse-cmd';
import { runMap } from './pcd/cli/map-cmd';
import { resolveProjectRoot } from './pcd/cli/paths';
import { runStatus } from './pcd/cli/status-cmd';

type PcdAction = 'map' | 'collapse' | 'batch' | 'status';

const PCD_ACTIONS: PcdAction[] = ['map', 'collapse', 'batch', 'status'];

interface PcdFlags {
  projectRoot?: string;
  scope?: string;
  tokenBudget?: number;
  maxFiles?: number;
}

export function register(cli: CAC): void {
  cli
    .command(
      'pcd <action>',
      'Progressive Context Distillation (action: map | collapse | batch | status)',
    )
    .option('--project-root <path>', 'Project root directory (default: cwd)')
    .option('--scope <files>', 'Comma-separated file list to restrict analysis (map)')
    .option('--token-budget <n>', 'Approximate token target (collapse, default: 8000)', {
      default: 8000,
    })
    .option('--max-files <n>', 'Max files per batch (batch, default: 15)', { default: 15 })
    .action((action: string, flags: PcdFlags) => {
      if (!isPcdAction(action)) {
        console.error(
          `error: unknown pcd action '${action}'. expected one of: ${PCD_ACTIONS.join(', ')}`,
        );
        process.exit(1);
      }

      // Python prints `PCD: project_root=<abspath>` to stderr immediately
      // after arg parsing, before dispatch — do the same so hooks that tail
      // stderr see the context header even on error paths.
      const absRoot = resolveProjectRoot(flags.projectRoot);
      console.error(`PCD: project_root=${absRoot}`);

      let code: number;
      try {
        code = dispatch(action, flags);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Error: ${msg}`);
        process.exit(1);
      }
      process.exit(code);
    });
}

function isPcdAction(value: string): value is PcdAction {
  return (PCD_ACTIONS as string[]).includes(value);
}

function dispatch(action: PcdAction, flags: PcdFlags): number {
  switch (action) {
    case 'map':
      return runMap({ projectRoot: flags.projectRoot, scope: flags.scope });
    case 'collapse':
      return runCollapse({
        projectRoot: flags.projectRoot,
        tokenBudget: coerceInt(flags.tokenBudget, 8000),
      });
    case 'batch':
      return runBatch({
        projectRoot: flags.projectRoot,
        maxFiles: coerceInt(flags.maxFiles, 15),
      });
    case 'status':
      return runStatus({ projectRoot: flags.projectRoot });
  }
}

/**
 * cac passes `--token-budget 8000` through as a number when the flag is
 * numeric, but `--token-budget=abc` comes back as a string. Coerce either
 * shape to an int so downstream handlers never branch on type.
 */
function coerceInt(value: number | string | undefined, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'number') return Math.trunc(value);
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}
