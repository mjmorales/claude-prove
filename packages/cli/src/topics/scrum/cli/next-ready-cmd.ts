/**
 * `prove scrum next-ready [--limit N] [--milestone M] [--human] [--workspace-root W]`
 *
 * Ranked pick-list of actionable tasks via `ScrumStore.nextReady`. Each
 * row carries the composite score + rationale breakdown so agents can
 * explain "why is this task next" without recomputing.
 *
 * Stdout contract:
 *   - Default: JSON array of `NextReadyRow` shapes (one-line per call).
 *   - `--human`: compact text table sorted by score DESC.
 *
 * Exit codes:
 *   0  success
 *   1  store open error or invariant violation
 */

import { join } from 'node:path';
import { mainWorktreeRoot } from '@claude-prove/shared';
import { openScrumStore } from '../store';
import type { NextReadyRow } from '../types';

export interface NextReadyCmdFlags {
  limit?: number | string;
  milestone?: string;
  human?: boolean;
  workspaceRoot?: string;
}

const DEFAULT_LIMIT = 10;

export function runNextReadyCmd(flags: NextReadyCmdFlags): number {
  const limit = coerceInt(flags.limit, DEFAULT_LIMIT);
  const milestoneId =
    flags.milestone !== undefined && flags.milestone.length > 0 ? flags.milestone : undefined;

  const workspaceRoot =
    flags.workspaceRoot && flags.workspaceRoot.length > 0
      ? flags.workspaceRoot
      : (mainWorktreeRoot() ?? process.cwd());
  const store = openScrumStore({ override: join(workspaceRoot, '.prove', 'prove.db') });
  try {
    const rows = store.nextReady({ limit, milestoneId });
    if (flags.human === true) {
      process.stdout.write(renderHumanTable(rows));
    } else {
      process.stdout.write(`${JSON.stringify(rows)}\n`);
    }
    process.stderr.write(`scrum next-ready: ${rows.length} ranked tasks\n`);
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`prove scrum next: ${msg}`);
    return 1;
  } finally {
    store.close();
  }
}

function renderHumanTable(rows: NextReadyRow[]): string {
  if (rows.length === 0) return 'No ready tasks.\n';
  const lines: string[] = [];
  lines.push('Rank  Score   Task                                      Rationale');
  for (const [idx, row] of rows.entries()) {
    const rank = String(idx + 1).padStart(4);
    const score = row.score.toFixed(2).padStart(6);
    const taskCell = `${row.task.id}  ${row.task.title}`.padEnd(40).slice(0, 40);
    const r = row.rationale;
    const rationale = `unblock=${r.unblock_depth} milestone=${r.milestone_boost} hot=${r.context_hotness.toFixed(2)} tags=${r.tag_boost}`;
    lines.push(`${rank}  ${score}  ${taskCell}  ${rationale}`);
  }
  return `${lines.join('\n')}\n`;
}

function coerceInt(value: number | string | undefined, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'number') return Math.trunc(value);
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}
