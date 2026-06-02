/**
 * `claude-prove scrum lore <action> [args] [flags]`
 *
 * The Lore memory layer — team-scoped accumulated wisdom and conventions.
 * Readable by all; written ONLY by the team's current `tech_lead`. Append-only:
 * a correction is a NEW entry, never an edit, so the full history survives. A
 * sibling of `scrum decision` (Lore and Codex are sibling memory layers).
 *
 * Action dispatch:
 *   record <slug> --body <text> --author <CT-UUID>
 *                              Append one Lore entry for the team, authored by
 *                              the supplied CT-UUID. The store enforces the
 *                              authorship rule: with a SEATED tech_lead, the
 *                              author MUST be that holder (a mismatch exits 1,
 *                              naming the expected tech_lead); with NO tech_lead
 *                              seated, the write is allowed and a warning is
 *                              emitted on stderr (the bootstrapping tolerance).
 *                              On success, reflects the new entry into the
 *                              `teams/<slug>.md` artifact's `lore:` block. Prints
 *                              the JSON row.
 *   list <slug>                Print a team's Lore entries (oldest-first) as a
 *                              JSON array, or a table with `--human`. An unknown
 *                              team yields an empty array (not an error).
 *   show <id>                  Fetch one Lore entry by id. Prints the JSON row,
 *                              or exits 1 when the id is unknown.
 *
 * Stdout contract: JSON result per action on stdout; one-line human summary on
 * stderr. `list` returns a JSON array (or a table with `--human`).
 *
 * Exit codes:
 *   0  success
 *   1  usage error, unknown action, unknown team on `record`, an authorship
 *      mismatch on `record` (author is not the seated tech_lead), or an unknown
 *      id on `show`
 */

import { join } from 'node:path';
import { mainWorktreeRoot } from '@claude-prove/shared';
import { type ScrumStore, openScrumStore } from '../store';
import type { LoreRow } from '../types';
import { reconcileTeamArtifact } from './team-cmd';

export interface LoreCmdFlags {
  /** `record`: the Lore entry's free-text body. */
  body?: string;
  /** `record`: the author's CT-UUID (must be the team's current tech_lead when seated). */
  author?: string;
  human?: boolean;
  workspaceRoot?: string;
}

export type LoreAction = 'record' | 'list' | 'show';

const LORE_ACTIONS: LoreAction[] = ['record', 'list', 'show'];

export function runLoreCmd(
  action: string,
  args: (string | undefined)[],
  flags: LoreCmdFlags,
): number {
  if (!isLoreAction(action)) {
    process.stderr.write(
      `error: unknown lore action '${action}'. expected one of: ${LORE_ACTIONS.join(', ')}\n`,
    );
    return 1;
  }

  const workspaceRoot =
    flags.workspaceRoot && flags.workspaceRoot.length > 0
      ? flags.workspaceRoot
      : (mainWorktreeRoot() ?? process.cwd());
  const store = openScrumStore({ override: join(workspaceRoot, '.prove', 'prove.db') });
  try {
    switch (action) {
      case 'record':
        return doRecord(store, workspaceRoot, args[0], flags);
      case 'list':
        return doList(store, args[0], flags);
      case 'show':
        return doShow(store, args[0]);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`scrum lore ${action}: ${msg}\n`);
    return 1;
  } finally {
    store.close();
  }
}

function isLoreAction(value: string): value is LoreAction {
  return (LORE_ACTIONS as string[]).includes(value);
}

// ---------------------------------------------------------------------------
// record
// ---------------------------------------------------------------------------

function doRecord(
  store: ScrumStore,
  workspaceRoot: string,
  slug: string | undefined,
  flags: LoreCmdFlags,
): number {
  if (slug === undefined || slug.length === 0) {
    process.stderr.write('scrum lore record: <slug> is required\n');
    return 1;
  }
  if (flags.body === undefined || flags.body.length === 0) {
    process.stderr.write('scrum lore record: --body <text> is required\n');
    return 1;
  }
  if (flags.author === undefined || flags.author.length === 0) {
    process.stderr.write('scrum lore record: --author <CT-UUID> is required\n');
    return 1;
  }

  // recordLore throws on an unknown team AND on an authorship mismatch (author is
  // not the seated tech_lead); both surface as exit 1 via the runLoreCmd catch.
  const { row, warning } = store.recordLore({
    teamSlug: slug,
    body: flags.body,
    authorContributorId: flags.author,
  });

  const team = store.getTeam(slug);
  // The team exists — recordLore already guarded it — so this is total.
  const artifactPath = team !== null ? reconcileTeamArtifact(store, workspaceRoot, team) : null;

  process.stdout.write(`${JSON.stringify(row)}\n`);
  const where = artifactPath !== null ? ` -> ${artifactPath}` : '';
  process.stderr.write(
    `scrum lore record: ${slug} entry ${row.id} by ${row.author_contributor_id}${where}\n`,
  );
  if (warning !== null) {
    process.stderr.write(`scrum lore record: WARNING: ${warning}\n`);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

function doList(store: ScrumStore, slug: string | undefined, flags: LoreCmdFlags): number {
  if (slug === undefined || slug.length === 0) {
    process.stderr.write('scrum lore list: <slug> is required\n');
    return 1;
  }
  const rows = store.listLores(slug);
  if (flags.human === true) {
    process.stdout.write(renderHumanTable(rows));
  } else {
    process.stdout.write(`${JSON.stringify(rows)}\n`);
  }
  process.stderr.write(`scrum lore list: ${slug} ${rows.length} entries\n`);
  return 0;
}

function renderHumanTable(rows: LoreRow[]): string {
  const header = ['ID', 'AUTHOR', 'CREATED_AT', 'BODY'];
  const body = rows.map((r) => [String(r.id), r.author_contributor_id, r.created_at, r.body]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...body.map((cells) => cells[i]?.length ?? 0)),
  );
  const format = (cells: string[]): string =>
    cells.map((c, i) => c.padEnd(widths[i] ?? c.length)).join('  ');
  const lines = [format(header), ...body.map(format)];
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// show
// ---------------------------------------------------------------------------

function doShow(store: ScrumStore, rawId: string | undefined): number {
  if (rawId === undefined || rawId.length === 0) {
    process.stderr.write('scrum lore show: <id> is required\n');
    return 1;
  }
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    process.stderr.write(`scrum lore show: <id> must be a positive integer, got '${rawId}'\n`);
    return 1;
  }
  const row = store.getLore(id);
  if (row === null) {
    process.stdout.write('null\n');
    process.stderr.write(`scrum lore show: no entry '${id}'\n`);
    return 1;
  }
  process.stdout.write(`${JSON.stringify(row)}\n`);
  process.stderr.write(`scrum lore show: entry ${row.id} (team '${row.team_slug}')\n`);
  return 0;
}
