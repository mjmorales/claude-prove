/**
 * `claude-prove scrum team <action> [args] [flags]`
 *
 * Action dispatch:
 *   create --slug S --team-type T [--charter C] [--lifetime persistent|terminates_on_milestone]
 *                              Insert the team registry row and scaffold/sync the
 *                              on-disk `teams/<slug>.md` artifact mirroring the
 *                              row. Prints the JSON row.
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
 *
 * Stdout contract: JSON result per action on stdout; one-line human summary on
 * stderr. `list` returns a JSON array (or a table with `--human`).
 *
 * Exit codes:
 *   0  success
 *   1  usage error, unknown action, invalid enum value, duplicate slug, a
 *      `show`/`scope-show` miss, or a write-scope overlap on `scope-set`
 *
 * On-disk reconciliation: `create` writes a `teams/<slug>.md` artifact carrying
 * a YAML frontmatter `schema_version` + `team:` block that embeds the
 * `{slug, team_type, charter, lifetime}` registry fields, so the file mirrors
 * the row. `scope-set` rewrites the same artifact with a `scope:` block carrying
 * the team's `read`/`write` glob arrays.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mainWorktreeRoot } from '@claude-prove/shared';
import { SCRUM_SCHEMA_VERSION } from '../schemas';
import { type ScrumStore, openScrumStore } from '../store';
import type { Team, TeamLifetime, TeamScopes, TeamType } from '../types';
import { TEAM_LIFETIMES, TEAM_TYPES } from '../types';

export interface TeamCmdFlags {
  slug?: string;
  teamType?: string;
  charter?: string;
  lifetime?: string;
  read?: string;
  write?: string;
  human?: boolean;
  workspaceRoot?: string;
}

export type TeamAction = 'create' | 'show' | 'list' | 'scope-set' | 'scope-show';

const TEAM_ACTIONS: TeamAction[] = ['create', 'show', 'list', 'scope-set', 'scope-show'];

export function runTeamCmd(
  action: string,
  args: (string | undefined)[],
  flags: TeamCmdFlags,
): number {
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
  const store = openScrumStore({ override: join(workspaceRoot, '.prove', 'prove.db') });
  try {
    switch (action) {
      case 'create':
        return doCreate(store, workspaceRoot, flags);
      case 'show':
        return doShow(store, args[0]);
      case 'list':
        return doList(store, flags);
      case 'scope-set':
        return doScopeSet(store, workspaceRoot, args[0], flags);
      case 'scope-show':
        return doScopeShow(store, args[0]);
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

function doCreate(store: ScrumStore, workspaceRoot: string, flags: TeamCmdFlags): number {
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

  const row = store.createTeam({
    slug: flags.slug,
    teamType,
    charter: emptyToNull(flags.charter),
    lifetime,
  });

  const scopes = store.getTeamScopes(row.slug);
  const artifactPath = writeTeamArtifact(workspaceRoot, row, scopes);
  process.stdout.write(`${JSON.stringify(row)}\n`);
  process.stderr.write(`scrum team create: ${row.slug} (${row.team_type}) -> ${artifactPath}\n`);
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
 * Write (overwrite) the on-disk `teams/<slug>.md` artifact that mirrors the
 * registry row: a YAML frontmatter `schema_version` + `team:` block carrying the
 * `{slug, team_type, charter, lifetime}` fields plus a `scope:` block carrying
 * the team's read/write glob arrays, plus a human skeleton body. Returns the
 * written path.
 */
function writeTeamArtifact(workspaceRoot: string, row: Team, scopes: TeamScopes): string {
  const dir = join(workspaceRoot, 'teams');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${row.slug}.md`);
  writeFileSync(path, renderTeamArtifact(row, scopes), 'utf8');
  return path;
}

/**
 * Render the team artifact: a YAML frontmatter `team:` + `scope:` block mirroring
 * the row and its scope globs, plus a human skeleton body. The frontmatter is the
 * file's mirror of the `scrum_teams` row and its `scrum_team_scopes` rows.
 */
function renderTeamArtifact(row: Team, scopes: TeamScopes): string {
  const frontmatter = [
    '---',
    `schema_version: ${SCRUM_SCHEMA_VERSION}`,
    'team:',
    `  slug: ${row.slug}`,
    `  team_type: ${row.team_type}`,
    `  charter: ${yamlValue(row.charter)}`,
    `  lifetime: ${row.lifetime}`,
    `  created_at: ${row.created_at}`,
    'scope:',
    `  read: ${yamlGlobList(scopes.read)}`,
    `  write: ${yamlGlobList(scopes.write)}`,
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
    '',
    '## Scope',
    '',
    `- Read globs: ${scopes.read.length > 0 ? scopes.read.join(', ') : '<!-- none -->'}`,
    `- Write globs: ${scopes.write.length > 0 ? scopes.write.join(', ') : '<!-- none -->'}`,
    '',
  ].join('\n');
  return `${frontmatter}\n\n${body}`;
}

/** Render a nullable scalar as a YAML value (`null` when absent). */
function yamlValue(value: string | null): string {
  return value === null ? 'null' : value;
}

/** Render a glob array as a YAML flow sequence (`[]` when empty). */
function yamlGlobList(globs: string[]): string {
  return globs.length === 0 ? '[]' : `[${globs.map((g) => JSON.stringify(g)).join(', ')}]`;
}

// ---------------------------------------------------------------------------
// show
// ---------------------------------------------------------------------------

function doShow(store: ScrumStore, slug: string | undefined): number {
  if (slug === undefined || slug.length === 0) {
    process.stderr.write('scrum team show: <slug> is required\n');
    return 1;
  }
  const row = store.getTeam(slug);
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

function doList(store: ScrumStore, flags: TeamCmdFlags): number {
  const rows = store.listTeams();
  if (flags.human === true) {
    process.stdout.write(renderHumanTable(rows));
  } else {
    process.stdout.write(`${JSON.stringify(rows)}\n`);
  }
  process.stderr.write(`scrum team list: ${rows.length} teams\n`);
  return 0;
}

function renderHumanTable(rows: Team[]): string {
  const header = ['SLUG', 'TYPE', 'LIFETIME', 'CHARTER'];
  const body = rows.map((r) => [r.slug, r.team_type, r.lifetime, r.charter ?? '']);
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

function doScopeSet(
  store: ScrumStore,
  workspaceRoot: string,
  slug: string | undefined,
  flags: TeamCmdFlags,
): number {
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
  const saved = store.setTeamScopes(slug, scopes);

  const row = store.getTeam(slug);
  if (row === null) {
    process.stderr.write(`scrum team scope-set: no team '${slug}'\n`);
    return 1;
  }
  const artifactPath = writeTeamArtifact(workspaceRoot, row, saved);
  process.stdout.write(`${JSON.stringify(saved)}\n`);
  process.stderr.write(
    `scrum team scope-set: ${slug} read=${saved.read.length} write=${saved.write.length} -> ${artifactPath}\n`,
  );
  return 0;
}

function doScopeShow(store: ScrumStore, slug: string | undefined): number {
  if (slug === undefined || slug.length === 0) {
    process.stderr.write('scrum team scope-show: <slug> is required\n');
    return 1;
  }
  if (store.getTeam(slug) === null) {
    process.stdout.write('null\n');
    process.stderr.write(`scrum team scope-show: no team '${slug}'\n`);
    return 1;
  }
  const scopes = store.getTeamScopes(slug);
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
