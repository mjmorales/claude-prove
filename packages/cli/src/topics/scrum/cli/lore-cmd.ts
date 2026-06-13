/**
 * `claude-prove scrum lore <action> [args] [flags]`
 *
 * The Lore memory layer — team-scoped accumulated wisdom and conventions.
 * Readable by all; written ONLY by the team's current `tech_lead`. Append-only
 * with supersession: a correction is a NEW entry, never an edit; compaction
 * retires an entry by POINTER (`supersede`), never by delete — the full history
 * survives. A sibling of `scrum decision` (Lore and Codex are sibling memory
 * layers, bridged by `promote`).
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
 *   list <slug> [--live]       Print a team's Lore entries (oldest-first) as a
 *                              JSON array, or a table with `--human`. `--live`
 *                              filters to entries no supersession has retired —
 *                              the set the team artifact's recent window shows.
 *                              An unknown team yields an empty array (not an
 *                              error).
 *   show <id>                  Fetch one Lore entry by id. Prints the JSON row,
 *                              or exits 1 when the id is unknown.
 *   supersede <id> (--by <loreId> | --by-decision <decisionId>) --reason <r> --author <CT-UUID>
 *                              Retire one LIVE entry by pointing it at its
 *                              replacement — a consolidation entry of the same
 *                              team (`--by`) or an accepted Codex decision
 *                              (`--by-decision`). The row's body/author/
 *                              timestamp stay immutable; resolved ONCE (an
 *                              already-superseded entry exits 1). Same
 *                              tech_lead authorship gate as `record`. Reflects
 *                              the change into `teams/<slug>.md`.
 *   promote <id> [--kind adr|glossary|pattern] [--title <t>] [--id <decisionId>] [--by <agent>]
 *                              Lift one Lore entry into the Codex as a gated
 *                              DRAFT (`scrum decision approve` accepts it; on
 *                              approval the source Lore is auto-retired with
 *                              `superseded_by = decision:<id>`). Deterministic
 *                              decision id `lore-promotion-<team>-<loreId>`
 *                              unless `--id` overrides, so a re-promotion
 *                              upserts rather than duplicates. Kind defaults to
 *                              `pattern`; only gated kinds are accepted (a
 *                              non-gated kind would bypass the write-gate).
 *                              Prints the draft decision JSON row.
 *
 * Stdout contract: JSON result per action on stdout; one-line human summary on
 * stderr. `list` returns a JSON array (or a table with `--human`).
 *
 * Exit codes:
 *   0  success
 *   1  usage error, unknown action, unknown team on `record`, an authorship
 *      mismatch on `record`/`supersede` (author is not the seated tech_lead),
 *      an unknown id on `show`/`supersede`/`promote`, a supersession guard
 *      rejection (already superseded, cross-team, self, non-accepted decision),
 *      or a non-gated `--kind` on `promote`
 */

import { mainWorktreeRoot } from '@claude-prove/shared';
import type { ScrumStore } from '../store';
import { GATED_DECISION_KINDS, type LoreRow } from '../types';
import { openCliStore } from './cli-store';
import { reconcileTeamArtifact } from './team-cmd';

export interface LoreCmdFlags {
  /** `record`: the Lore entry's free-text body. */
  body?: string;
  /** `record`/`supersede`: the author's CT-UUID (must be the team's current tech_lead when seated). */
  author?: string;
  /** `supersede`: the replacement Lore entry id (consolidation). */
  by?: string;
  /** `supersede`: the replacement Codex decision id (promotion / codex-duplicate retire). */
  byDecision?: string;
  /** `supersede`: why the entry was replaced. */
  reason?: string;
  /** `promote`: the Codex subtype to record under (gated kinds only; default `pattern`). */
  kind?: string;
  /** `promote`: the decision title (defaults to a derived one). */
  title?: string;
  /** `promote`: override the deterministic `lore-promotion-<team>-<loreId>` decision id. */
  id?: string;
  /** `list`: filter to LIVE entries (no supersession has retired them). */
  live?: boolean;
  human?: boolean;
  workspaceRoot?: string;
}

export type LoreAction = 'record' | 'list' | 'show' | 'supersede' | 'promote';

const LORE_ACTIONS: LoreAction[] = ['record', 'list', 'show', 'supersede', 'promote'];

export async function runLoreCmd(
  action: string,
  args: (string | undefined)[],
  flags: LoreCmdFlags,
): Promise<number> {
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
  const store = await openCliStore(workspaceRoot);
  try {
    switch (action) {
      case 'record':
        return await doRecord(store, workspaceRoot, args[0], flags);
      case 'list':
        return await doList(store, args[0], flags);
      case 'show':
        return await doShow(store, args[0]);
      case 'supersede':
        return await doSupersede(store, workspaceRoot, args[0], flags);
      case 'promote':
        return await doPromote(store, args[0], flags);
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

async function doRecord(
  store: ScrumStore,
  workspaceRoot: string,
  slug: string | undefined,
  flags: LoreCmdFlags,
): Promise<number> {
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
  const { row, warning } = await store.recordLore({
    teamSlug: slug,
    body: flags.body,
    authorContributorId: flags.author,
  });

  // Emit the stdout result before attempting the artifact mirror so callers
  // always receive the row JSON regardless of whether the filesystem write
  // succeeds.
  process.stdout.write(`${JSON.stringify(row)}\n`);
  if (warning !== null) {
    process.stderr.write(`scrum lore record: WARNING: ${warning}\n`);
  }

  // The artifact mirror is a best-effort secondary write: the row is already
  // durably stored, so a filesystem failure should warn but not exit 1.
  const where = await mirrorTeamArtifact(store, workspaceRoot, slug, 'record', row.id);

  process.stderr.write(
    `scrum lore record: ${slug} entry ${row.id} by ${row.author_contributor_id}${where}\n`,
  );
  return 0;
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

async function doList(
  store: ScrumStore,
  slug: string | undefined,
  flags: LoreCmdFlags,
): Promise<number> {
  if (slug === undefined || slug.length === 0) {
    process.stderr.write('scrum lore list: <slug> is required\n');
    return 1;
  }
  const rows = flags.live === true ? await store.listLiveLores(slug) : await store.listLores(slug);
  if (flags.human === true) {
    process.stdout.write(renderHumanTable(rows));
  } else {
    process.stdout.write(`${JSON.stringify(rows)}\n`);
  }
  const filter = flags.live === true ? ' live' : '';
  process.stderr.write(`scrum lore list: ${slug} ${rows.length}${filter} entries\n`);
  return 0;
}

function renderHumanTable(rows: LoreRow[]): string {
  const header = ['ID', 'AUTHOR', 'CREATED_AT', 'SUPERSEDED_BY', 'BODY'];
  const body = rows.map((r) => [
    String(r.id),
    r.author_contributor_id,
    r.created_at,
    r.superseded_by ?? '-',
    r.body,
  ]);
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

async function doShow(store: ScrumStore, rawId: string | undefined): Promise<number> {
  const id = requireId(rawId, 'scrum lore show');
  if (id === null) return 1;
  const row = await store.getLore(id);
  if (row === null) {
    process.stdout.write('null\n');
    process.stderr.write(`scrum lore show: no entry '${id}'\n`);
    return 1;
  }
  process.stdout.write(`${JSON.stringify(row)}\n`);
  process.stderr.write(`scrum lore show: entry ${row.id} (team '${row.team_slug}')\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// supersede
// ---------------------------------------------------------------------------

async function doSupersede(
  store: ScrumStore,
  workspaceRoot: string,
  rawId: string | undefined,
  flags: LoreCmdFlags,
): Promise<number> {
  const id = requireId(rawId, 'scrum lore supersede');
  if (id === null) return 1;
  if (flags.reason === undefined || flags.reason.length === 0) {
    process.stderr.write('scrum lore supersede: --reason <text> is required\n');
    return 1;
  }
  if (flags.author === undefined || flags.author.length === 0) {
    process.stderr.write('scrum lore supersede: --author <CT-UUID> is required\n');
    return 1;
  }
  const hasLore = flags.by !== undefined && flags.by.length > 0;
  const hasDecision = flags.byDecision !== undefined && flags.byDecision.length > 0;
  if (hasLore === hasDecision) {
    process.stderr.write(
      'scrum lore supersede: exactly one of --by <loreId> or --by-decision <decisionId> is required\n',
    );
    return 1;
  }
  let byLoreId: string | undefined;
  if (hasLore) {
    const parsed = requireId(flags.by, 'scrum lore supersede: --by');
    if (parsed === null) return 1;
    byLoreId = parsed;
  }

  // supersedeLore throws on every guard rejection (unknown ids, already
  // superseded, cross-team, self, non-accepted decision, authorship mismatch);
  // all surface as exit 1 via the runLoreCmd catch.
  const { row, warning } = await store.supersedeLore({
    loreId: id,
    byLoreId,
    byDecisionId: hasDecision ? flags.byDecision : undefined,
    reason: flags.reason,
    authorContributorId: flags.author,
  });

  process.stdout.write(`${JSON.stringify(row)}\n`);
  if (warning !== null) {
    process.stderr.write(`scrum lore supersede: WARNING: ${warning}\n`);
  }
  const where = await mirrorTeamArtifact(store, workspaceRoot, row.team_slug, 'supersede', row.id);
  process.stderr.write(
    `scrum lore supersede: ${row.team_slug} entry ${row.id} -> ${row.superseded_by}${where}\n`,
  );
  return 0;
}

// ---------------------------------------------------------------------------
// promote
// ---------------------------------------------------------------------------

async function doPromote(
  store: ScrumStore,
  rawId: string | undefined,
  flags: LoreCmdFlags,
): Promise<number> {
  const id = requireId(rawId, 'scrum lore promote');
  if (id === null) return 1;

  // Only a gated kind may carry a promotion: a non-gated kind would record as
  // `accepted` immediately, silently bypassing the write-gate the promotion
  // protocol is built on.
  if (
    flags.kind !== undefined &&
    !(GATED_DECISION_KINDS as readonly string[]).includes(flags.kind)
  ) {
    process.stderr.write(
      `scrum lore promote: unknown --kind '${flags.kind}'. expected one of: ${GATED_DECISION_KINDS.join(', ')}\n`,
    );
    return 1;
  }

  // promoteLoreToCodex throws on an unknown lore id; surfaces as exit 1 via the
  // runLoreCmd catch. The decision lands as a gated DRAFT — approval (which
  // auto-retires the source Lore) is a separate `scrum decision approve`.
  const decision = await store.promoteLoreToCodex({
    loreId: id,
    decisionId: flags.id,
    kind: flags.kind,
    title: flags.title,
    recordedByAgent: process.env.PROVE_AGENT ?? null,
  });

  process.stdout.write(`${JSON.stringify(decision)}\n`);
  process.stderr.write(
    `scrum lore promote: lore ${id} -> decision ${decision.id} [draft — awaiting approve; approval retires the source]\n`,
  );
  return 0;
}

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

/** Require a non-empty string id (a ULID) argument; null (after stderr) on a miss. */
function requireId(raw: string | undefined, context: string): string | null {
  if (raw === undefined || raw.length === 0) {
    process.stderr.write(`${context}: <id> is required\n`);
    return null;
  }
  return raw;
}

/**
 * Best-effort `teams/<slug>.md` mirror after a Lore write. The row is already
 * durably stored, so a filesystem failure warns but never exits 1 — matching
 * the `record` path's contract. Returns the ` -> <path>` suffix for the stderr
 * summary, or an empty string when the mirror was skipped or failed.
 */
async function mirrorTeamArtifact(
  store: ScrumStore,
  workspaceRoot: string,
  slug: string,
  action: string,
  rowId: string,
): Promise<string> {
  try {
    const team = await store.getTeam(slug);
    const artifactPath =
      team !== null ? await reconcileTeamArtifact(store, workspaceRoot, team) : null;
    return artifactPath !== null ? ` -> ${artifactPath}` : '';
  } catch (artifactErr) {
    const msg = artifactErr instanceof Error ? artifactErr.message : String(artifactErr);
    process.stderr.write(
      `scrum lore ${action}: WARNING: row ${rowId} updated but team artifact reconcile failed: ${msg}\n`,
    );
    return '';
  }
}
