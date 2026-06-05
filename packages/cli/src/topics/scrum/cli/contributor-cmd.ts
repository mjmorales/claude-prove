/**
 * `claude-prove scrum contributor <action> [args] [flags]`
 *
 * Action dispatch:
 *   register --slug S [--display-name N] [--github G] [--email E] [--id CT-UUID] [--status active|inactive]
 *                              Mint a CT-UUID (or accept an explicit --id), insert
 *                              the registry row, and scaffold/sync the on-disk
 *                              `contributors/<slug>.md` identity artifact — a
 *                              missing file gets the full skeleton; an existing
 *                              file gets the registry frontmatter MERGED in with
 *                              its authored body preserved. Prints the JSON row.
 *                              IDEMPOTENT on slug: re-running against an existing
 *                              slug reconciles the row (provided flags override
 *                              the stored fields, unset flags preserve them) and
 *                              re-emits/merges the artifact, so a bare re-register
 *                              repairs a missing identity file. A provided --id
 *                              must match the registered CT-UUID — a mismatch
 *                              errors, the id is minted once and never changed.
 *   list                       [--status active|inactive] [--human]
 *                              List the registry, ordered by slug.
 *   resolve [--github G] [--email E]
 *                              Map a worker / event author to a contributor —
 *                              github match first, then email fallback. Prints the
 *                              matched JSON row, or exits 1 on a miss.
 *   default <set|show> [--project-root P] [--id CT-UUID]
 *                              Per-user (home-dir) project-root → default
 *                              contributor mapping — the "active contributor is
 *                              implicit per project" mechanism. `set` records the
 *                              mapping (requires --id); `show` prints the resolved
 *                              CT-UUID, or `null` when the root is unmapped. This
 *                              verb is store-INDEPENDENT: it never opens
 *                              `.prove/prove.db`. `set` writes to the machine-global
 *                              `~/.claude-prove/config.json` only; `show` resolves
 *                              from that location and falls back per-key to the
 *                              legacy XDG location
 *                              (`${XDG_CONFIG_HOME:-~/.config}/claude-prove/config.json`)
 *                              so an un-migrated machine still resolves. The
 *                              CT-UUID is stored verbatim and is NOT validated
 *                              against any single project's registry, since the
 *                              config spans every project on the machine.
 *
 * Stdout contract: JSON result per action on stdout; one-line human summary on
 * stderr. `list` returns a JSON array (or a table with `--human`).
 *
 * Exit codes:
 *   0  success
 *   1  usage error, unknown action, an --id conflicting with the registered
 *      CT-UUID, or a resolve miss
 *
 * On-disk reconciliation: `register` extends the SAME `contributor` identity
 * artifact that `install bootstrap-identity` scaffolds — a markdown file under
 * `contributors/<slug>.md` carrying a YAML frontmatter `schema_version` +
 * `provenance` block. The `{id, slug, status, display_name, github, email}`
 * registry fields are embedded into that frontmatter so the file mirrors the
 * row. There is no second, competing contributor-file concept.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mainWorktreeRoot } from '@claude-prove/shared';
import { resolveDefaultContributor, setDefaultContributor } from '@claude-prove/store';
import { renderProvenanceFrontmatter } from '../../install/bootstrap-identity';
import type { ScrumStore } from '../store';
import type { Contributor, ContributorStatus } from '../types';
import { CONTRIBUTOR_STATUSES } from '../types';
import { openCliStore } from './cli-store';

export interface ContributorCmdFlags {
  slug?: string;
  id?: string;
  status?: string;
  displayName?: string;
  github?: string;
  email?: string;
  human?: boolean;
  workspaceRoot?: string;
  // `default <set|show>` project-root → default-contributor mapping.
  projectRoot?: string;
  // Test seam for `default`: an explicit machine-config base dir (the
  // `~/.claude-prove` root) so tests never touch the developer's real home
  // dotfile. Unset in production. Threaded as the machine-config write/read
  // root for both `set` and `show`.
  configBase?: string;
  // Test seam for `default show`: an explicit legacy XDG base dir (the parent
  // of `claude-prove/`) so a legacy-only fallback can be exercised without
  // mutating `XDG_CONFIG_HOME`. Unset in production. Threaded only into the
  // `show` read path's legacy fallback.
  legacyConfigBase?: string;
}

export type ContributorAction = 'register' | 'list' | 'resolve' | 'default';

const CONTRIBUTOR_ACTIONS: ContributorAction[] = ['register', 'list', 'resolve', 'default'];

export function runContributorCmd(
  action: string,
  flags: ContributorCmdFlags,
  subAction?: string,
): number {
  if (!isContributorAction(action)) {
    process.stderr.write(
      `error: unknown contributor action '${action}'. expected one of: ${CONTRIBUTOR_ACTIONS.join(', ')}\n`,
    );
    return 1;
  }

  // `default` is store-INDEPENDENT: it reads/writes the machine-global home-dir
  // config and never opens `.prove/prove.db`, so it is dispatched before the
  // store is opened. The config spans every project on the machine.
  if (action === 'default') {
    return runDefaultCmd(subAction, flags);
  }

  const workspaceRoot =
    flags.workspaceRoot && flags.workspaceRoot.length > 0
      ? flags.workspaceRoot
      : (mainWorktreeRoot() ?? process.cwd());
  const store = openCliStore(workspaceRoot);
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

  // Idempotent on slug: a fresh slug inserts, an existing one reconciles —
  // provided flags override the stored fields, unset flags preserve them, and
  // the artifact write below re-emits/merges either way. This is the repair
  // path for a registry row whose identity artifact was never emitted or was
  // lost; an --id conflicting with the registered CT-UUID throws in the store.
  const existing = store.getContributorBySlug(flags.slug);
  const row =
    existing === null
      ? store.registerContributor({
          slug: flags.slug,
          id: flags.id,
          status,
          displayName: emptyToNull(flags.displayName),
          github: emptyToNull(flags.github),
          email: emptyToNull(flags.email),
        })
      : store.reconcileContributor({
          slug: flags.slug,
          id: emptyToUndefined(flags.id),
          status,
          displayName: emptyToUndefined(flags.displayName),
          github: emptyToUndefined(flags.github),
          email: emptyToUndefined(flags.email),
        });

  const artifactPath = writeContributorArtifact(workspaceRoot, row);
  process.stdout.write(`${JSON.stringify(row)}\n`);
  const mode = existing === null ? '' : ' (reconciled)';
  process.stderr.write(
    `scrum contributor register: ${row.id} (${row.slug}) -> ${artifactPath}${mode}\n`,
  );
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
 * Coerce an empty/unset flag to undefined for the reconcile path, where
 * `undefined` means "preserve the stored value" rather than "set to null".
 */
function emptyToUndefined(raw: string | undefined): string | undefined {
  return raw !== undefined && raw.length > 0 ? raw : undefined;
}

/**
 * Write the on-disk `contributors/<slug>.md` identity artifact that mirrors
 * the registry row. Extends the `install bootstrap-identity` contributor file
 * shape: a YAML frontmatter `schema_version` + `provenance` block, with the
 * `{id, slug, status, display_name, github, email}` registry fields embedded
 * so the file and the row carry one schema. An ABSENT file gets the full
 * skeleton; an EXISTING file (bootstrap-scaffolded or human-authored) gets the
 * registry fields MERGED into its frontmatter with the authored body preserved
 * verbatim — register repairs the registry mirror, it never clobbers authored
 * content. Returns the written path.
 */
function writeContributorArtifact(workspaceRoot: string, row: Contributor): string {
  const dir = join(workspaceRoot, 'contributors');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${row.slug}.md`);
  const content = existsSync(path)
    ? mergeContributorArtifact(readFileSync(path, 'utf8'), row)
    : renderContributorArtifact(row);
  writeFileSync(path, content, 'utf8');
  return path;
}

/**
 * The `contributor:` frontmatter field block — the file's mirror of the
 * `scrum_contributors` row. Shared by the fresh render and the merge path so
 * both emit one shape.
 */
function contributorBlockLines(row: Contributor): string[] {
  return [
    'contributor:',
    `  id: ${row.id}`,
    `  slug: ${row.slug}`,
    `  status: ${row.status}`,
    `  display_name: ${yamlValue(row.display_name)}`,
    `  github: ${yamlValue(row.github)}`,
    `  email: ${yamlValue(row.email)}`,
  ];
}

/**
 * Render the contributor identity artifact from scratch: the provenance
 * frontmatter the bootstrap scaffolder emits, with the `contributor:` block
 * carrying the registry fields, plus a human skeleton body.
 */
function renderContributorArtifact(row: Contributor): string {
  const frontmatter = renderProvenanceFrontmatter(row.created_at);
  // Splice the contributor field block into the rendered frontmatter, just
  // before its closing `---`, so the file stays a single YAML block.
  // Anchor on `\n---` to avoid matching the opening fence, then advance past
  // the newline so the injected block lands on its own line.
  const closing = frontmatter.lastIndexOf('\n---');
  if (closing < 0) {
    throw new Error('renderContributorArtifact: provenance frontmatter has no closing --- marker');
  }
  const head = frontmatter.slice(0, closing + 1);
  const contributorBlock = [...contributorBlockLines(row), '---'].join('\n');
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

/** Matches a leading YAML frontmatter block: opening fence, inner lines, closing fence. */
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---(\n|$)/;

/**
 * Merge the registry row into an EXISTING artifact, preserving its authored
 * body byte-for-byte. Two shapes arrive here:
 *
 *   - Frontmatter-headed (the bootstrap scaffold, or a prior register): any
 *     stale `contributor:` block is dropped from the frontmatter, the fresh
 *     block is spliced in before the closing fence, the `last_modified_by` /
 *     `last_modified_at` provenance pair is bumped to mirror the row, and
 *     every other frontmatter line plus the whole body pass through verbatim.
 *   - Bare markdown (no frontmatter): a fresh provenance + contributor
 *     frontmatter is prepended above the existing content, which becomes the
 *     body unchanged.
 */
function mergeContributorArtifact(existing: string, row: Contributor): string {
  const match = existing.match(FRONTMATTER_RE);
  if (match === null) {
    const frontmatter = renderProvenanceFrontmatter(row.created_at);
    const closing = frontmatter.lastIndexOf('\n---');
    if (closing < 0) {
      throw new Error('mergeContributorArtifact: provenance frontmatter has no closing --- marker');
    }
    const head = frontmatter.slice(0, closing + 1);
    return `${head}${[...contributorBlockLines(row), '---'].join('\n')}\n\n${existing}`;
  }

  const inner = match[1] ?? '';
  const body = existing.slice(match[0].length);

  // Drop any existing `contributor:` block (the key plus its indented
  // children) — the fresh block re-asserts the registry mirror.
  const kept: string[] = [];
  let inContributorBlock = false;
  for (const line of inner.split('\n')) {
    if (/^contributor:\s*$/.test(line)) {
      inContributorBlock = true;
      continue;
    }
    if (inContributorBlock && /^\s+\S/.test(line)) continue;
    inContributorBlock = false;
    kept.push(line);
  }

  // Bump the last-touch provenance pair to mirror the row: register modified
  // this artifact. Created-* lines stay as the file's original scaffold stamp.
  const updated = kept.map((line) => {
    if (/^ {2}last_modified_by:/.test(line)) {
      return `  last_modified_by: ${yamlValue(row.last_modified_by)}`;
    }
    if (/^ {2}last_modified_at:/.test(line)) {
      return `  last_modified_at: ${row.last_modified_at}`;
    }
    return line;
  });

  const frontmatter = ['---', ...updated, ...contributorBlockLines(row), '---'].join('\n');
  return `${frontmatter}\n${body}`;
}

/**
 * Render a nullable scalar as a safe YAML value. Plain scalars are emitted
 * verbatim when they consist only of word characters, dots, spaces, and common
 * identifier punctuation, and do not collide with YAML boolean/null keywords.
 * Anything else — free-text display names, RFC-permitted email local parts,
 * strings with colons, leading special characters, or keyword collisions — is
 * emitted as a JSON double-quoted string, which is valid YAML-1.2 scalar syntax
 * with correct escape handling.
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

// ---------------------------------------------------------------------------
// default — per-user project-root → default contributor mapping (home-dir)
// ---------------------------------------------------------------------------

type DefaultSubAction = 'set' | 'show';

const DEFAULT_SUB_ACTIONS: DefaultSubAction[] = ['set', 'show'];

/**
 * Dispatch `contributor default <set|show>`. Store-independent — the mapping
 * lives in the machine-global home-dir config, not `.prove/prove.db`.
 * `--project-root` defaults to the current working directory (the git worktree
 * / repo root the operator is driving from).
 */
function runDefaultCmd(subAction: string | undefined, flags: ContributorCmdFlags): number {
  if (subAction === undefined || !isDefaultSubAction(subAction)) {
    process.stderr.write(
      `error: scrum contributor default: sub-action required (one of: ${DEFAULT_SUB_ACTIONS.join(' | ')})\n`,
    );
    return 1;
  }

  const projectRoot =
    flags.projectRoot !== undefined && flags.projectRoot.length > 0
      ? flags.projectRoot
      : process.cwd();

  try {
    switch (subAction) {
      case 'set':
        return doDefaultSet(projectRoot, flags);
      case 'show':
        return doDefaultShow(projectRoot, flags);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`scrum contributor default ${subAction}: ${msg}\n`);
    return 1;
  }
}

function isDefaultSubAction(value: string): value is DefaultSubAction {
  return (DEFAULT_SUB_ACTIONS as string[]).includes(value);
}

function doDefaultSet(projectRoot: string, flags: ContributorCmdFlags): number {
  const id = emptyToNull(flags.id);
  if (id === null) {
    process.stderr.write('scrum contributor default set: --id <CT-UUID> is required\n');
    return 1;
  }

  // Writes go to the machine-global `~/.claude-prove/config.json` only
  // (`configBase` is the test seam for that root); the legacy XDG location is a
  // read-only fallback, so `set` never touches it.
  const key = setDefaultContributor(projectRoot, id, flags.configBase);
  process.stdout.write(`${JSON.stringify({ project_root: key, contributor_id: id })}\n`);
  process.stderr.write(`scrum contributor default set: ${key} -> ${id}\n`);
  return 0;
}

function doDefaultShow(projectRoot: string, flags: ContributorCmdFlags): number {
  // Resolves the machine-global location first, then falls back per-key to the
  // legacy XDG location so an un-migrated machine still resolves. `configBase`
  // / `legacyConfigBase` are the test seams for the two roots.
  const id = resolveDefaultContributor(projectRoot, flags.configBase, flags.legacyConfigBase);
  process.stdout.write(`${id === null ? 'null' : JSON.stringify(id)}\n`);
  const where = id === null ? '(unmapped)' : id;
  process.stderr.write(`scrum contributor default show: ${projectRoot} -> ${where}\n`);
  return 0;
}
