/**
 * `claude-prove scrum contributor <action> [args] [flags]`
 *
 * Action dispatch:
 *   register --slug S [--display-name N] [--github G] [--email E] [--id CT-UUID] [--status active|inactive]
 *                              Mint a CT-UUID (or accept an explicit --id), insert
 *                              the registry row, and scaffold/sync the on-disk
 *                              `contributors/<slug>.md` identity artifact. Prints
 *                              the JSON row.
 *   list                       [--status active|inactive] [--human]
 *                              List the registry, ordered by slug.
 *   resolve [--github G] [--email E]
 *                              Map a worker / event author to a contributor —
 *                              github match first, then email fallback. Prints the
 *                              matched JSON row, or exits 1 on a miss.
 *
 * Stdout contract: JSON result per action on stdout; one-line human summary on
 * stderr. `list` returns a JSON array (or a table with `--human`).
 *
 * Exit codes:
 *   0  success
 *   1  usage error, unknown action, duplicate slug, or a resolve miss
 *
 * On-disk reconciliation: `register` extends the SAME `contributor` identity
 * artifact that `install bootstrap-identity` scaffolds — a markdown file under
 * `contributors/<slug>.md` carrying a YAML frontmatter `schema_version` +
 * `provenance` block. The `{id, slug, status, display_name, github, email}`
 * registry fields are embedded into that frontmatter so the file mirrors the
 * row. There is no second, competing contributor-file concept.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mainWorktreeRoot } from '@claude-prove/shared';
import { renderProvenanceFrontmatter } from '../../install/bootstrap-identity';
import { type ScrumStore, openScrumStore } from '../store';
import type { Contributor, ContributorStatus } from '../types';
import { CONTRIBUTOR_STATUSES } from '../types';

export interface ContributorCmdFlags {
  slug?: string;
  id?: string;
  status?: string;
  displayName?: string;
  github?: string;
  email?: string;
  human?: boolean;
  workspaceRoot?: string;
}

export type ContributorAction = 'register' | 'list' | 'resolve';

const CONTRIBUTOR_ACTIONS: ContributorAction[] = ['register', 'list', 'resolve'];

export function runContributorCmd(action: string, flags: ContributorCmdFlags): number {
  if (!isContributorAction(action)) {
    process.stderr.write(
      `error: unknown contributor action '${action}'. expected one of: ${CONTRIBUTOR_ACTIONS.join(', ')}\n`,
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
      case 'register':
        return doRegister(store, workspaceRoot, flags);
      case 'list':
        return doList(store, flags);
      case 'resolve':
        return doResolve(store, flags);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`scrum contributor ${action}: ${msg}\n`);
    return 1;
  } finally {
    store.close();
  }
}

function isContributorAction(value: string): value is ContributorAction {
  return (CONTRIBUTOR_ACTIONS as string[]).includes(value);
}

// ---------------------------------------------------------------------------
// register
// ---------------------------------------------------------------------------

function doRegister(store: ScrumStore, workspaceRoot: string, flags: ContributorCmdFlags): number {
  if (flags.slug === undefined || flags.slug.length === 0) {
    process.stderr.write('scrum contributor register: --slug <slug> is required\n');
    return 1;
  }
  const status = normalizeStatus(flags.status);
  if (status === INVALID_STATUS) return 1;

  const row = store.registerContributor({
    slug: flags.slug,
    id: flags.id,
    status,
    displayName: emptyToNull(flags.displayName),
    github: emptyToNull(flags.github),
    email: emptyToNull(flags.email),
  });

  const artifactPath = writeContributorArtifact(workspaceRoot, row);
  process.stdout.write(`${JSON.stringify(row)}\n`);
  process.stderr.write(`scrum contributor register: ${row.id} (${row.slug}) -> ${artifactPath}\n`);
  return 0;
}

/** Sentinel distinguishing "invalid status given" from "no status given". */
const INVALID_STATUS = Symbol('invalid-status');

/**
 * Validate `--status` against the closed `active | inactive` set
 * (case-insensitive). Returns `undefined` when absent (the store defaults to
 * `active`), the normalized value when valid, or the `INVALID_STATUS` sentinel
 * (after writing a usage error) when off-vocabulary.
 */
function normalizeStatus(
  raw: string | undefined,
): ContributorStatus | undefined | typeof INVALID_STATUS {
  if (raw === undefined || raw.length === 0) return undefined;
  const lower = raw.toLowerCase();
  if (!(CONTRIBUTOR_STATUSES as string[]).includes(lower)) {
    process.stderr.write(
      `scrum contributor register: unknown --status '${raw}'. expected one of: ${CONTRIBUTOR_STATUSES.join(', ')}\n`,
    );
    return INVALID_STATUS;
  }
  return lower as ContributorStatus;
}

/** Coerce an empty-string flag to null so blank flags read as "unset". */
function emptyToNull(raw: string | undefined): string | null {
  return raw !== undefined && raw.length > 0 ? raw : null;
}

/**
 * Write (overwrite) the on-disk `contributors/<slug>.md` identity artifact that
 * mirrors the registry row. Extends the `install bootstrap-identity` contributor
 * file shape: a YAML frontmatter `schema_version` + `provenance` block, with the
 * `{id, slug, status, display_name, github, email}` registry fields embedded so
 * the file and the row carry one schema. Returns the written path.
 */
function writeContributorArtifact(workspaceRoot: string, row: Contributor): string {
  const dir = join(workspaceRoot, 'contributors');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${row.slug}.md`);
  writeFileSync(path, renderContributorArtifact(row), 'utf8');
  return path;
}

/**
 * Render the contributor identity artifact: the provenance frontmatter the
 * bootstrap scaffolder emits, with a `contributor:` block carrying the registry
 * fields, plus a human skeleton body. The `contributor:` block is the file's
 * mirror of the `scrum_contributors` row.
 */
function renderContributorArtifact(row: Contributor): string {
  const frontmatter = renderProvenanceFrontmatter(row.created_at);
  // Splice the contributor field block into the rendered frontmatter, just
  // before its closing `---`, so the file stays a single YAML block.
  const closing = frontmatter.lastIndexOf('---');
  const head = frontmatter.slice(0, closing);
  const contributorBlock = [
    'contributor:',
    `  id: ${row.id}`,
    `  slug: ${row.slug}`,
    `  status: ${row.status}`,
    `  display_name: ${yamlValue(row.display_name)}`,
    `  github: ${yamlValue(row.github)}`,
    `  email: ${yamlValue(row.email)}`,
    '---',
  ].join('\n');
  const body = [
    `# Contributor: ${row.display_name ?? row.slug}`,
    '',
    '## Identity',
    '',
    `- Slug: ${row.slug}`,
    `- GitHub: ${row.github ?? '(unset)'}`,
    `- Email: ${row.email ?? '(unset)'}`,
    '',
    '## Focus',
    '',
    '<!-- Areas of ownership and current focus. -->',
    '',
  ].join('\n');
  return `${head}${contributorBlock}\n\n${body}`;
}

/** Render a nullable scalar as a YAML value (`null` when absent). */
function yamlValue(value: string | null): string {
  return value === null ? 'null' : value;
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

function doList(store: ScrumStore, flags: ContributorCmdFlags): number {
  const status = normalizeStatus(flags.status);
  if (status === INVALID_STATUS) return 1;

  const rows = store.listContributors(status);
  if (flags.human === true) {
    process.stdout.write(renderHumanTable(rows));
  } else {
    process.stdout.write(`${JSON.stringify(rows)}\n`);
  }
  process.stderr.write(`scrum contributor list: ${rows.length} contributors\n`);
  return 0;
}

function renderHumanTable(rows: Contributor[]): string {
  const header = ['ID', 'SLUG', 'STATUS', 'GITHUB', 'EMAIL'];
  const body = rows.map((r) => [r.id, r.slug, r.status, r.github ?? '', r.email ?? '']);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...body.map((cells) => cells[i]?.length ?? 0)),
  );
  const format = (cells: string[]): string =>
    cells.map((c, i) => c.padEnd(widths[i] ?? c.length)).join('  ');
  const lines = [format(header), ...body.map(format)];
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// resolve — github match first, then email fallback
// ---------------------------------------------------------------------------

function doResolve(store: ScrumStore, flags: ContributorCmdFlags): number {
  const github = emptyToNull(flags.github);
  const email = emptyToNull(flags.email);
  if (github === null && email === null) {
    process.stderr.write(
      'scrum contributor resolve: at least one of --github or --email is required\n',
    );
    return 1;
  }

  const row = store.resolveContributor({ github, email });
  if (row === null) {
    const probe = [github ? `github=${github}` : null, email ? `email=${email}` : null]
      .filter((p) => p !== null)
      .join(' ');
    process.stdout.write('null\n');
    process.stderr.write(`scrum contributor resolve: no match (${probe})\n`);
    return 1;
  }

  const matchedOn = github !== null && lowerEq(row.github, github) ? 'github' : 'email';
  process.stdout.write(`${JSON.stringify(row)}\n`);
  process.stderr.write(`scrum contributor resolve: ${row.id} (${row.slug}) via ${matchedOn}\n`);
  return 0;
}

/** Case-insensitive equality treating a null left side as non-matching. */
function lowerEq(a: string | null, b: string): boolean {
  return a !== null && a.toLowerCase() === b.toLowerCase();
}
