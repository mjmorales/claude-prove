/**
 * `claude-prove scrum manifest <action> [flags]`
 *
 * The Manifest — the single both-teams-visible aggregation of every team's
 * published interface contracts. A pure READ surface over the existing
 * team-interface tables: it walks every team and collects each team's ACTIVE
 * accepts (the ask types it handles) and exposes (the outputs it publishes) into
 * one cross-team view, so any team can read what every other team accepts and
 * publishes without walking the registry itself. Nothing is persisted and no
 * action mutates.
 *
 * Action dispatch:
 *   show                       [--human]
 *                              Print the aggregated cross-team contracts. Default
 *                              output is the Manifest JSON
 *                              (`{ teams: [{ slug, accepts, exposes }], asks: [] }`);
 *                              `--human` prints a per-team table of the active
 *                              accepts + exposes. Tolerates zero teams (an empty
 *                              `teams` array, an empty table). The `asks` array is
 *                              always empty until an inter-agent ask protocol
 *                              exists to source cross-team requests.
 *
 * Stdout contract: the Manifest JSON on stdout (or a table with `--human`); a
 * one-line summary on stderr.
 *
 * Exit codes:
 *   0  success (including the zero-teams case)
 *   1  usage error or unknown action
 */

import { join } from 'node:path';
import { mainWorktreeRoot } from '@claude-prove/shared';
import type { ScrumStore } from '../store';
import type { Manifest, ManifestTeamEntry } from '../types';
import { openCliStore } from './cli-store';

export interface ManifestCmdFlags {
  human?: boolean;
  workspaceRoot?: string;
}

export type ManifestAction = 'show';

const MANIFEST_ACTIONS: ManifestAction[] = ['show'];

export async function runManifestCmd(action: string, flags: ManifestCmdFlags): Promise<number> {
  if (!isManifestAction(action)) {
    process.stderr.write(
      `error: unknown manifest action '${action}'. expected one of: ${MANIFEST_ACTIONS.join(', ')}\n`,
    );
    return 1;
  }

  const workspaceRoot =
    flags.workspaceRoot && flags.workspaceRoot.length > 0
      ? flags.workspaceRoot
      : (mainWorktreeRoot() ?? process.cwd());
  const store = await openCliStore(workspaceRoot);
  try {
    switch (action) {
      case 'show':
        return await doShow(store, flags);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`scrum manifest ${action}: ${msg}\n`);
    return 1;
  } finally {
    store.close();
  }
}

function isManifestAction(value: string): value is ManifestAction {
  return (MANIFEST_ACTIONS as string[]).includes(value);
}

// ---------------------------------------------------------------------------
// show
// ---------------------------------------------------------------------------

async function doShow(store: ScrumStore, flags: ManifestCmdFlags): Promise<number> {
  const manifest = await store.getManifest();
  if (flags.human === true) {
    process.stdout.write(renderHumanTable(manifest));
  } else {
    process.stdout.write(`${JSON.stringify(manifest)}\n`);
  }
  process.stderr.write(
    `scrum manifest show: ${manifest.teams.length} teams, ${manifest.asks.length} asks\n`,
  );
  return 0;
}

/**
 * Render the Manifest as a per-team table — one row per team carrying its active
 * accepts (comma-joined ask types) and exposes (comma-joined `name=schema_ref`
 * pairs). An empty manifest renders the header row alone.
 */
function renderHumanTable(manifest: Manifest): string {
  const header = ['TEAM', 'ACCEPTS', 'EXPOSES'];
  const body = manifest.teams.map((entry) => [
    entry.slug,
    formatAccepts(entry),
    formatExposes(entry),
  ]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...body.map((cells) => cells[i]?.length ?? 0)),
  );
  const format = (cells: string[]): string =>
    cells.map((c, i) => c.padEnd(widths[i] ?? c.length)).join('  ');
  const lines = [format(header), ...body.map(format)];
  return `${lines.join('\n')}\n`;
}

/** A team's active accept ask types, comma-joined (empty cell when none). */
function formatAccepts(entry: ManifestTeamEntry): string {
  return entry.accepts.map((a) => a.ask_type).join(', ');
}

/** A team's active exposes as `name=schema_ref`, comma-joined (empty when none). */
function formatExposes(entry: ManifestTeamEntry): string {
  return entry.exposes.map((e) => `${e.name}=${e.schema_ref}`).join(', ');
}
