import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = join(__dirname, '..', 'bin', 'run.ts');

const ALL_TOPICS = [
  'acb',
  'cafi',
  'hook',
  'install',
  'pcd',
  'run-state',
  'schema',
  'scrum',
  'store',
];

const STUB_TOPICS = ALL_TOPICS.filter(
  (t) => !['store', 'schema', 'cafi', 'run-state', 'pcd', 'acb', 'install', 'scrum'].includes(t),
);

interface RunResult {
  stdout: string;
  stderr: string;
  status: number;
}

function runBin(args: string[], cwd?: string): RunResult {
  const result = spawnSync('bun', ['run', BIN, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test' },
    cwd,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? -1,
  };
}

function makeTmpGitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'prove-cli-'));
  mkdirSync(join(root, '.git'), { recursive: true });
  return root;
}

describe('claude-prove CLI help', () => {
  test('--help lists every expected topic exactly once', () => {
    const { stdout, status } = runBin(['--help']);
    expect(status).toBe(0);
    for (const topic of ALL_TOPICS) {
      const pattern = new RegExp(`(^|\\s)${topic}(\\s|$)`, 'm');
      expect(stdout).toMatch(pattern);
    }
  });
});

describe('claude-prove CLI stub topics', () => {
  test('each stub exits 0 with the "not yet implemented" notice', () => {
    for (const topic of STUB_TOPICS) {
      const { stdout, status } = runBin([topic]);
      expect(status).toBe(0);
      expect(stdout).toContain('not yet implemented');
      expect(stdout).toContain('phase');
    }
  });
});

describe('claude-prove store subcommands', () => {
  test('store migrate applies registered domain migrations', () => {
    // Every `prove` invocation imports the topic tree, which side-effect
    // registers the `acb` schema via `topics/acb.ts`. On a fresh db the
    // acb v1 migration therefore runs on the first `store migrate` call.
    const repo = makeTmpGitRepo();
    try {
      const { stdout, status } = runBin(['store', 'migrate'], repo);
      expect(status).toBe(0);
      expect(stdout).toContain('applied acb v1');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('store info lists the db path and registered domains', () => {
    const repo = makeTmpGitRepo();
    try {
      // info reads _migrations_log; a bare repo has none until `store
      // migrate` runs. Migrate first so the info path has a real db to
      // report on.
      const migrate = runBin(['store', 'migrate'], repo);
      expect(migrate.status).toBe(0);

      const { stdout, status } = runBin(['store', 'info'], repo);
      expect(status).toBe(0);
      expect(stdout).toContain('db path:');
      expect(stdout).toContain(join(repo, '.prove', 'prove.db'));
      // `acb` is registered at import time (see topics/acb.ts -> store.ts).
      expect(stdout).toContain('acb');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('store reset without --confirm refuses and exits non-zero', () => {
    const repo = makeTmpGitRepo();
    try {
      const { stderr, status } = runBin(['store', 'reset'], repo);
      expect(status).not.toBe(0);
      expect(stderr).toContain('refusing to reset without --confirm');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('store reset --confirm drops tables and exits 0', () => {
    const repo = makeTmpGitRepo();
    try {
      const { stdout, status } = runBin(['store', 'reset', '--confirm'], repo);
      expect(status).toBe(0);
      expect(stdout).toContain('reset: dropped all domain tables');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('store with an unknown action errors out', () => {
    const repo = makeTmpGitRepo();
    try {
      const { stderr, status } = runBin(['store', 'bogus'], repo);
      expect(status).not.toBe(0);
      expect(stderr).toContain("unknown action 'bogus'");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('action-scoped --help', () => {
  test('scrum link-run --help names both positionals and omits unrelated flags', () => {
    const { stdout, status } = runBin(['scrum', 'link-run', '--help']);
    expect(status).toBe(0);
    expect(stdout).toContain('Usage: claude-prove scrum link-run <task-id> <run-path> [flags]');
    expect(stdout).toContain('--branch');
    expect(stdout).toContain('--slug');
    // The flat topic dump would include these sibling-action flags; the scoped
    // help must not.
    expect(stdout).not.toContain('--title');
    expect(stdout).not.toContain('--verifies-by');
  });

  test('scrum task create --help shows only create flags', () => {
    const { stdout, status } = runBin(['scrum', 'task', 'create', '--help']);
    expect(status).toBe(0);
    expect(stdout).toContain('Usage: claude-prove scrum task create [flags]');
    expect(stdout).toContain('--title');
    expect(stdout).not.toContain('--summary');
    expect(stdout).not.toContain('--schema-ref');
  });

  test('run-state validate --help advertises the run-resolution flags', () => {
    const { stdout, status } = runBin(['run-state', 'validate', '--help']);
    expect(status).toBe(0);
    expect(stdout).toContain('Usage: claude-prove run-state validate <file> [flags]');
    expect(stdout).toContain('--branch');
    expect(stdout).toContain('--slug');
    expect(stdout).toContain('--kind');
  });

  test('bare topic --help still prints cac flat help (back-compat)', () => {
    const { stdout, status } = runBin(['scrum', '--help']);
    expect(status).toBe(0);
    // cac usage banner for the topic command, NOT the action-scoped form.
    expect(stdout).toContain('scrum <action>');
  });
});

describe('full-usage argument errors', () => {
  test('scrum link-run with no positionals names every positional at once', () => {
    const repo = makeTmpGitRepo();
    try {
      const { stderr, status } = runBin(['scrum', 'link-run', '--workspace-root', repo], repo);
      expect(status).toBe(1);
      expect(stderr).toContain('Usage: claude-prove scrum link-run <task-id> <run-path> [flags]');
      expect(stderr).toContain('error: the following arguments are required: task-id, run-path');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('run-state report write without step_id prints the report usage line', () => {
    const repo = makeTmpGitRepo();
    try {
      const { stderr, status } = runBin(
        ['run-state', 'report', 'write', '--runs-root', join(repo, '.prove', 'runs')],
        repo,
      );
      expect(status).toBe(1);
      expect(stderr).toContain('Usage: claude-prove run-state report');
      expect(stderr).toContain('error: the following arguments are required: step_id');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('run-state validate resolves the run from --branch/--slug', () => {
  function seedState(runsRoot: string, branch: string, slug: string): string {
    const runDir = join(runsRoot, branch, slug);
    mkdirSync(runDir, { recursive: true });
    const statePath = join(runDir, 'state.json');
    writeFileSync(
      statePath,
      JSON.stringify({
        schema_version: '1',
        kind: 'state',
        run_status: 'pending',
        slug,
        updated_at: 't',
        tasks: [],
      }),
    );
    return statePath;
  }

  test('no positional + --branch/--slug validates the resolved state.json', () => {
    const repo = makeTmpGitRepo();
    const runsRoot = join(repo, '.prove', 'runs');
    try {
      const statePath = seedState(runsRoot, 'main', 'demo');
      const { stdout, status } = runBin(
        ['run-state', 'validate', '--branch', 'main', '--slug', 'demo', '--runs-root', runsRoot],
        repo,
      );
      expect(status).toBe(0);
      expect(stdout).toContain(`ok: ${statePath}`);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('the positional-file form still works unchanged', () => {
    const repo = makeTmpGitRepo();
    const runsRoot = join(repo, '.prove', 'runs');
    try {
      const statePath = seedState(runsRoot, 'main', 'demo');
      const { stdout, status } = runBin(['run-state', 'validate', statePath], repo);
      expect(status).toBe(0);
      expect(stdout).toContain(`ok: ${statePath}`);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('--branch/--slug + --kind plan resolves plan.json', () => {
    const repo = makeTmpGitRepo();
    const runsRoot = join(repo, '.prove', 'runs');
    try {
      const runDir = join(runsRoot, 'main', 'demo');
      mkdirSync(runDir, { recursive: true });
      const planPath = join(runDir, 'plan.json');
      writeFileSync(
        planPath,
        JSON.stringify({
          schema_version: '4',
          kind: 'plan',
          tasks: [{ id: '1.1', title: 't', wave: 1, steps: [] }],
        }),
      );
      const { stdout, status } = runBin(
        [
          'run-state',
          'validate',
          '--branch',
          'main',
          '--slug',
          'demo',
          '--kind',
          'plan',
          '--runs-root',
          runsRoot,
        ],
        repo,
      );
      expect(status).toBe(0);
      expect(stdout).toContain(`ok: ${planPath}`);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
