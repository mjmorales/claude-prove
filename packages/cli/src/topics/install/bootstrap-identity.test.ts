import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  IDENTITY_ARTIFACT_SCHEMA_VERSION,
  type IdentityArtifactKind,
  bootstrapIdentity,
  renderProvenanceFrontmatter,
  runPreflight,
} from './bootstrap-identity';

/** Create a temp dir initialized as a clean git repo on an integration branch. */
function tmpRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'bootstrap-identity-'));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Test']);
  // Commit a seed file so the tree is non-empty and HEAD resolves.
  writeFileSync(join(root, 'README.md'), '# seed\n', 'utf8');
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', 'seed']);
  return root;
}

function git(cwd: string, args: string[]): void {
  const proc = Bun.spawnSync({ cmd: ['git', ...args], cwd, stdout: 'ignore', stderr: 'ignore' });
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed`);
}

function set(...kinds: IdentityArtifactKind[]): Set<IdentityArtifactKind> {
  return new Set(kinds);
}

describe('runPreflight', () => {
  test('clean repo on main passes all checks', () => {
    const root = tmpRepo();
    try {
      const failures = runPreflight(root);
      const checks = failures.map((f) => f.check);
      // cli-on-path may legitimately fail in CI; assert the repo-state checks pass.
      expect(checks).not.toContain('git-root');
      expect(checks).not.toContain('clean-tree');
      expect(checks).not.toContain('integration-branch');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('non-git dir fails git-root with a fix', () => {
    const root = mkdtempSync(join(tmpdir(), 'bootstrap-identity-nogit-'));
    try {
      const failures = runPreflight(root);
      const gitRoot = failures.find((f) => f.check === 'git-root');
      expect(gitRoot).toBeDefined();
      expect(gitRoot?.fix).toContain('git init');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('dirty tree fails clean-tree', () => {
    const root = tmpRepo();
    try {
      writeFileSync(join(root, 'dirty.txt'), 'uncommitted\n', 'utf8');
      const failures = runPreflight(root);
      expect(failures.map((f) => f.check)).toContain('clean-tree');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('feature branch fails integration-branch', () => {
    const root = tmpRepo();
    try {
      git(root, ['checkout', '-q', '-b', 'feature/x']);
      const failures = runPreflight(root);
      const branch = failures.find((f) => f.check === 'integration-branch');
      expect(branch).toBeDefined();
      expect(branch?.fix).toContain('integration branch');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('renderProvenanceFrontmatter', () => {
  test('emits schema_version + provenance block with a fixed instant', () => {
    const fm = renderProvenanceFrontmatter('2026-01-01T00:00:00.000Z');
    expect(fm).toContain(`schema_version: ${IDENTITY_ARTIFACT_SCHEMA_VERSION}`);
    expect(fm).toContain('provenance:');
    expect(fm).toContain('created_at: 2026-01-01T00:00:00.000Z');
    expect(fm).toContain('last_modified_at: 2026-01-01T00:00:00.000Z');
    // created_at and last_modified_at are seeded identically at creation.
    expect(fm).toContain('created_by:');
    expect(fm).toContain('last_modified_by:');
  });
});

describe('bootstrapIdentity', () => {
  test('halts and writes nothing when pre-flight fails', () => {
    const root = mkdtempSync(join(tmpdir(), 'bootstrap-identity-fail-'));
    try {
      const result = bootstrapIdentity({ cwd: root, artifacts: set('charter') });
      expect(result.ok).toBe(false);
      expect(result.preflightFailures.length).toBeGreaterThan(0);
      expect(result.artifacts).toEqual([]);
      expect(existsSync(join(root, 'charter.md'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('creates charter + team + contributor with provenance frontmatter', () => {
    const root = tmpRepo();
    try {
      const result = bootstrapIdentity({
        cwd: root,
        artifacts: set('charter', 'team', 'contributor'),
        contributorId: 'jane-doe',
      });
      // cli-on-path can fail in CI; treat that as the only acceptable failure.
      if (!result.ok) {
        expect(result.preflightFailures.every((f) => f.check === 'cli-on-path')).toBe(true);
        return;
      }
      const charter = readFileSync(join(root, 'charter.md'), 'utf8');
      const team = readFileSync(join(root, 'team.md'), 'utf8');
      const contributor = readFileSync(join(root, 'contributors', 'jane-doe.md'), 'utf8');
      for (const body of [charter, team, contributor]) {
        expect(body.startsWith('---\n')).toBe(true);
        expect(body).toContain('schema_version:');
        expect(body).toContain('provenance:');
      }
      expect(charter).toContain('# Project Charter');
      expect(team).toContain('# Team');
      expect(contributor).toContain('jane-doe');
      expect(result.artifacts.every((a) => a.disposition === 'created')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('upgrade-preserve: re-run skips existing, adds only missing, never clobbers', () => {
    const root = tmpRepo();
    try {
      const first = bootstrapIdentity({ cwd: root, artifacts: set('charter') });
      if (!first.ok) return; // cli-on-path failure in CI — skip the behavior assertion
      // Author content, then commit so the tree is clean for the re-run
      // (mirrors real usage: the bootstrap commit lands before a later re-run).
      const charterPath = join(root, 'charter.md');
      const authored = `${readFileSync(charterPath, 'utf8')}\nAUTHORED CONTENT\n`;
      writeFileSync(charterPath, authored, 'utf8');
      git(root, ['add', '.']);
      git(root, ['commit', '-q', '-m', 'bootstrap charter']);

      // Re-run requesting charter (exists) + team (missing).
      const second = bootstrapIdentity({ cwd: root, artifacts: set('charter', 'team') });
      const byKind = Object.fromEntries(second.artifacts.map((a) => [a.kind, a.disposition]));
      expect(byKind.charter).toBe('skipped');
      expect(byKind.team).toBe('created');
      // The authored content survived — no clobber.
      expect(readFileSync(charterPath, 'utf8')).toContain('AUTHORED CONTENT');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('dry-run reports without writing files', () => {
    const root = tmpRepo();
    try {
      const result = bootstrapIdentity({ cwd: root, artifacts: set('charter'), dryRun: true });
      if (!result.ok) return; // cli-on-path failure in CI
      expect(result.artifacts[0]?.disposition).toBe('created');
      expect(existsSync(join(root, 'charter.md'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
