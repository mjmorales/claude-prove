/**
 * `claude-prove acb milestone-brief <render|validate> --milestone M [--file F] [--workspace-root W]`
 *
 * The Milestone Brief surface — the stakeholder rollup produced when a milestone
 * closes. Every sub-action gathers the milestone's constituent stories from the
 * scrum store (each story's reasoning log across its linked runs) and rolls them
 * up.
 *
 *   milestone-brief render   --milestone M   mechanical 4-section brief → stdout (markdown)
 *   milestone-brief validate --milestone M [--file F]  recursive preservation check of brief F (or stdin)
 *
 * `render` emits the deterministic mechanical brief — the starting point the
 * synthesizer skill refines into prose. `validate` proves a brief (the skill's
 * output, via --file or stdin) dropped no attention-bearing item from any
 * constituent story (the recursive preservation rule).
 *
 * Stdout/stderr contract (matches `brief-cmd.ts`):
 *   - render:   stdout = markdown document; stderr = one-line summary
 *   - validate: stdout = JSON `{ ok, missing, required }`; stderr = summary
 *
 * Exit codes:
 *   0  success (validate: brief preserves everything)
 *   1  unknown sub-action, missing --milestone, unknown milestone, read error,
 *      or (validate) a brief that dropped a required item
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mainWorktreeRoot } from '@claude-prove/shared';
import { gatherMilestoneStories } from '../../scrum/reconcile';
import { openScrumStore } from '../../scrum/store';
import {
  buildMilestoneBrief,
  renderMilestoneBrief,
  validateMilestonePreservation,
} from '../milestone-brief';

export type MilestoneBriefSubAction = 'render' | 'validate';

const SUB_ACTIONS: readonly MilestoneBriefSubAction[] = ['render', 'validate'];

export interface MilestoneBriefOpts {
  milestone?: string;
  file?: string;
  workspaceRoot?: string;
}

export function runMilestoneBrief(sub: string | undefined, opts: MilestoneBriefOpts): number {
  if (!sub) {
    process.stderr.write(
      `Error: the following arguments are required: milestone-brief sub-action (one of: ${SUB_ACTIONS.join(', ')})\n`,
    );
    return 1;
  }
  if (!isSubAction(sub)) {
    process.stderr.write(
      `Error: unknown milestone-brief sub-action '${sub}' (expected: ${SUB_ACTIONS.join(' | ')})\n`,
    );
    return 1;
  }
  if (!opts.milestone || opts.milestone.length === 0) {
    process.stderr.write('Error: --milestone is required\n');
    return 1;
  }

  const workspaceRoot =
    opts.workspaceRoot && opts.workspaceRoot.length > 0
      ? opts.workspaceRoot
      : (mainWorktreeRoot() ?? process.cwd());
  const store = openScrumStore({ override: join(workspaceRoot, '.prove', 'prove.db') });
  try {
    if (!store.getMilestone(opts.milestone)) {
      process.stderr.write(`Error: milestone '${opts.milestone}' not found\n`);
      return 1;
    }
    const stories = gatherMilestoneStories(opts.milestone, store, workspaceRoot);
    return sub === 'render' ? runRender(opts.milestone, stories) : runValidate(stories, opts);
  } finally {
    store.close();
  }
}

function runRender(
  milestoneId: string,
  stories: ReturnType<typeof gatherMilestoneStories>,
): number {
  const brief = buildMilestoneBrief(milestoneId, stories);
  process.stdout.write(`${renderMilestoneBrief(brief)}\n`);
  process.stderr.write(
    `Milestone brief rendered: ${brief.attention.length} attention, ${brief.outcomes.length} shipped, ${brief.decisions.length} decisions, ${brief.did_not_ship.length} not shipped\n`,
  );
  return 0;
}

function runValidate(
  stories: ReturnType<typeof gatherMilestoneStories>,
  opts: MilestoneBriefOpts,
): number {
  let briefText: string;
  try {
    briefText =
      opts.file && opts.file.length > 0 ? readFileSync(opts.file, 'utf8') : readStdinSync();
  } catch (err) {
    process.stderr.write(`Error: cannot read brief: ${errMsg(err)}\n`);
    return 1;
  }

  const result = validateMilestonePreservation(briefText, stories);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.ok) {
    process.stderr.write(
      `Milestone brief preserves all ${result.required} attention-bearing item(s)\n`,
    );
    return 0;
  }
  process.stderr.write(
    `Milestone brief DROPPED ${result.missing.length} required item(s): ${result.missing.join(', ')}\n`,
  );
  return 1;
}

function isSubAction(value: string): value is MilestoneBriefSubAction {
  return (SUB_ACTIONS as readonly string[]).includes(value);
}

function readStdinSync(): string {
  return readFileSync(0, 'utf8');
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
