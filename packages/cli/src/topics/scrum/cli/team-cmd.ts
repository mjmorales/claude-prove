/**
 * `claude-prove scrum team <action> [args] [flags]`
 *
 * Action dispatch:
 *   create --slug S --team-type T [--charter C] [--lifetime persistent|terminates_on_milestone] [--terminates-on M]
 *                              Insert the team registry row and scaffold/sync the
 *                              on-disk `teams/<slug>.md` artifact mirroring the
 *                              row, plus the three per-role agent files under
 *                              `.claude/agents/team-<slug>-<role>.md`. Prints the
 *                              JSON row. A `terminates_on_milestone` lifetime
 *                              REQUIRES `--terminates-on <milestone>`; a
 *                              `persistent` lifetime FORBIDS it (the store rejects
 *                              a mismatched pair with exit 1).
 *   show <slug>                Fetch one team by slug. Prints the JSON row, or
 *                              exits 1 when the slug is unknown.
 *   list                       [--human]
 *                              List the registry, ordered by slug.
 *   scope-set <slug>           [--read csv] [--write csv]
 *                              Replace a team's read/write scope globs (full
 *                              REPLACE, not merge — omit a flag to clear that
 *                              side). Rejects with exit 1 when the proposed write
 *                              globs overlap another team's write globs (the
 *                              single-writer-per-path rule), naming both teams and
 *                              the overlapping glob(s). On success, reflects the
 *                              scopes into the `teams/<slug>.md` artifact.
 *   scope-show <slug>          Print a team's scope globs as
 *                              `{ read: [...], write: [...] }`, or exit 1 when the
 *                              slug is unknown.
 *   rotate <slug>              --role tech_lead|engineer|implementer
 *                              --contributor CT-UUID [--reason text]
 *                              Rotate a role slot to a new holder. Atomically
 *                              closes the slot's prior open interval and appends a
 *                              new one. Prints the new open interval as JSON on
 *                              stdout; a summary (and any multi-slot warning) on
 *                              stderr. Reflects the updated roster into the
 *                              `teams/<slug>.md` artifact. The same contributor
 *                              filling multiple slots is permitted — it WARNS,
 *                              never rejects. Regenerates the three per-role
 *                              agent files so they track the new holder's
 *                              resolved CT-UUID.
 *   roster <slug>              Print the current holder per role as
 *                              `{ slug, current: { tech_lead, engineer,
 *                              implementer } }`, or exit 1 with null when the slug
 *                              is unknown.
 *   accept-add <slug>          --ask-type <kebab>
 *                              Add a closed kebab-case ask type the team handles.
 *                              Append-only: a new `active` row. Rejects a
 *                              non-kebab ask type and an unknown team. Reflects
 *                              the active interface into the artifact.
 *   accept-supersede <slug>    --id <id> --reason <text> [--by <id>]
 *                              Retire an accept entry in place — flips its status
 *                              to superseded, records the reason, optionally
 *                              points at a replacement id. Never deletes. Rejects
 *                              an unknown id and an already-superseded entry.
 *   expose-add <slug>          --name <n> --schema-ref <r>
 *                              Add an output the team exposes (a `{name,
 *                              schema_ref}` other teams consume). Append-only.
 *   expose-supersede <slug>    --id <id> --reason <text> [--by <id>]
 *                              Retire an expose entry in place, mirroring
 *                              accept-supersede.
 *   interface <slug>           Print the team's ACTIVE accepts[] + exposes[] as
 *                              `{ slug, accepts, exposes }`, or exit 1 with null
 *                              when the slug is unknown.
 *   terminate <slug>           [--reason <text>]
 *                              Manually disband a team — the team-local terminate.
 *                              Releases the team's scope, supersedes every active
 *                              expose with the reason, vacates the roster, and
 *                              flips status to inactive, all atomically. Prints
 *                              the disband result (counts) as JSON. Rejects an
 *                              unknown team and an already-inactive team. Reflects
 *                              the inactive status into the artifact and deletes
 *                              the team's three per-role agent files.
 *   sync-agents [<slug>]       Regenerate the `.claude/agents/team-<slug>-<role>.md`
 *                              files for active teams: one named team, or every
 *                              active team when no slug is given. Marker-merges
 *                              each file, preserving an authored body. Prints the
 *                              synced slugs as a JSON array. Exits 1 on an unknown
 *                              or inactive named slug.
 *
 * Stdout contract: JSON result per action on stdout; one-line human summary on
 * stderr. `list` returns a JSON array (or a table with `--human`).
 *
 * Exit codes:
 *   0  success
 *   1  usage error, unknown action, invalid enum value, duplicate slug, a
 *      `show`/`scope-show`/`roster`/`interface` miss, a write-scope overlap on
 *      `scope-set`, an unknown team / invalid role on `rotate`, a non-kebab
 *      ask type on `accept-add`, an unknown / already-superseded interface id
 *      on `accept-supersede`/`expose-supersede`, or an unknown / already-inactive
 *      team on `terminate`
 *
 * On-disk reconciliation: `create` writes a `teams/<slug>.md` artifact carrying
 * a YAML frontmatter `schema_version` + `team:` block that embeds the
 * `{slug, team_type, charter, lifetime, terminates_on_milestone, status}`
 * registry fields, so the file mirrors the row. `scope-set` rewrites the same
 * artifact with a `scope:` block carrying the team's `read`/`write` glob arrays.
 * `rotate` rewrites it with a `roster:` block carrying the current holder per
 * role. The accept/expose actions rewrite it with an `interface:` block carrying
 * the team's ACTIVE accepts + exposes (superseded entries are omitted from the
 * artifact, retained in the store). `terminate` rewrites it with the team's
 * `status: inactive`, cleared scope, and emptied roster.
 *
 * Agent-file sync: `create` and `rotate` regenerate the three per-role agent
 * files (`.claude/agents/team-<slug>-<role>.md`) so the committed seats track
 * the seated roster; `terminate` deletes them so no stale seat survives. The
 * agent files are a cosmetic mirror of the seats — a write/delete failure is a
 * sync gap reported on stderr, never a store-mutation failure, and never changes
 * an action's exit code.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mainWorktreeRoot } from '@claude-prove/shared';
import { SCRUM_SCHEMA_VERSION } from '../schemas';
import type { ScrumStore } from '../store';
import type {
  LoreRow,
  Team,
  TeamInterface,
  TeamLifetime,
  TeamRole,
  TeamRoster,
  TeamScopes,
  TeamType,
} from '../types';
import { TEAM_LIFETIMES, TEAM_ROLES, TEAM_TYPES } from '../types';
import { openCliStore } from './cli-store';
import { teamAgentArtifactPath, writeTeamAgentArtifact } from './team-agent-artifact';

export interface TeamCmdFlags {
  slug?: string;
  teamType?: string;
  charter?: string;
  lifetime?: string;
  // `create` (v18): the concrete milestone a `terminates_on_milestone` team
  // disbands on. Required for that lifetime, forbidden for `persistent`.
  terminatesOn?: string;
  read?: string;
  write?: string;
  role?: string;
  contributor?: string;
  reason?: string;
  // `accept-add` / `accept-supersede` + `expose-add` / `expose-supersede` (v17).
  askType?: string;
  name?: string;
  schemaRef?: string;
  id?: string;
  by?: string;
  human?: boolean;
  workspaceRoot?: string;
}

export type TeamAction =
  | 'create'
  | 'show'
  | 'list'
  | 'scope-set'
  | 'scope-show'
  | 'rotate'
  | 'roster'
  | 'accept-add'
  | 'accept-supersede'
  | 'expose-add'
  | 'expose-supersede'
  | 'interface'
  | 'terminate'
  | 'sync-agents';

const TEAM_ACTIONS: TeamAction[] = [
  'create',
  'show',
  'list',
  'scope-set',
  'scope-show',
  'rotate',
  'roster',
  'accept-add',
  'accept-supersede',
  'expose-add',
  'expose-supersede',
  'interface',
  'terminate',
  'sync-agents',
];

export async function runTeamCmd(
  action: string,
  args: (string | undefined)[],
  flags: TeamCmdFlags,
): Promise<number> {
  if (!isTeamAction(action)) {
    process.stderr.write(
      `error: unknown team action '${action}'. expected one of: ${TEAM_ACTIONS.join(', ')}\n`,
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
      case 'create':
        return await doCreate(store, workspaceRoot, flags);
      case 'show':
        return await doShow(store, args[0]);
      case 'list':
        return await doList(store, flags);
      case 'scope-set':
        return await doScopeSet(store, workspaceRoot, args[0], flags);
      case 'scope-show':
        return await doScopeShow(store, args[0]);
      case 'rotate':
        return await doRotate(store, workspaceRoot, args[0], flags);
      case 'roster':
        return await doRoster(store, args[0]);
      case 'accept-add':
        return await doAcceptAdd(store, workspaceRoot, args[0], flags);
      case 'accept-supersede':
        return await doAcceptSupersede(store, workspaceRoot, args[0], flags);
      case 'expose-add':
        return await doExposeAdd(store, workspaceRoot, args[0], flags);
      case 'expose-supersede':
        return await doExposeSupersede(store, workspaceRoot, args[0], flags);
      case 'interface':
        return await doInterface(store, args[0]);
      case 'terminate':
        return await doTerminate(store, workspaceRoot, args[0], flags);
      case 'sync-agents':
        return await doSyncAgents(store, workspaceRoot, args[0]);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`scrum team ${action}: ${msg}\n`);
    return 1;
  } finally {
    store.close();
  }
}

function isTeamAction(value: string): value is TeamAction {
  return (TEAM_ACTIONS as string[]).includes(value);
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

async function doCreate(
  store: ScrumStore,
  workspaceRoot: string,
  flags: TeamCmdFlags,
): Promise<number> {
  if (flags.slug === undefined || flags.slug.length === 0) {
    process.stderr.write('scrum team create: --slug <slug> is required\n');
    return 1;
  }
  const teamType = normalizeTeamType(flags.teamType);
  if (teamType === INVALID_ENUM) return 1;
  if (teamType === undefined) {
    process.stderr.write(
      `scrum team create: --team-type <type> is required (one of: ${TEAM_TYPES.join(', ')})\n`,
    );
    return 1;
  }
  const lifetime = normalizeLifetime(flags.lifetime);
  if (lifetime === INVALID_ENUM) return 1;

  // createTeam enforces the lifetime↔target consistency rule (a
  // terminates_on_milestone team requires --terminates-on; a persistent team
  // forbids it); a violation throws and surfaces as exit 1 via the catch.
  const row = await store.createTeam({
    slug: flags.slug,
    teamType,
    charter: emptyToNull(flags.charter),
    lifetime,
    terminatesOnMilestone: emptyToNull(flags.terminatesOn),
  });

  process.stdout.write(`${JSON.stringify(row)}\n`);
  let createWhere = '';
  try {
    const artifactPath = await reconcileTeamArtifact(store, workspaceRoot, row);
    createWhere = ` -> ${artifactPath}`;
  } catch (artifactErr) {
    const msg = artifactErr instanceof Error ? artifactErr.message : String(artifactErr);
    process.stderr.write(`scrum team create: store updated but artifact write failed: ${msg}\n`);
  }
  syncTeamAgents(workspaceRoot, row, 'create');
  process.stderr.write(`scrum team create: ${row.slug} (${row.team_type})${createWhere}\n`);
  return 0;
}

/** Sentinel distinguishing "invalid enum value given" from "no value given". */
const INVALID_ENUM = Symbol('invalid-enum');

/**
 * Validate `--team-type` against the closed `TeamType` set (case-insensitive).
 * Returns `undefined` when absent, the normalized value when valid, or the
 * `INVALID_ENUM` sentinel (after writing a usage error) when off-vocabulary.
 */
function normalizeTeamType(raw: string | undefined): TeamType | undefined | typeof INVALID_ENUM {
  if (raw === undefined || raw.length === 0) return undefined;
  const lower = raw.toLowerCase();
  if (!(TEAM_TYPES as string[]).includes(lower)) {
    process.stderr.write(
      `scrum team create: unknown --team-type '${raw}'. expected one of: ${TEAM_TYPES.join(', ')}\n`,
    );
    return INVALID_ENUM;
  }
  return lower as TeamType;
}

/**
 * Validate `--lifetime` against the closed `TeamLifetime` set (case-insensitive).
 * Returns `undefined` when absent (the store defaults to `persistent`), the
 * normalized value when valid, or the `INVALID_ENUM` sentinel (after writing a
 * usage error) when off-vocabulary.
 */
function normalizeLifetime(
  raw: string | undefined,
): TeamLifetime | undefined | typeof INVALID_ENUM {
  if (raw === undefined || raw.length === 0) return undefined;
  const lower = raw.toLowerCase();
  if (!(TEAM_LIFETIMES as string[]).includes(lower)) {
    process.stderr.write(
      `scrum team create: unknown --lifetime '${raw}'. expected one of: ${TEAM_LIFETIMES.join(', ')}\n`,
    );
    return INVALID_ENUM;
  }
  return lower as TeamLifetime;
}

/** Coerce an empty-string flag to null so blank flags read as "unset". */
function emptyToNull(raw: string | undefined): string | null {
  return raw !== undefined && raw.length > 0 ? raw : null;
}

/**
 * Reconcile the on-disk `teams/<slug>.md` artifact against the current store
 * state: fetch the team's scope globs, role roster, ACTIVE accept/expose
 * interface, and recorded Lore, then write the artifact mirroring all five
 * (registry row + scopes + current roster + active interface + recent Lore). The
 * single reconciliation point every mutating action
 * (`create`/`scope-set`/`rotate`/`accept-*`/`expose-*`/`lore record`) routes
 * through, so the file always carries the latest of every block. Exported so the
 * `lore record` action (a sibling memory-layer command) can reflect a new Lore
 * entry into the same artifact. Returns the written path.
 */
export async function reconcileTeamArtifact(
  store: ScrumStore,
  workspaceRoot: string,
  row: Team,
): Promise<string> {
  const scopes = await store.getTeamScopes(row.slug);
  const roster = await store.getTeamRoster(row.slug);
  const iface = await store.getTeamInterface(row.slug);
  const lores = await store.listLores(row.slug);
  const dir = join(workspaceRoot, 'teams');
  const path = join(dir, `${row.slug}.md`);
  // The artifact is a mirror of the store row; a write failure is a cosmetic
  // sync gap, not a store-level mutation failure. Callers guard this with their
  // own try/catch so a filesystem error is reported as a non-fatal warning and
  // does not mask a successful store operation.
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, renderTeamArtifact(row, scopes, roster, iface, lores), 'utf8');
  return path;
}

/**
 * Regenerate the team's three `.claude/agents/team-<slug>-<role>.md` files so the
 * committed seats track the seated roster. Each write marker-merges over an
 * existing file (preserving an authored body) or writes a fresh skeleton.
 *
 * The agent files are a cosmetic mirror of the team's seats, not authoritative
 * store state: a write failure is a sync gap reported on stderr, never a
 * store-mutation failure. Self-guarding so callers can invoke it after a
 * successful store op without coupling the exit code to a filesystem error.
 */
function syncTeamAgents(workspaceRoot: string, team: Team, action: string): void {
  for (const role of TEAM_ROLES) {
    try {
      writeTeamAgentArtifact(workspaceRoot, team, role);
    } catch (agentErr) {
      const msg = agentErr instanceof Error ? agentErr.message : String(agentErr);
      process.stderr.write(
        `scrum team ${action}: agent file team-${team.slug}-${role}.md write failed: ${msg}\n`,
      );
    }
  }
}

/**
 * Remove a disbanded team's three `.claude/agents/team-<slug>-<role>.md` files so
 * no stale seat survives termination. A missing file (ENOENT) is the success
 * case, not an error. Self-guarding for the same reason as `syncTeamAgents`: an
 * agent-file delete failure is a cosmetic sync gap, never a store-mutation
 * failure, and must not change the command's exit code.
 */
function deleteTeamAgents(workspaceRoot: string, slug: string, action: string): void {
  for (const role of TEAM_ROLES) {
    const path = teamAgentArtifactPath(workspaceRoot, slug, role);
    try {
      rmSync(path, { force: true });
    } catch (agentErr) {
      const msg = agentErr instanceof Error ? agentErr.message : String(agentErr);
      process.stderr.write(
        `scrum team ${action}: agent file team-${slug}-${role}.md delete failed: ${msg}\n`,
      );
    }
  }
}

/** Most recent Lore entries surfaced in the team artifact (newest-first). */
const LORE_ARTIFACT_LIMIT = 10;

/**
 * Render the team artifact: a YAML frontmatter `team:` + `scope:` + `roster:` +
 * `interface:` + `lore:` block mirroring the row, its scope globs, the current
 * holder per role, its ACTIVE accept/expose interface, and its recorded Lore,
 * plus a human skeleton body. The frontmatter is the file's mirror of the
 * `scrum_teams` row, its `scrum_team_scopes` rows, its open `scrum_team_members`
 * rows, its active `scrum_team_accepts` / `scrum_team_exposes` rows, and its
 * `scrum_lores` rows. The `lore:` block carries the total entry count, the live
 * count, and the most recent LIVE entries (newest-first, capped; superseded
 * entries stay in the store's history but leave the window) — the aggregate the
 * team and any promotion/compaction step reads.
 */
function renderTeamArtifact(
  row: Team,
  scopes: TeamScopes,
  roster: TeamRoster,
  iface: TeamInterface,
  lores: LoreRow[],
): string {
  const acceptList = iface.accepts.map((a) => a.ask_type);
  const exposeList = iface.exposes.map((e) => `${e.name}=${e.schema_ref}`);
  // The recent window carries LIVE entries only (v28): a superseded entry's
  // substance lives in its replacement, so surfacing both would double the
  // tokens every team agent reads for no added signal. `count` stays the full
  // append-only total; `live` is the window's population.
  const liveLores = lores.filter((l) => l.superseded_by === null);
  // listLores returns oldest-first; the artifact surfaces the newest entries.
  const recentLore = [...liveLores].reverse().slice(0, LORE_ARTIFACT_LIMIT);
  const frontmatter = [
    '---',
    `schema_version: ${SCRUM_SCHEMA_VERSION}`,
    'team:',
    `  slug: ${row.slug}`,
    `  team_type: ${row.team_type}`,
    `  charter: ${yamlValue(row.charter)}`,
    `  lifetime: ${row.lifetime}`,
    `  terminates_on_milestone: ${yamlValue(row.terminates_on_milestone)}`,
    `  status: ${row.status}`,
    `  created_at: ${row.created_at}`,
    'scope:',
    `  read: ${yamlGlobList(scopes.read)}`,
    `  write: ${yamlGlobList(scopes.write)}`,
    'roster:',
    ...TEAM_ROLES.map(
      (role) => `  ${role}: ${yamlValue(roster.current[role]?.contributor_id ?? null)}`,
    ),
    'interface:',
    `  accepts: ${yamlGlobList(acceptList)}`,
    '  exposes:',
    ...(iface.exposes.length === 0
      ? ['    []']
      : iface.exposes.map(
          (e) =>
            `    - { name: ${JSON.stringify(e.name)}, schema_ref: ${JSON.stringify(e.schema_ref)} }`,
        )),
    'lore:',
    `  count: ${lores.length}`,
    `  live: ${liveLores.length}`,
    '  recent:',
    ...(recentLore.length === 0
      ? ['    []']
      : recentLore.map(
          (l) =>
            `    - { id: ${l.id}, author: ${JSON.stringify(l.author_contributor_id)}, created_at: ${JSON.stringify(l.created_at)}, body: ${JSON.stringify(l.body)} }`,
        )),
    '---',
  ].join('\n');
  const body = [
    `# Team: ${row.slug}`,
    '',
    '## Charter',
    '',
    row.charter ?? '<!-- One-line mission statement. -->',
    '',
    '## Type',
    '',
    `- Interaction archetype: ${row.team_type}`,
    `- Lifetime: ${row.lifetime}`,
    `- Terminates on milestone: ${row.terminates_on_milestone ?? '<!-- none -->'}`,
    `- Status: ${row.status}`,
    '',
    '## Scope',
    '',
    `- Read globs: ${scopes.read.length > 0 ? scopes.read.join(', ') : '<!-- none -->'}`,
    `- Write globs: ${scopes.write.length > 0 ? scopes.write.join(', ') : '<!-- none -->'}`,
    '',
    '## Roster',
    '',
    ...TEAM_ROLES.map(
      (role) => `- ${role}: ${roster.current[role]?.contributor_id ?? '<!-- vacant -->'}`,
    ),
    '',
    '## Interface',
    '',
    `- Accepts: ${acceptList.length > 0 ? acceptList.join(', ') : '<!-- none -->'}`,
    `- Exposes: ${exposeList.length > 0 ? exposeList.join(', ') : '<!-- none -->'}`,
    '',
    '## Lore',
    '',
    `- Entries: ${lores.length} (${liveLores.length} live)`,
    ...(recentLore.length === 0
      ? ['- <!-- no live Lore -->']
      : recentLore.map((l) => `- [${l.id}] ${l.author_contributor_id}: ${l.body}`)),
    '',
  ].join('\n');
  return `${frontmatter}\n\n${body}`;
}

/**
 * Render a nullable scalar as a YAML value (`null` when absent).
 *
 * User-supplied free-text (charter, terminates_on_milestone) can contain colons,
 * leading special characters, or YAML keyword tokens that would produce invalid or
 * semantically-wrong frontmatter if emitted verbatim.  Anything that does not match
 * the safe-identifier pattern, or that matches a YAML boolean/null keyword, is
 * JSON.stringify'd — valid YAML-1.2 scalar syntax with correct escape handling.
 */
function yamlValue(value: string | null): string {
  if (value === null) return 'null';
  if (
    /^[A-Za-z0-9][\w .@+-]*$/.test(value) &&
    !/^(true|false|null|yes|no|on|off|~)$/i.test(value)
  ) {
    return value;
  }
  return JSON.stringify(value);
}

/** Render a string array as a YAML flow sequence (`[]` when empty). */
function yamlGlobList(globs: string[]): string {
  return globs.length === 0 ? '[]' : `[${globs.map((g) => JSON.stringify(g)).join(', ')}]`;
}

// ---------------------------------------------------------------------------
// show
// ---------------------------------------------------------------------------

async function doShow(store: ScrumStore, slug: string | undefined): Promise<number> {
  if (slug === undefined || slug.length === 0) {
    process.stderr.write('scrum team show: <slug> is required\n');
    return 1;
  }
  const row = await store.getTeam(slug);
  if (row === null) {
    process.stdout.write('null\n');
    process.stderr.write(`scrum team show: no team '${slug}'\n`);
    return 1;
  }
  process.stdout.write(`${JSON.stringify(row)}\n`);
  process.stderr.write(`scrum team show: ${row.slug} (${row.team_type})\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

async function doList(store: ScrumStore, flags: TeamCmdFlags): Promise<number> {
  const rows = await store.listTeams();
  if (flags.human === true) {
    process.stdout.write(renderHumanTable(rows));
  } else {
    process.stdout.write(`${JSON.stringify(rows)}\n`);
  }
  process.stderr.write(`scrum team list: ${rows.length} teams\n`);
  return 0;
}

function renderHumanTable(rows: Team[]): string {
  const header = ['SLUG', 'TYPE', 'LIFETIME', 'STATUS', 'CHARTER'];
  const body = rows.map((r) => [r.slug, r.team_type, r.lifetime, r.status, r.charter ?? '']);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...body.map((cells) => cells[i]?.length ?? 0)),
  );
  const format = (cells: string[]): string =>
    cells.map((c, i) => c.padEnd(widths[i] ?? c.length)).join('  ');
  const lines = [format(header), ...body.map(format)];
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// scope-set / scope-show
// ---------------------------------------------------------------------------

async function doScopeSet(
  store: ScrumStore,
  workspaceRoot: string,
  slug: string | undefined,
  flags: TeamCmdFlags,
): Promise<number> {
  if (slug === undefined || slug.length === 0) {
    process.stderr.write('scrum team scope-set: <slug> is required\n');
    return 1;
  }
  const scopes: TeamScopes = {
    read: parseCsvGlobs(flags.read),
    write: parseCsvGlobs(flags.write),
  };

  // setTeamScopes throws on an unknown slug AND on a cross-team write overlap;
  // both surface as exit 1 via the runTeamCmd catch. The overlap message names
  // both teams and the offending glob(s).
  const saved = await store.setTeamScopes(slug, scopes);

  const row = await store.getTeam(slug);
  if (row === null) {
    process.stderr.write(`scrum team scope-set: no team '${slug}'\n`);
    return 1;
  }
  process.stdout.write(`${JSON.stringify(saved)}\n`);
  let scopeWhere = '';
  try {
    const artifactPath = await reconcileTeamArtifact(store, workspaceRoot, row);
    scopeWhere = ` -> ${artifactPath}`;
  } catch (artifactErr) {
    const msg = artifactErr instanceof Error ? artifactErr.message : String(artifactErr);
    process.stderr.write(`scrum team scope-set: store updated but artifact write failed: ${msg}\n`);
  }
  process.stderr.write(
    `scrum team scope-set: ${slug} read=${saved.read.length} write=${saved.write.length}${scopeWhere}\n`,
  );
  return 0;
}

async function doScopeShow(store: ScrumStore, slug: string | undefined): Promise<number> {
  if (slug === undefined || slug.length === 0) {
    process.stderr.write('scrum team scope-show: <slug> is required\n');
    return 1;
  }
  if ((await store.getTeam(slug)) === null) {
    process.stdout.write('null\n');
    process.stderr.write(`scrum team scope-show: no team '${slug}'\n`);
    return 1;
  }
  const scopes = await store.getTeamScopes(slug);
  process.stdout.write(`${JSON.stringify(scopes)}\n`);
  process.stderr.write(
    `scrum team scope-show: ${slug} read=${scopes.read.length} write=${scopes.write.length}\n`,
  );
  return 0;
}

/**
 * Split a comma-separated `--read`/`--write` flag into trimmed, non-empty globs.
 * An absent or blank flag yields an empty array (clears that scope side).
 */
function parseCsvGlobs(raw: string | undefined): string[] {
  if (raw === undefined || raw.length === 0) return [];
  return raw
    .split(',')
    .map((g) => g.trim())
    .filter((g) => g.length > 0);
}

// ---------------------------------------------------------------------------
// rotate / roster
// ---------------------------------------------------------------------------

async function doRotate(
  store: ScrumStore,
  workspaceRoot: string,
  slug: string | undefined,
  flags: TeamCmdFlags,
): Promise<number> {
  if (slug === undefined || slug.length === 0) {
    process.stderr.write('scrum team rotate: <slug> is required\n');
    return 1;
  }
  const role = normalizeRole(flags.role);
  if (role === INVALID_ENUM) return 1;
  if (role === undefined) {
    process.stderr.write(
      `scrum team rotate: --role <role> is required (one of: ${TEAM_ROLES.join(', ')})\n`,
    );
    return 1;
  }
  if (flags.contributor === undefined || flags.contributor.length === 0) {
    process.stderr.write('scrum team rotate: --contributor <CT-UUID> is required\n');
    return 1;
  }

  // rotateTeamMember throws on an unknown team (and on an invalid role, already
  // guarded above); both surface as exit 1 via the runTeamCmd catch.
  const { row, warning } = await store.rotateTeamMember({
    teamSlug: slug,
    role,
    contributorId: flags.contributor,
    reason: emptyToNull(flags.reason),
  });

  process.stdout.write(`${JSON.stringify(row)}\n`);
  if (warning !== null) {
    process.stderr.write(`scrum team rotate: WARNING: ${warning}\n`);
  }
  let rotateWhere = '';
  const rotatedTeam = await store.getTeam(slug);
  try {
    // The team exists — rotateTeamMember already guarded it — so this is total.
    const artifactPath =
      rotatedTeam !== null ? await reconcileTeamArtifact(store, workspaceRoot, rotatedTeam) : null;
    rotateWhere = artifactPath !== null ? ` -> ${artifactPath}` : '';
  } catch (artifactErr) {
    const msg = artifactErr instanceof Error ? artifactErr.message : String(artifactErr);
    process.stderr.write(`scrum team rotate: store updated but artifact write failed: ${msg}\n`);
  }
  // Rotate changes the resolved CT-UUID the agent protocol references, so the
  // committed agent files must regenerate alongside the bundle.
  if (rotatedTeam !== null) syncTeamAgents(workspaceRoot, rotatedTeam, 'rotate');
  process.stderr.write(
    `scrum team rotate: ${slug} ${row.role} -> ${row.contributor_id} from ${row.from_ts}${rotateWhere}\n`,
  );
  return 0;
}

async function doRoster(store: ScrumStore, slug: string | undefined): Promise<number> {
  if (slug === undefined || slug.length === 0) {
    process.stderr.write('scrum team roster: <slug> is required\n');
    return 1;
  }
  if ((await store.getTeam(slug)) === null) {
    process.stdout.write('null\n');
    process.stderr.write(`scrum team roster: no team '${slug}'\n`);
    return 1;
  }
  const roster = await store.getTeamRoster(slug);
  const filled = TEAM_ROLES.filter((role) => roster.current[role] !== null).length;
  process.stdout.write(`${JSON.stringify(roster)}\n`);
  process.stderr.write(`scrum team roster: ${slug} ${filled}/${TEAM_ROLES.length} slots filled\n`);
  return 0;
}

/**
 * Validate `--role` against the closed `TeamRole` set (case-insensitive).
 * Returns `undefined` when absent, the normalized value when valid, or the
 * `INVALID_ENUM` sentinel (after writing a usage error) when off-vocabulary.
 */
function normalizeRole(raw: string | undefined): TeamRole | undefined | typeof INVALID_ENUM {
  if (raw === undefined || raw.length === 0) return undefined;
  const lower = raw.toLowerCase();
  if (!(TEAM_ROLES as string[]).includes(lower)) {
    process.stderr.write(
      `scrum team rotate: unknown --role '${raw}'. expected one of: ${TEAM_ROLES.join(', ')}\n`,
    );
    return INVALID_ENUM;
  }
  return lower as TeamRole;
}

// ---------------------------------------------------------------------------
// accept-add / accept-supersede / expose-add / expose-supersede / interface (v17)
// ---------------------------------------------------------------------------

async function doAcceptAdd(
  store: ScrumStore,
  workspaceRoot: string,
  slug: string | undefined,
  flags: TeamCmdFlags,
): Promise<number> {
  if (slug === undefined || slug.length === 0) {
    process.stderr.write('scrum team accept-add: <slug> is required\n');
    return 1;
  }
  if (flags.askType === undefined || flags.askType.length === 0) {
    process.stderr.write('scrum team accept-add: --ask-type <kebab> is required\n');
    return 1;
  }

  // addTeamAccept throws on an unknown team AND on a non-kebab ask type; both
  // surface as exit 1 via the runTeamCmd catch.
  const accept = await store.addTeamAccept(slug, flags.askType);

  process.stdout.write(`${JSON.stringify(accept)}\n`);
  let acceptAddWhere = '';
  try {
    const team = await store.getTeam(slug);
    const artifactPath =
      team !== null ? await reconcileTeamArtifact(store, workspaceRoot, team) : null;
    acceptAddWhere = artifactPath !== null ? ` -> ${artifactPath}` : '';
  } catch (artifactErr) {
    const msg = artifactErr instanceof Error ? artifactErr.message : String(artifactErr);
    process.stderr.write(
      `scrum team accept-add: store updated but artifact write failed: ${msg}\n`,
    );
  }
  process.stderr.write(
    `scrum team accept-add: ${slug} accepts '${accept.ask_type}' (id ${accept.id})${acceptAddWhere}\n`,
  );
  return 0;
}

async function doAcceptSupersede(
  store: ScrumStore,
  workspaceRoot: string,
  slug: string | undefined,
  flags: TeamCmdFlags,
): Promise<number> {
  if (slug === undefined || slug.length === 0) {
    process.stderr.write('scrum team accept-supersede: <slug> is required\n');
    return 1;
  }
  const id = parseId(flags.id, 'accept-supersede');
  if (id === null) return 1;
  if (flags.reason === undefined || flags.reason.length === 0) {
    process.stderr.write('scrum team accept-supersede: --reason <text> is required\n');
    return 1;
  }
  const by = parseOptionalId(flags.by, 'accept-supersede');
  if (by === INVALID_ENUM) return 1;

  // supersedeTeamAccept throws on an unknown id and an already-superseded
  // target; both surface as exit 1 via the runTeamCmd catch.
  const accept = await store.supersedeTeamAccept(id, flags.reason, by);

  process.stdout.write(`${JSON.stringify(accept)}\n`);
  let acceptSupWhere = '';
  try {
    const team = await store.getTeam(slug);
    const artifactPath =
      team !== null ? await reconcileTeamArtifact(store, workspaceRoot, team) : null;
    acceptSupWhere = artifactPath !== null ? ` -> ${artifactPath}` : '';
  } catch (artifactErr) {
    const msg = artifactErr instanceof Error ? artifactErr.message : String(artifactErr);
    process.stderr.write(
      `scrum team accept-supersede: store updated but artifact write failed: ${msg}\n`,
    );
  }
  process.stderr.write(
    `scrum team accept-supersede: ${slug} retired accept id ${accept.id} ('${accept.ask_type}')${acceptSupWhere}\n`,
  );
  return 0;
}

async function doExposeAdd(
  store: ScrumStore,
  workspaceRoot: string,
  slug: string | undefined,
  flags: TeamCmdFlags,
): Promise<number> {
  if (slug === undefined || slug.length === 0) {
    process.stderr.write('scrum team expose-add: <slug> is required\n');
    return 1;
  }
  if (flags.name === undefined || flags.name.length === 0) {
    process.stderr.write('scrum team expose-add: --name <n> is required\n');
    return 1;
  }
  if (flags.schemaRef === undefined || flags.schemaRef.length === 0) {
    process.stderr.write('scrum team expose-add: --schema-ref <r> is required\n');
    return 1;
  }

  const expose = await store.addTeamExpose(slug, { name: flags.name, schemaRef: flags.schemaRef });

  process.stdout.write(`${JSON.stringify(expose)}\n`);
  let exposeAddWhere = '';
  try {
    const team = await store.getTeam(slug);
    const artifactPath =
      team !== null ? await reconcileTeamArtifact(store, workspaceRoot, team) : null;
    exposeAddWhere = artifactPath !== null ? ` -> ${artifactPath}` : '';
  } catch (artifactErr) {
    const msg = artifactErr instanceof Error ? artifactErr.message : String(artifactErr);
    process.stderr.write(
      `scrum team expose-add: store updated but artifact write failed: ${msg}\n`,
    );
  }
  process.stderr.write(
    `scrum team expose-add: ${slug} exposes '${expose.name}' (id ${expose.id})${exposeAddWhere}\n`,
  );
  return 0;
}

async function doExposeSupersede(
  store: ScrumStore,
  workspaceRoot: string,
  slug: string | undefined,
  flags: TeamCmdFlags,
): Promise<number> {
  if (slug === undefined || slug.length === 0) {
    process.stderr.write('scrum team expose-supersede: <slug> is required\n');
    return 1;
  }
  const id = parseId(flags.id, 'expose-supersede');
  if (id === null) return 1;
  if (flags.reason === undefined || flags.reason.length === 0) {
    process.stderr.write('scrum team expose-supersede: --reason <text> is required\n');
    return 1;
  }
  const by = parseOptionalId(flags.by, 'expose-supersede');
  if (by === INVALID_ENUM) return 1;

  const expose = await store.supersedeTeamExpose(id, flags.reason, by);

  process.stdout.write(`${JSON.stringify(expose)}\n`);
  let exposeSupWhere = '';
  try {
    const team = await store.getTeam(slug);
    const artifactPath =
      team !== null ? await reconcileTeamArtifact(store, workspaceRoot, team) : null;
    exposeSupWhere = artifactPath !== null ? ` -> ${artifactPath}` : '';
  } catch (artifactErr) {
    const msg = artifactErr instanceof Error ? artifactErr.message : String(artifactErr);
    process.stderr.write(
      `scrum team expose-supersede: store updated but artifact write failed: ${msg}\n`,
    );
  }
  process.stderr.write(
    `scrum team expose-supersede: ${slug} retired expose id ${expose.id} ('${expose.name}')${exposeSupWhere}\n`,
  );
  return 0;
}

async function doInterface(store: ScrumStore, slug: string | undefined): Promise<number> {
  if (slug === undefined || slug.length === 0) {
    process.stderr.write('scrum team interface: <slug> is required\n');
    return 1;
  }
  if ((await store.getTeam(slug)) === null) {
    process.stdout.write('null\n');
    process.stderr.write(`scrum team interface: no team '${slug}'\n`);
    return 1;
  }
  const iface = await store.getTeamInterface(slug);
  process.stdout.write(`${JSON.stringify(iface)}\n`);
  process.stderr.write(
    `scrum team interface: ${slug} accepts=${iface.accepts.length} exposes=${iface.exposes.length}\n`,
  );
  return 0;
}

// ---------------------------------------------------------------------------
// terminate (v18)
// ---------------------------------------------------------------------------

/** Default disband rationale recorded on a manual `terminate` with no --reason. */
const DEFAULT_TERMINATE_REASON = 'team disbanded';

async function doTerminate(
  store: ScrumStore,
  workspaceRoot: string,
  slug: string | undefined,
  flags: TeamCmdFlags,
): Promise<number> {
  if (slug === undefined || slug.length === 0) {
    process.stderr.write('scrum team terminate: <slug> is required\n');
    return 1;
  }
  const reason = emptyToNull(flags.reason) ?? DEFAULT_TERMINATE_REASON;

  // teamTerminate throws on an unknown team and on an already-inactive team;
  // both surface as exit 1 via the runTeamCmd catch.
  const result = await store.teamTerminate(slug, reason);

  process.stdout.write(`${JSON.stringify(result)}\n`);
  let terminateWhere = '';
  try {
    const team = await store.getTeam(slug);
    const artifactPath =
      team !== null ? await reconcileTeamArtifact(store, workspaceRoot, team) : null;
    terminateWhere = artifactPath !== null ? ` -> ${artifactPath}` : '';
  } catch (artifactErr) {
    const msg = artifactErr instanceof Error ? artifactErr.message : String(artifactErr);
    process.stderr.write(`scrum team terminate: store updated but artifact write failed: ${msg}\n`);
  }
  // A disbanded team leaves no live seat behind — drop its agent files so no
  // stale `team-<slug>-<role>.md` survives the termination.
  deleteTeamAgents(workspaceRoot, slug, 'terminate');
  process.stderr.write(
    `scrum team terminate: ${slug} disbanded (scopes cleared=${result.scopesCleared}, exposes retired=${result.exposesRetired}, roster vacated=${result.rosterVacated})${terminateWhere}\n`,
  );
  return 0;
}

// ---------------------------------------------------------------------------
// sync-agents
// ---------------------------------------------------------------------------

/**
 * Regenerate the agent files for active teams. With a `<slug>`, sync that one
 * team (exit 1 on an unknown or inactive slug); without one, sync every active
 * team in the registry. Prints the synced slugs as a JSON array; a count summary
 * on stderr. Idempotent — a re-run marker-merges each file, preserving any
 * authored body.
 */
async function doSyncAgents(
  store: ScrumStore,
  workspaceRoot: string,
  slug: string | undefined,
): Promise<number> {
  let targets: Team[];
  if (slug !== undefined && slug.length > 0) {
    const team = await store.getTeam(slug);
    if (team === null) {
      process.stdout.write('null\n');
      process.stderr.write(`scrum team sync-agents: no team '${slug}'\n`);
      return 1;
    }
    if (team.status !== 'active') {
      process.stdout.write('null\n');
      process.stderr.write(
        `scrum team sync-agents: team '${slug}' is ${team.status}, not active\n`,
      );
      return 1;
    }
    targets = [team];
  } else {
    targets = (await store.listTeams()).filter((team) => team.status === 'active');
  }

  for (const team of targets) {
    syncTeamAgents(workspaceRoot, team, 'sync-agents');
  }

  process.stdout.write(`${JSON.stringify(targets.map((team) => team.slug))}\n`);
  process.stderr.write(`scrum team sync-agents: ${targets.length} teams synced\n`);
  return 0;
}

/**
 * Parse a required `--id` flag to a positive integer. Writes a usage error and
 * returns null when absent or non-numeric — the caller turns null into exit 1.
 */
function parseId(raw: string | undefined, action: string): number | null {
  if (raw === undefined || raw.length === 0) {
    process.stderr.write(`scrum team ${action}: --id <id> is required\n`);
    return null;
  }
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    process.stderr.write(`scrum team ${action}: --id must be a positive integer, got '${raw}'\n`);
    return null;
  }
  return id;
}

/**
 * Parse an optional `--by` replacement id. Returns `undefined` when absent (no
 * named replacement), the integer when valid, or the `INVALID_ENUM` sentinel
 * (after a usage error) when present but non-numeric.
 */
function parseOptionalId(
  raw: string | undefined,
  action: string,
): number | undefined | typeof INVALID_ENUM {
  if (raw === undefined || raw.length === 0) return undefined;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    process.stderr.write(`scrum team ${action}: --by must be a positive integer, got '${raw}'\n`);
    return INVALID_ENUM;
  }
  return id;
}
