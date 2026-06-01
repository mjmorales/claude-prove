/**
 * `claude-prove install bootstrap-identity` — mechanical half of the
 * project-identity bootstrap that `/prove:init` drives.
 *
 * Splits along the engine/model boundary: this CLI owns the mechanical
 * pre-flight checks and the skip-if-exists file scaffolding; the slash
 * command owns the conversational Q&A and authors the artifact content.
 *
 * Pre-flight checks (each failure carries a concrete fix):
 *   1. inside a git work tree        — fix: `git init`
 *   2. clean working tree            — fix: commit or stash first
 *   3. on an integration branch      — fix: switch to main/master
 *   4. `claude-prove` resolves on PATH — fix: install/symlink the binary
 *
 * Upgrade-preserve: each of `charter.md`, `team.md`, and a contributor
 * record is scaffolded ONLY when absent. An existing artifact is reported
 * `skipped` and never overwritten, so re-running adds only what is missing.
 *
 * Every scaffolded artifact carries a YAML frontmatter `schema_version`
 * plus a `provenance` block (`created_by`, `created_at`, `last_modified_by`,
 * `last_modified_at`) — the file-artifact mirror of the scrum row provenance.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { currentBranch, worktreeRoot } from '@claude-prove/shared/git';

/** Schema version stamped into the frontmatter of every identity artifact. */
export const IDENTITY_ARTIFACT_SCHEMA_VERSION = 1;

/** Branch names treated as integration branches (bootstrap is allowed here). */
const INTEGRATION_BRANCHES: readonly string[] = ['main', 'master'];

/** Which identity artifacts a single bootstrap run may produce. */
export type IdentityArtifactKind = 'charter' | 'team' | 'contributor';

/** Per-artifact disposition after a bootstrap run. */
export type ArtifactDisposition = 'created' | 'skipped';

export interface BootstrapIdentityOptions {
  /** Project root that owns the artifacts (default: cwd). */
  cwd?: string;
  /** Which artifacts to scaffold; an empty set scaffolds nothing. */
  artifacts: ReadonlySet<IdentityArtifactKind>;
  /** Contributor identity slug (e.g. `jane-doe`); required for `contributor`. */
  contributorId?: string;
  /** Run pre-flight checks only; report what would happen without writing. */
  dryRun?: boolean;
}

/** A single failed pre-flight check paired with its concrete fix. */
export interface PreflightFailure {
  check: string;
  detail: string;
  fix: string;
}

/** One artifact's outcome: its path and whether it was created or skipped. */
export interface ArtifactResult {
  kind: IdentityArtifactKind;
  path: string;
  disposition: ArtifactDisposition;
}

/** Machine-readable result of a bootstrap run. */
export interface BootstrapIdentityResult {
  ok: boolean;
  preflightFailures: PreflightFailure[];
  artifacts: ArtifactResult[];
}

/**
 * Run the four pre-flight checks against `cwd`. Returns every failure (not
 * just the first) so the operator can fix them in one pass. An empty array
 * means the project is ready to bootstrap.
 */
export function runPreflight(cwd: string): PreflightFailure[] {
  const failures: PreflightFailure[] = [];

  const root = worktreeRoot(cwd);
  if (root === null) {
    failures.push({
      check: 'git-root',
      detail: 'not inside a git work tree',
      fix: 'run `git init` (or cd into the repository root) before bootstrapping',
    });
    // Branch / clean-tree checks are meaningless without a repo — stop here.
    appendCliOnPathFailure(failures);
    return failures;
  }

  if (!isWorkingTreeClean(cwd)) {
    failures.push({
      check: 'clean-tree',
      detail: 'working tree has uncommitted changes',
      fix: 'commit or stash your changes so the bootstrap commit stays isolated',
    });
  }

  const branch = currentBranch(cwd);
  if (branch === null || !INTEGRATION_BRANCHES.includes(branch)) {
    const where = branch === null ? 'a detached HEAD' : `branch '${branch}'`;
    failures.push({
      check: 'integration-branch',
      detail: `on ${where}, not an integration branch`,
      fix: `switch to an integration branch (${INTEGRATION_BRANCHES.join(' or ')}) before bootstrapping`,
    });
  }

  appendCliOnPathFailure(failures);
  return failures;
}

/** Push a CLI-on-PATH failure when `claude-prove` does not resolve. */
function appendCliOnPathFailure(failures: PreflightFailure[]): void {
  if (cliOnPath()) return;
  failures.push({
    check: 'cli-on-path',
    detail: '`claude-prove` does not resolve on PATH',
    fix: 'install or symlink the `claude-prove` binary onto your PATH',
  });
}

/** True when `git status --porcelain` reports no changes (clean tree). */
function isWorkingTreeClean(cwd: string): boolean {
  try {
    const proc = Bun.spawnSync({
      cmd: ['git', 'status', '--porcelain'],
      cwd,
      stdout: 'pipe',
      stderr: 'ignore',
    });
    if (proc.exitCode !== 0) return false;
    return proc.stdout.toString().trim().length === 0;
  } catch {
    return false;
  }
}

/** True when a `claude-prove` executable is resolvable on PATH. */
function cliOnPath(): boolean {
  try {
    const proc = Bun.spawnSync({
      cmd: ['command', '-v', 'claude-prove'],
      stdout: 'pipe',
      stderr: 'ignore',
    });
    if (proc.exitCode === 0 && proc.stdout.toString().trim().length > 0) return true;
  } catch {
    // fall through to the `which` probe
  }
  try {
    const proc = Bun.spawnSync({
      cmd: ['which', 'claude-prove'],
      stdout: 'pipe',
      stderr: 'ignore',
    });
    return proc.exitCode === 0 && proc.stdout.toString().trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Render the YAML frontmatter `schema_version` + `provenance` block that
 * heads every identity artifact. `created_by` and `last_modified_by` are
 * sourced from the run env (`PROVE_AGENT`), defaulting to `null` when no
 * agent context is in scope. `created_at` and `last_modified_at` are the
 * same ISO-8601 instant at creation (seeded identically, mirroring the
 * scrum row provenance).
 */
export function renderProvenanceFrontmatter(now: string = new Date().toISOString()): string {
  const agent = process.env.PROVE_AGENT ?? null;
  const by = agent === null ? 'null' : agent;
  return [
    '---',
    `schema_version: ${IDENTITY_ARTIFACT_SCHEMA_VERSION}`,
    'provenance:',
    `  created_by: ${by}`,
    `  created_at: ${now}`,
    `  last_modified_by: ${by}`,
    `  last_modified_at: ${now}`,
    '---',
  ].join('\n');
}

/** Skeleton body the slash command fills in with authored content. */
function skeletonBody(kind: IdentityArtifactKind, contributorId?: string): string {
  switch (kind) {
    case 'charter':
      return [
        '# Project Charter',
        '',
        '## Vision',
        '',
        '<!-- The future state this project moves toward. -->',
        '',
        '## Mission',
        '',
        '<!-- What the project does, for whom, and why. -->',
        '',
        '## Outcome Bet',
        '',
        '<!-- The measurable outcome this project is betting on. -->',
        '',
      ].join('\n');
    case 'team':
      return [
        '# Team',
        '',
        '## Roster',
        '',
        '<!-- One row per member: name, role, responsibilities. -->',
        '',
        '| Name | Role | Responsibilities |',
        '| ---- | ---- | ---------------- |',
        '',
      ].join('\n');
    case 'contributor':
      return [
        `# Contributor: ${contributorId ?? ''}`,
        '',
        '## Identity',
        '',
        '<!-- Name, handle, role on this project. -->',
        '',
        '## Focus',
        '',
        '<!-- Areas of ownership and current focus. -->',
        '',
      ].join('\n');
  }
}

/**
 * Resolve the on-disk path for an artifact relative to `root`. Charter and
 * team live at the project root; a contributor record lives under
 * `contributors/<id>.md` so multiple operators each get an isolated file.
 */
function artifactPath(root: string, kind: IdentityArtifactKind, contributorId: string): string {
  if (kind === 'contributor') return join(root, 'contributors', `${contributorId}.md`);
  return join(root, `${kind}.md`);
}

/**
 * Scaffold the requested identity artifacts under `cwd` behind the
 * pre-flight gate. Returns a structured result; never throws on a failed
 * check or an existing artifact. Writing is skipped entirely when any
 * pre-flight check fails or when `dryRun` is set.
 */
export function bootstrapIdentity(opts: BootstrapIdentityOptions): BootstrapIdentityResult {
  const root = resolve(opts.cwd ?? process.cwd());
  const preflightFailures = runPreflight(root);

  if (preflightFailures.length > 0) {
    return { ok: false, preflightFailures, artifacts: [] };
  }

  const now = new Date().toISOString();
  const frontmatter = renderProvenanceFrontmatter(now);
  const artifacts: ArtifactResult[] = [];

  for (const kind of opts.artifacts) {
    const contributorId = kind === 'contributor' ? (opts.contributorId ?? '') : '';
    const path = artifactPath(root, kind, contributorId);

    if (existsSync(path)) {
      artifacts.push({ kind, path, disposition: 'skipped' });
      continue;
    }

    if (!opts.dryRun) {
      mkdirSync(join(path, '..'), { recursive: true });
      const content = `${frontmatter}\n\n${skeletonBody(kind, contributorId)}`;
      writeFileSync(path, content, 'utf8');
    }
    artifacts.push({ kind, path, disposition: 'created' });
  }

  return { ok: true, preflightFailures, artifacts };
}
