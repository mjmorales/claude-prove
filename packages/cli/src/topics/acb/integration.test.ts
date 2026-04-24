/**
 * End-to-end integration tests for the `claude-prove acb` CLI topic.
 *
 * Unlike the unit tests that drive handlers directly, these spawn
 * `bun run bin/run.ts acb <cmd>` in a real tmpdir git repo so the full
 * cac dispatch + stdin/stdout/stderr split + exit code contract is
 * exercised. Fixtures mirror the coverage matrix requested in the task:
 * save-manifest happy + error paths, assemble with 0 / N manifests,
 * post-commit hook tool-filter + block-prompt branches, and
 * migrate-legacy-db absent + populated paths.
 */

import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Test harness — locate `bin/run.ts`, spawn `bun run` against it
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
// packages/cli/src/topics/acb/integration.test.ts -> packages/cli/bin/run.ts
const RUN_TS = resolve(__dirname, '..', '..', '..', 'bin', 'run.ts');
const BUN_BIN = process.execPath;

interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runAcb(args: string[], cwd: string, stdin = ''): SpawnResult {
  const proc = Bun.spawnSync({
    cmd: [BUN_BIN, 'run', RUN_TS, 'acb', ...args],
    cwd,
    stdin: Buffer.from(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, PROVE_RUN_SLUG: '' },
  });
  return {
    exitCode: proc.exitCode ?? -1,
    stdout: proc.stdout?.toString() ?? '',
    stderr: proc.stderr?.toString() ?? '',
  };
}

function runCmd(cmd: string[], cwd: string): void {
  const proc = Bun.spawnSync({ cmd, cwd, stdout: 'pipe', stderr: 'pipe' });
  if (proc.exitCode !== 0) {
    const err = proc.stderr?.toString() ?? '';
    throw new Error(`${cmd.join(' ')} failed (exit ${proc.exitCode}): ${err}`);
  }
}

function gitStdout(cmd: string[], cwd: string): string {
  const proc = Bun.spawnSync({ cmd, cwd, stdout: 'pipe', stderr: 'pipe' });
  if (proc.exitCode !== 0) throw new Error(`${cmd.join(' ')} failed`);
  return proc.stdout?.toString().trim() ?? '';
}

function initRepo(dir: string, branch: string): void {
  runCmd(['git', '-c', `init.defaultBranch=${branch}`, 'init', '--quiet'], dir);
  runCmd(['git', 'config', 'user.email', 'test@example.com'], dir);
  runCmd(['git', 'config', 'user.name', 'test'], dir);
  runCmd(['git', 'config', 'commit.gpgsign', 'false'], dir);
  writeFileSync(join(dir, 'README.md'), '# test\n', 'utf8');
  runCmd(['git', 'add', '.'], dir);
  runCmd(['git', 'commit', '--quiet', '-m', 'init'], dir);
}

function makeRepo(prefix: string, branch = 'feat/x'): string {
  const dir = mkdtempSync(join(tmpdir(), `acb-int-${prefix}-`));
  initRepo(dir, branch);
  return dir;
}

function validManifest(sha: string): Record<string, unknown> {
  return {
    acb_manifest_version: '0.2',
    commit_sha: sha,
    timestamp: '2026-04-22T12:00:00Z',
    intent_groups: [
      {
        id: 'g1',
        title: 'Test',
        classification: 'explicit',
        file_refs: [{ path: 'README.md' }],
      },
    ],
  };
}

// Track tmpdirs for afterAll cleanup so a mid-suite failure doesn't leak.
const tmpDirs: string[] = [];
function trackRepo(prefix: string, branch = 'feat/x'): string {
  const dir = makeRepo(prefix, branch);
  tmpDirs.push(dir);
  return dir;
}

beforeAll(() => {
  if (!existsSync(RUN_TS)) {
    throw new Error(`bin/run.ts not found at expected path: ${RUN_TS}`);
  }
});

afterAll(() => {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

// ---------------------------------------------------------------------------
// save-manifest
// ---------------------------------------------------------------------------

describe('claude-prove acb save-manifest', () => {
  test('happy path: valid manifest persists and reports JSON', () => {
    const repo = trackRepo('sm-ok');
    const sha = gitStdout(['git', 'rev-parse', 'HEAD'], repo);
    const manifest = validManifest(sha);

    const res = runAcb(
      ['save-manifest', '--workspace-root', repo, '--branch', 'feat/x', '--sha', sha],
      repo,
      JSON.stringify(manifest),
    );

    expect(res.exitCode).toBe(0);
    const stdout = JSON.parse(res.stdout.trim()) as {
      saved: boolean;
      id: number;
      branch: string;
      sha: string;
      run_slug: string | null;
    };
    expect(stdout.saved).toBe(true);
    expect(stdout.branch).toBe('feat/x');
    expect(stdout.sha).toBe(sha);
    expect(typeof stdout.id).toBe('number');
    expect(res.stderr).toContain(`Manifest saved for feat/x (sha: ${sha})`);
  });

  test('invalid JSON on stdin: exit 1 with parse-error stderr', () => {
    const repo = trackRepo('sm-badjson');
    const res = runAcb(
      ['save-manifest', '--workspace-root', repo, '--branch', 'feat/x'],
      repo,
      'not json at all',
    );
    expect(res.exitCode).toBe(1);
    expect(res.stderr.startsWith('Error: invalid JSON on stdin:')).toBe(true);
  });

  test('schema-invalid manifest: exit 1 with schema-error stderr', () => {
    const repo = trackRepo('sm-badschema');
    // Missing `intent_groups` — the `commit_sha` is overwritten by the
    // resolved SHA, so the remaining required field hole is intent_groups.
    const bad = { acb_manifest_version: '0.2', timestamp: '2026-04-22T12:00:00Z' };
    const res = runAcb(
      ['save-manifest', '--workspace-root', repo, '--branch', 'feat/x'],
      repo,
      JSON.stringify(bad),
    );
    expect(res.exitCode).toBe(1);
    expect(res.stderr.startsWith('Error: invalid manifest:')).toBe(true);
  });

  test('missing timestamp: auto-injected, save succeeds', () => {
    const repo = trackRepo('sm-missing-ts');
    const sha = gitStdout(['git', 'rev-parse', 'HEAD'], repo);
    // Build without `timestamp` so the `in` check in validateManifest sees a
    // truly absent key — this is the shape agents produce when they strip the
    // field from the hook's template.
    const { timestamp: _omit, ...manifestWithoutTs } = validManifest(sha);
    void _omit;

    const res = runAcb(
      ['save-manifest', '--workspace-root', repo, '--branch', 'feat/x', '--sha', sha],
      repo,
      JSON.stringify(manifestWithoutTs),
    );

    expect(res.exitCode).toBe(0);
    const stdout = JSON.parse(res.stdout.trim()) as { saved: boolean };
    expect(stdout.saved).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// assemble
// ---------------------------------------------------------------------------

describe('claude-prove acb assemble', () => {
  test('0 manifests: exit 0, empty groups, stderr header present', () => {
    const repo = trackRepo('asm-empty');
    const res = runAcb(['assemble', '--base', 'feat/x', '--branch', 'feat/x'], repo);
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout.trim()) as {
      branch: string;
      groups: number;
      uncovered: number;
    };
    expect(out.branch).toBe('feat/x');
    expect(out.groups).toBe(0);
    expect(out.uncovered).toBe(0);
    expect(res.stderr).toContain('Assembled 0 manifests → 0 intent groups');
  });

  test('N manifests seeded via save-manifest: groups > 0, manifests cleared', () => {
    const repo = trackRepo('asm-seeded');
    const sha = gitStdout(['git', 'rev-parse', 'HEAD'], repo);

    const m1 = validManifest(sha);
    const m2 = validManifest(sha);
    // Force a distinct intent group id so both manifests contribute.
    (m2.intent_groups as Array<Record<string, unknown>>)[0].id = 'g2';
    (m2.intent_groups as Array<Record<string, unknown>>)[0].title = 'Second';

    const r1 = runAcb(
      ['save-manifest', '--workspace-root', repo, '--branch', 'feat/x', '--sha', sha],
      repo,
      JSON.stringify(m1),
    );
    expect(r1.exitCode).toBe(0);

    const r2 = runAcb(
      ['save-manifest', '--workspace-root', repo, '--branch', 'feat/x', '--sha', sha],
      repo,
      JSON.stringify(m2),
    );
    expect(r2.exitCode).toBe(0);

    const res = runAcb(
      ['assemble', '--branch', 'feat/x', '--base', 'feat/x', '--workspace-root', repo],
      repo,
    );
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout.trim()) as { groups: number; uncovered: number };
    expect(out.groups).toBe(2);
    expect(res.stderr).toContain('Assembled 2 manifests → 2 intent groups');
    expect(res.stderr).toContain('Cleared 2 manifests from store');

    // Verify the ACB document landed and manifests were cleared.
    const dbPath = join(repo, '.prove', 'prove.db');
    const db = new Database(dbPath, { readonly: true });
    try {
      const docRow = db
        .prepare<{ data: string }, [string]>('SELECT data FROM acb_acb_documents WHERE branch = ?')
        .get('feat/x');
      expect(docRow).not.toBeNull();
      const doc = JSON.parse(docRow?.data ?? '{}') as { intent_groups: unknown[] };
      expect(Array.isArray(doc.intent_groups)).toBe(true);
      expect(doc.intent_groups.length).toBe(2);

      const manifestCount = db
        .prepare<{ n: number }, [string]>(
          'SELECT COUNT(*) AS n FROM acb_manifests WHERE branch = ?',
        )
        .get('feat/x');
      expect(manifestCount?.n).toBe(0);
    } finally {
      db.close();
    }
  });

  test('unresolvable base ref: exit 1', () => {
    const repo = trackRepo('asm-badbase');
    const res = runAcb(['assemble', '--base', 'does-not-exist', '--branch', 'feat/x'], repo);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("cannot resolve base ref 'does-not-exist'");
  });
});

// ---------------------------------------------------------------------------
// hook post-commit
// ---------------------------------------------------------------------------

describe('claude-prove acb hook post-commit', () => {
  test('non-Bash tool: silent pass (empty stdout)', () => {
    const repo = trackRepo('hook-nonbash');
    const payload = { tool_name: 'Write', tool_input: {}, cwd: repo };
    const res = runAcb(
      ['hook', 'post-commit', '--workspace-root', repo],
      repo,
      JSON.stringify(payload),
    );
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe('');
  });

  test('main-branch commit: skip, stdout empty', () => {
    const repo = trackRepo('hook-main', 'main');
    const payload = {
      tool_name: 'Bash',
      tool_input: { command: 'git commit -m msg' },
      tool_response: { exit_code: 0 },
      cwd: repo,
    };
    const res = runAcb(
      ['hook', 'post-commit', '--workspace-root', repo],
      repo,
      JSON.stringify(payload),
    );
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe('');
  });

  test('feature-branch commit with missing manifest: block with MANIFEST prompt', () => {
    const repo = trackRepo('hook-block');
    const payload = {
      tool_name: 'Bash',
      tool_input: { command: 'git commit -m msg' },
      tool_response: { exit_code: 0 },
      cwd: repo,
    };
    const res = runAcb(
      ['hook', 'post-commit', '--workspace-root', repo],
      repo,
      JSON.stringify(payload),
    );
    expect(res.exitCode).toBe(0);
    const decision = JSON.parse(res.stdout) as { decision?: string; reason?: string };
    expect(decision.decision).toBe('block');
    expect(typeof decision.reason).toBe('string');
    // The MANIFEST prompt template identifies itself by the `save-manifest`
    // invocation line + the `"acb_manifest_version": "0.2"` literal.
    expect(decision.reason).toContain('acb save-manifest');
    expect(decision.reason).toContain('acb_manifest_version');
  });
});

// ---------------------------------------------------------------------------
// migrate-legacy-db
// ---------------------------------------------------------------------------

describe('claude-prove acb migrate-legacy-db', () => {
  test('no legacy db: exit 0, stderr notes no legacy', () => {
    const repo = trackRepo('mig-none');
    const res = runAcb(['migrate-legacy-db', '--workspace-root', repo], repo);
    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain('no legacy .prove/acb.db');
  });

  test('populated legacy db: rows copied, legacy file removed', () => {
    const repo = trackRepo('mig-pop');
    const proveDir = join(repo, '.prove');
    mkdirSync(proveDir, { recursive: true });

    // Seed a post-migrate legacy db (has run_slug column) with one manifest.
    const legacyPath = join(proveDir, 'acb.db');
    const legacy = new Database(legacyPath);
    try {
      legacy.exec(`
        CREATE TABLE manifests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            branch TEXT NOT NULL,
            commit_sha TEXT NOT NULL,
            timestamp TEXT NOT NULL,
            data TEXT NOT NULL,
            created_at TEXT NOT NULL,
            run_slug TEXT
        );
        CREATE TABLE acb_documents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            branch TEXT NOT NULL UNIQUE,
            data TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE review_state (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            branch TEXT NOT NULL UNIQUE,
            acb_hash TEXT NOT NULL,
            data TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
      `);
      legacy
        .prepare<unknown, [string, string, string, string, string, string | null]>(
          'INSERT INTO manifests (branch, commit_sha, timestamp, data, created_at, run_slug) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(
          'feat/legacy',
          'deadbeef',
          '2026-04-22T12:00:00Z',
          '{"acb_manifest_version":"0.2"}',
          '2026-04-22T12:00:00Z',
          null,
        );
    } finally {
      legacy.close();
    }

    const res = runAcb(['migrate-legacy-db', '--workspace-root', repo], repo);
    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain('imported 1 manifests');
    expect(existsSync(legacyPath)).toBe(false);

    const proveDbPath = join(proveDir, 'prove.db');
    const proveDb = new Database(proveDbPath, { readonly: true });
    try {
      const row = proveDb
        .prepare<{ n: number }, []>('SELECT COUNT(*) AS n FROM acb_manifests')
        .get();
      expect(row?.n).toBe(1);
    } finally {
      proveDb.close();
    }
  });
});
