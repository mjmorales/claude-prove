/**
 * Tests for the `worktree` topic (ported manage-worktree.sh).
 *
 * Each test builds a real temp git repo with an `orchestrator/<slug>` base
 * branch, then drives `runWorktree` directly, asserting on captured stdout
 * (the path / JSON contract) and exit codes. Real `git worktree` operations
 * run against the temp repo — no mocking.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type WorktreeOpts, runWorktree } from './worktree/manage';

let base: string;
let repo: string;
let stdoutBuf: string;
let stderrBuf: string;

function git(args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function run(opts: Omit<WorktreeOpts, 'workspaceRoot'>): {
  exit: number;
  stdout: string;
  stderr: string;
} {
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  stdoutBuf = '';
  stderrBuf = '';
  process.stdout.write = ((c: string | Uint8Array) => {
    stdoutBuf += typeof c === 'string' ? c : Buffer.from(c).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => {
    stderrBuf += typeof c === 'string' ? c : Buffer.from(c).toString('utf8');
    return true;
  }) as typeof process.stderr.write;
  try {
    const exit = runWorktree({ ...opts, workspaceRoot: repo });
    return { exit, stdout: stdoutBuf, stderr: stderrBuf };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'wt-'));
  repo = join(base, 'repo');
  execFileSync('git', ['init', '-q', repo]);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 't']);
  writeFileSync(join(repo, '.gitignore'), '.claude/\n');
  writeFileSync(join(repo, 'f.txt'), 'base\n');
  git(['add', '.']);
  git(['commit', '-qm', 'init']);
  git(['branch', 'orchestrator/wf']);
});

afterEach(() => {
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('worktree — accessors & validation', () => {
  test('path and branch return computed values', () => {
    const p = run({ action: 'path', slug: 'wf', taskId: '1' });
    expect(p.exit).toBe(0);
    expect(p.stdout.trim()).toBe(join(repo, '.claude', 'worktrees', 'wf-task-1'));

    const b = run({ action: 'branch', slug: 'wf', taskId: '1' });
    expect(b.exit).toBe(0);
    expect(b.stdout.trim()).toBe('task/wf/1');
  });

  test('rejects path-traversal slug', () => {
    const r = run({ action: 'create', slug: '../evil', taskId: '1' });
    expect(r.exit).toBe(1);
    expect(r.stderr).toContain('<slug> required');
  });

  test('rejects empty / unsafe task-id', () => {
    expect(run({ action: 'create', slug: 'wf', taskId: '' }).exit).toBe(1);
    expect(run({ action: 'create', slug: 'wf', taskId: 'a b' }).exit).toBe(1);
  });
});

describe('worktree — create', () => {
  test('missing base branch exits 1', () => {
    const r = run({ action: 'create', slug: 'nope', taskId: '1' });
    expect(r.exit).toBe(1);
    expect(r.stderr).toContain("base branch 'orchestrator/nope' does not exist");
  });

  test('creates worktree, writes slug marker, returns path; idempotent', () => {
    const r = run({ action: 'create', slug: 'wf', taskId: '1' });
    expect(r.exit).toBe(0);
    const wt = r.stdout.trim();
    expect(wt).toBe(join(repo, '.claude', 'worktrees', 'wf-task-1'));
    expect(existsSync(wt)).toBe(true);
    expect(existsSync(join(wt, '.prove-wt-slug.txt'))).toBe(true);
    // branch exists
    expect(() => git(['rev-parse', '--verify', 'task/wf/1'])).not.toThrow();

    const again = run({ action: 'create', slug: 'wf', taskId: '1' });
    expect(again.exit).toBe(0);
    expect(again.stdout.trim()).toBe(wt);
    expect(again.stderr).toContain('(exists)');
  });

  test('--base override', () => {
    git(['branch', 'custom-base']);
    const r = run({ action: 'create', slug: 'wf', taskId: '2', base: 'custom-base' });
    expect(r.exit).toBe(0);
    expect(r.stderr).toContain('from custom-base');
  });
});

describe('worktree — list / remove / remove-all', () => {
  test('list reflects created worktrees as JSON', () => {
    expect(JSON.parse(run({ action: 'list', slug: 'wf' }).stdout)).toEqual([]);
    run({ action: 'create', slug: 'wf', taskId: '1' });
    const rows = JSON.parse(run({ action: 'list', slug: 'wf' }).stdout);
    expect(rows).toEqual([
      { task_id: '1', path: join(repo, '.claude', 'worktrees', 'wf-task-1'), branch: 'task/wf/1' },
    ]);
  });

  test('remove deletes the worktree', () => {
    run({ action: 'create', slug: 'wf', taskId: '1' });
    const r = run({ action: 'remove', slug: 'wf', taskId: '1' });
    expect(r.exit).toBe(0);
    expect(JSON.parse(run({ action: 'list', slug: 'wf' }).stdout)).toEqual([]);
  });

  test('remove-all clears every task worktree for the slug', () => {
    run({ action: 'create', slug: 'wf', taskId: '1' });
    run({ action: 'create', slug: 'wf', taskId: '2' });
    expect(JSON.parse(run({ action: 'list', slug: 'wf' }).stdout)).toHaveLength(2);
    const r = run({ action: 'remove-all', slug: 'wf' });
    expect(r.exit).toBe(0);
    expect(JSON.parse(run({ action: 'list', slug: 'wf' }).stdout)).toEqual([]);
  });
});

describe('worktree — reset (auto-rebound mechanic)', () => {
  test('nonexistent worktree exits 1', () => {
    const r = run({ action: 'reset', slug: 'wf', taskId: '1' });
    expect(r.exit).toBe(1);
    expect(r.stderr).toContain('does not exist');
  });

  test('resets the worktree to the updated base HEAD', () => {
    const wt = run({ action: 'create', slug: 'wf', taskId: '1' }).stdout.trim();
    // task work
    writeFileSync(join(wt, 'task.txt'), 'work\n');
    execFileSync('git', ['-C', wt, 'add', 'task.txt']);
    execFileSync('git', ['-C', wt, 'commit', '-qm', 'task work']);
    // advance base
    git(['checkout', '-q', 'orchestrator/wf']);
    writeFileSync(join(repo, 'other.txt'), 'merged\n');
    git(['add', 'other.txt']);
    git(['commit', '-qm', 'other merged']);
    const baseSha = git(['rev-parse', 'orchestrator/wf']);

    const r = run({ action: 'reset', slug: 'wf', taskId: '1' });
    expect(r.exit).toBe(0);
    expect(execFileSync('git', ['-C', wt, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(
      baseSha,
    );
    expect(existsSync(join(wt, 'other.txt'))).toBe(true); // picked up merged work
    expect(existsSync(join(wt, 'task.txt'))).toBe(false); // stale commit discarded
  });
});
