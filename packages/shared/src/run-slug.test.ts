import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveRunSlug } from './run-slug';

function makeTmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `slug-${prefix}-`));
}

function run(cmd: string[], cwd: string): void {
  const proc = Bun.spawnSync({ cmd, cwd, stdout: 'pipe', stderr: 'pipe' });
  if (proc.exitCode !== 0) {
    const err = proc.stderr?.toString() ?? '';
    throw new Error(`${cmd.join(' ')} failed (exit ${proc.exitCode}): ${err}`);
  }
}

/** Init a git repo with one commit on `main`. */
function initRepo(dir: string): string {
  run(['git', 'init', '--quiet', '--initial-branch=main'], dir);
  run(['git', 'config', 'user.email', 'test@example.com'], dir);
  run(['git', 'config', 'user.name', 'test'], dir);
  run(['git', 'config', 'commit.gpgsign', 'false'], dir);
  writeFileSync(join(dir, 'README.md'), '# test\n', 'utf8');
  run(['git', 'add', '.'], dir);
  run(['git', 'commit', '--quiet', '-m', 'init'], dir);
  return dir;
}

function writePlan(runDir: string, worktreePath: string, taskId = '1.1'): void {
  const plan = {
    schema_version: '1',
    kind: 'plan',
    mode: 'simple',
    tasks: [
      {
        id: taskId,
        title: 't',
        wave: 1,
        deps: [],
        description: '',
        acceptance_criteria: [],
        worktree: { path: worktreePath, branch: '' },
        steps: [{ id: `${taskId}.1`, title: 's', description: '', acceptance_criteria: [] }],
      },
    ],
  };
  writeFileSync(join(runDir, 'plan.json'), JSON.stringify(plan), 'utf8');
}

/** Snapshot and clear PROVE_RUN_SLUG for each test.
 *
 * `delete` is used intentionally — `process.env.X = undefined` coerces to the
 * literal string `"undefined"` on Node, which would poison the env tier.
 */
function withCleanEnv(): { restore: () => void } {
  const prior = process.env.PROVE_RUN_SLUG;
  // biome-ignore lint/performance/noDelete: `delete` is required to truly unset env vars.
  delete process.env.PROVE_RUN_SLUG;
  return {
    restore: (): void => {
      if (prior === undefined) {
        // biome-ignore lint/performance/noDelete: same reason — must unset, not stringify.
        delete process.env.PROVE_RUN_SLUG;
      } else {
        process.env.PROVE_RUN_SLUG = prior;
      }
    },
  };
}

describe('resolveRunSlug — env + marker tiers', () => {
  let envGuard: { restore: () => void };
  beforeEach(() => {
    envGuard = withCleanEnv();
  });
  afterEach(() => {
    envGuard.restore();
  });

  test('env var wins', () => {
    const tmp = makeTmpDir('env');
    try {
      process.env.PROVE_RUN_SLUG = 'env-slug';
      expect(resolveRunSlug(tmp)).toBe('env-slug');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('env var overrides marker file', () => {
    const tmp = makeTmpDir('env-over-marker');
    try {
      mkdirSync(join(tmp, '.prove'));
      writeFileSync(join(tmp, '.prove', 'RUN_SLUG'), 'marker-slug', 'utf8');
      process.env.PROVE_RUN_SLUG = 'env-slug';
      expect(resolveRunSlug(tmp)).toBe('env-slug');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('marker file fallback (trailing newline trimmed)', () => {
    const tmp = makeTmpDir('marker');
    try {
      mkdirSync(join(tmp, '.prove'));
      writeFileSync(join(tmp, '.prove', 'RUN_SLUG'), 'marker-slug\n', 'utf8');
      expect(resolveRunSlug(tmp)).toBe('marker-slug');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('empty env falls through to marker', () => {
    const tmp = makeTmpDir('empty-env');
    try {
      mkdirSync(join(tmp, '.prove'));
      writeFileSync(join(tmp, '.prove', 'RUN_SLUG'), 'marker-slug', 'utf8');
      process.env.PROVE_RUN_SLUG = '  ';
      expect(resolveRunSlug(tmp)).toBe('marker-slug');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('whitespace-only marker yields null', () => {
    const tmp = makeTmpDir('ws-marker');
    try {
      mkdirSync(join(tmp, '.prove'));
      writeFileSync(join(tmp, '.prove', 'RUN_SLUG'), '   \n', 'utf8');
      expect(resolveRunSlug(tmp)).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('no env + no marker + no repo yields null', () => {
    const tmp = makeTmpDir('no-hints');
    try {
      expect(resolveRunSlug(tmp)).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('resolveRunSlug — worktree marker and plan scan', () => {
  let envGuard: { restore: () => void };
  beforeEach(() => {
    envGuard = withCleanEnv();
  });
  afterEach(() => {
    envGuard.restore();
  });

  test('.prove-wt-slug.txt marker at the worktree root wins over plan scan', () => {
    const main = makeTmpDir('main-wt-marker');
    try {
      initRepo(main);
      const canonicalMain = realpathSync(main);
      // Pre-seed a mismatched plan to prove the wt-marker takes precedence.
      const runDir = join(canonicalMain, '.prove', 'runs', 'feature', 'plan-slug');
      mkdirSync(runDir, { recursive: true });
      writePlan(runDir, canonicalMain);
      writeFileSync(join(canonicalMain, '.prove-wt-slug.txt'), 'wt-slug\n', 'utf8');
      expect(resolveRunSlug(canonicalMain)).toBe('wt-slug');
    } finally {
      rmSync(main, { recursive: true, force: true });
    }
  });

  test('plan scan matches branched layout runs/<branch>/<slug>/plan.json', () => {
    const main = makeTmpDir('plan-branched');
    try {
      initRepo(main);
      const canonicalMain = realpathSync(main);
      const runDir = join(canonicalMain, '.prove', 'runs', 'feature', 'run-planned');
      mkdirSync(runDir, { recursive: true });
      writePlan(runDir, canonicalMain);
      expect(resolveRunSlug(canonicalMain)).toBe('run-planned');
    } finally {
      rmSync(main, { recursive: true, force: true });
    }
  });

  test('plan scan matches legacy flat layout runs/<slug>/plan.json', () => {
    const main = makeTmpDir('plan-flat');
    try {
      initRepo(main);
      const canonicalMain = realpathSync(main);
      const runDir = join(canonicalMain, '.prove', 'runs', 'flat-slug');
      mkdirSync(runDir, { recursive: true });
      writePlan(runDir, canonicalMain);
      expect(resolveRunSlug(canonicalMain)).toBe('flat-slug');
    } finally {
      rmSync(main, { recursive: true, force: true });
    }
  });

  test('plan mismatch falls through to RUN_SLUG marker', () => {
    const main = makeTmpDir('plan-miss');
    try {
      initRepo(main);
      const canonicalMain = realpathSync(main);
      const otherWt = join(canonicalMain, 'other-somewhere');
      mkdirSync(otherWt);
      const runDir = join(canonicalMain, '.prove', 'runs', 'feature', 'mismatched');
      mkdirSync(runDir, { recursive: true });
      writePlan(runDir, otherWt);
      mkdirSync(join(canonicalMain, '.prove'), { recursive: true });
      writeFileSync(join(canonicalMain, '.prove', 'RUN_SLUG'), 'fallback-slug', 'utf8');
      expect(resolveRunSlug(canonicalMain)).toBe('fallback-slug');
    } finally {
      rmSync(main, { recursive: true, force: true });
    }
  });

  test('plan scan resolves through symlinked worktree path', () => {
    const parent = makeTmpDir('plan-sym');
    try {
      const realWt = join(parent, 'real-wt');
      mkdirSync(realWt);
      initRepo(realWt);
      const canonicalReal = realpathSync(realWt);
      const linkWt = join(parent, 'linked-wt');
      symlinkSync(realWt, linkWt);

      // Register the real (canonical) path in the plan — resolver should
      // still match when invoked via the symlink.
      const runDir = join(canonicalReal, '.prove', 'runs', 'feature', 'run-sym');
      mkdirSync(runDir, { recursive: true });
      writePlan(runDir, canonicalReal);

      expect(resolveRunSlug(linkWt)).toBe('run-sym');
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test('malformed plan.json is ignored', () => {
    const main = makeTmpDir('plan-bad');
    try {
      initRepo(main);
      const canonicalMain = realpathSync(main);
      const runDir = join(canonicalMain, '.prove', 'runs', 'feature', 'broken');
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, 'plan.json'), '{not json', 'utf8');
      expect(resolveRunSlug(canonicalMain)).toBeNull();
    } finally {
      rmSync(main, { recursive: true, force: true });
    }
  });

  test('linked worktree resolves slug via main worktree plan scan', () => {
    const main = makeTmpDir('plan-linked');
    try {
      initRepo(main);
      const canonicalMain = realpathSync(main);
      const linkedPath = join(canonicalMain, '..', `linked-${Date.now()}`);
      run(['git', 'worktree', 'add', '--quiet', '-b', 'feature/linked', linkedPath], canonicalMain);
      try {
        const canonicalLinked = realpathSync(linkedPath);
        const runDir = join(canonicalMain, '.prove', 'runs', 'feature', 'linked-slug');
        mkdirSync(runDir, { recursive: true });
        writePlan(runDir, canonicalLinked);
        expect(resolveRunSlug(canonicalLinked)).toBe('linked-slug');
      } finally {
        rmSync(linkedPath, { recursive: true, force: true });
      }
    } finally {
      rmSync(main, { recursive: true, force: true });
    }
  });
});
