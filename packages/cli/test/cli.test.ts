import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
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
  'round-table',
  'run-state',
  'schema',
  'scrum',
  'store',
];

const STUB_TOPICS = ALL_TOPICS.filter(
  (t) => !['store', 'schema', 'cafi', 'run-state', 'pcd'].includes(t),
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

describe('prove CLI help', () => {
  test('--help lists every expected topic exactly once', () => {
    const { stdout, status } = runBin(['--help']);
    expect(status).toBe(0);
    for (const topic of ALL_TOPICS) {
      const pattern = new RegExp(`(^|\\s)${topic}(\\s|$)`, 'm');
      expect(stdout).toMatch(pattern);
    }
  });
});

describe('prove CLI stub topics', () => {
  test('each stub exits 0 with the "not yet implemented" notice', () => {
    for (const topic of STUB_TOPICS) {
      const { stdout, status } = runBin([topic]);
      expect(status).toBe(0);
      expect(stdout).toContain('not yet implemented');
      expect(stdout).toContain('2026-04-21-typescript-cli-unification.md');
    }
  });
});

describe('prove store subcommands', () => {
  test('store migrate prints "no pending migrations" when no domains are registered', () => {
    const repo = makeTmpGitRepo();
    try {
      const { stdout, status } = runBin(['store', 'migrate'], repo);
      expect(status).toBe(0);
      expect(stdout).toContain('no pending migrations');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('store info prints the db path and "no domains registered"', () => {
    const repo = makeTmpGitRepo();
    try {
      const { stdout, status } = runBin(['store', 'info'], repo);
      expect(status).toBe(0);
      expect(stdout).toContain('db path:');
      expect(stdout).toContain(join(repo, '.prove', 'prove.db'));
      expect(stdout).toContain('no domains registered');
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
