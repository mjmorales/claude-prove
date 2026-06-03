/**
 * Tests for the write-isolated `bash`/`agent` criterion verification harness.
 *
 * Each test builds a real temp git repo, commits a known tree, then drives
 * `verifyBashCriterion`/`prepareAgentWorktree` against real `git worktree`
 * operations. The shell runner is injected (a deterministic stub) for the
 * exit-code/persistence cases and left as the real Bun runner for the
 * write-isolation, parallel-safety, and timeout cases — those are exactly the
 * behaviors that must hold against a real shell.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_TIMEOUT_MS,
  type ShellRunResult,
  type ShellRunner,
  parseTimeoutMs,
  prepareAgentWorktree,
  verifyBashCriterion,
} from './criterion-verify';
import type { AcceptanceCriterion } from './types';

let base: string;
let repo: string;

function git(args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function bashCriterion(
  check: string,
  over: Partial<AcceptanceCriterion> = {},
): AcceptanceCriterion {
  return {
    id: 'c1',
    text: 'a bash check',
    verifies_by: 'bash',
    check,
    status: 'active',
    idempotent: true,
    ...over,
  };
}

/** A deterministic runner that records its inputs and returns a fixed result. */
function stubRunner(result: Partial<ShellRunResult>): {
  runner: ShellRunner;
  calls: { command: string; cwd: string; timeoutMs: number }[];
} {
  const calls: { command: string; cwd: string; timeoutMs: number }[] = [];
  const runner: ShellRunner = async (command, cwd, timeoutMs) => {
    calls.push({ command, cwd, timeoutMs });
    return { exitCode: 0, stdout: '', stderr: '', timedOut: false, ...result };
  };
  return { runner, calls };
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'cv-'));
  repo = join(base, 'repo');
  execFileSync('git', ['init', '-q', repo]);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 't']);
  writeFileSync(join(repo, 'tracked.txt'), 'committed\n');
  git(['add', '.']);
  git(['commit', '-qm', 'init']);
});

afterEach(() => {
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('parseTimeoutMs', () => {
  test('bare number is seconds; suffixes scale', () => {
    expect(parseTimeoutMs('30')).toBe(30_000);
    expect(parseTimeoutMs('30s')).toBe(30_000);
    expect(parseTimeoutMs('5m')).toBe(300_000);
    expect(parseTimeoutMs('1h')).toBe(3_600_000);
  });

  test('absent / empty / malformed falls back to default', () => {
    expect(parseTimeoutMs(undefined)).toBe(DEFAULT_TIMEOUT_MS);
    expect(parseTimeoutMs('')).toBe(DEFAULT_TIMEOUT_MS);
    expect(parseTimeoutMs('soon')).toBe(DEFAULT_TIMEOUT_MS);
    expect(parseTimeoutMs('0')).toBe(DEFAULT_TIMEOUT_MS);
  });
});

describe('verifyBashCriterion — worktree lifecycle', () => {
  test('cuts the worktree from story HEAD and removes it on pass', async () => {
    const head = git(['rev-parse', 'HEAD']);
    const { runner, calls } = stubRunner({ exitCode: 0 });
    const res = await verifyBashCriterion(bashCriterion('true'), {
      repoRoot: repo,
      storyHead: head,
      runner,
    });
    expect(res.ok).toBe(true);
    expect(res.sha).toBe(head);
    // The check ran inside the throwaway worktree, not the repo root.
    expect(calls[0]?.cwd).not.toBe(repo);
    expect(calls[0]?.cwd).toContain('prove-verify-');
    // Worktree is gone afterward.
    expect(existsSync(calls[0]?.cwd ?? '')).toBe(false);
    // No leftover worktree registrations.
    expect(git(['worktree', 'list']).split('\n')).toHaveLength(1);
  });

  test('removes the worktree on failure too', async () => {
    const head = git(['rev-parse', 'HEAD']);
    const { runner, calls } = stubRunner({ exitCode: 1, stderr: 'boom' });
    const res = await verifyBashCriterion(bashCriterion('false'), {
      repoRoot: repo,
      storyHead: head,
      runner,
    });
    expect(res.ok).toBe(false);
    expect(existsSync(calls[0]?.cwd ?? '')).toBe(false);
    expect(git(['worktree', 'list']).split('\n')).toHaveLength(1);
  });

  test('removes the worktree even when the runner throws', async () => {
    const head = git(['rev-parse', 'HEAD']);
    const thrower: ShellRunner = async () => {
      throw new Error('runner blew up');
    };
    await expect(
      verifyBashCriterion(bashCriterion('x'), { repoRoot: repo, storyHead: head, runner: thrower }),
    ).rejects.toThrow('runner blew up');
    // No worktree leaked from the thrown path.
    expect(git(['worktree', 'list']).split('\n')).toHaveLength(1);
  });

  test('rejects a non-bash criterion', async () => {
    await expect(
      verifyBashCriterion(bashCriterion('x', { verifies_by: 'assert' }), {
        repoRoot: repo,
        storyHead: 'HEAD',
      }),
    ).rejects.toThrow(/expected a 'bash' criterion/);
  });
});

describe('verifyBashCriterion — timeout (real shell)', () => {
  test('a hung check is killed, not awaited', async () => {
    const head = git(['rev-parse', 'HEAD']);
    const res = await verifyBashCriterion(bashCriterion('sleep 30', { timeout: '1s' }), {
      repoRoot: repo,
      storyHead: head,
    });
    expect(res.timedOut).toBe(true);
    expect(res.ok).toBe(false);
  }, 10_000);

  test('threads the parsed timeout into the runner', async () => {
    const { runner, calls } = stubRunner({ exitCode: 0 });
    await verifyBashCriterion(bashCriterion('true', { timeout: '45s' }), {
      repoRoot: repo,
      storyHead: 'HEAD',
      runner,
    });
    expect(calls[0]?.timeoutMs).toBe(45_000);
  });
});

describe('verifyBashCriterion — failure persistence', () => {
  test('persists stdout/stderr on failure under runDir', async () => {
    const head = git(['rev-parse', 'HEAD']);
    const runDir = join(base, 'run');
    const { runner } = stubRunner({ exitCode: 2, stdout: 'out-line', stderr: 'err-line' });
    const res = await verifyBashCriterion(bashCriterion('check', { id: 'build-clean' }), {
      repoRoot: repo,
      storyHead: head,
      runDir,
      runner,
    });
    expect(res.ok).toBe(false);
    expect(res.transcriptPath).toBe(join(runDir, 'criterion-verify', 'build-clean.log'));
    const log = readFileSync(res.transcriptPath ?? '', 'utf8');
    expect(log).toContain('out-line');
    expect(log).toContain('err-line');
    expect(log).toContain('FAIL (exit 2)');
    expect(log).toContain('check');
  });

  test('records a TIMEOUT verdict in the transcript', async () => {
    const runDir = join(base, 'run');
    const { runner } = stubRunner({ exitCode: 137, timedOut: true, stderr: 'partial' });
    const res = await verifyBashCriterion(bashCriterion('check', { id: 'slow', timeout: '2s' }), {
      repoRoot: repo,
      storyHead: 'HEAD',
      runDir,
      runner,
    });
    expect(res.ok).toBe(false);
    const log = readFileSync(res.transcriptPath ?? '', 'utf8');
    expect(log).toContain('TIMEOUT after 2000ms');
  });

  test('no transcript on pass', async () => {
    const runDir = join(base, 'run');
    const { runner } = stubRunner({ exitCode: 0, stdout: 'fine' });
    const res = await verifyBashCriterion(bashCriterion('true'), {
      repoRoot: repo,
      storyHead: 'HEAD',
      runDir,
      runner,
    });
    expect(res.ok).toBe(true);
    expect(res.transcriptPath).toBeNull();
    expect(existsSync(join(runDir, 'criterion-verify'))).toBe(false);
  });

  test('sanitizes a path-unsafe criterion id', async () => {
    const runDir = join(base, 'run');
    const { runner } = stubRunner({ exitCode: 1 });
    const res = await verifyBashCriterion(bashCriterion('x', { id: '../../escape me' }), {
      repoRoot: repo,
      storyHead: 'HEAD',
      runDir,
      runner,
    });
    // The `../../` run and the space collapse to single dashes — no traversal.
    expect(res.transcriptPath).toBe(join(runDir, 'criterion-verify', '-escape-me.log'));
  });
});

describe('verifyBashCriterion — write isolation (real shell)', () => {
  test('a write inside the check cannot escape the worktree', async () => {
    const head = git(['rev-parse', 'HEAD']);
    // The check creates a file and mutates a tracked one inside its cwd.
    const res = await verifyBashCriterion(
      bashCriterion('echo new > created.txt && echo mutated > tracked.txt'),
      { repoRoot: repo, storyHead: head },
    );
    expect(res.ok).toBe(true);
    // The real tree is untouched: no new file, tracked file unchanged.
    expect(existsSync(join(repo, 'created.txt'))).toBe(false);
    expect(readFileSync(join(repo, 'tracked.txt'), 'utf8')).toBe('committed\n');
  });
});

describe('prepareAgentWorktree — shared isolation surface', () => {
  test('cuts the same isolated worktree from story HEAD', () => {
    const head = git(['rev-parse', 'HEAD']);
    const wt = prepareAgentWorktree(bashCriterion('x', { verifies_by: 'agent' }), repo, head);
    expect(wt.sha).toBe(head);
    expect(existsSync(wt.path)).toBe(true);
    expect(existsSync(join(wt.path, 'tracked.txt'))).toBe(true);
    expect(wt.path).toContain('prove-verify-');
    wt.cleanup();
    expect(existsSync(wt.path)).toBe(false);
    expect(git(['worktree', 'list']).split('\n')).toHaveLength(1);
  });

  test('rejects a non-agent criterion', () => {
    expect(() => prepareAgentWorktree(bashCriterion('x'), repo, 'HEAD')).toThrow(
      /expected an 'agent' criterion/,
    );
  });
});

describe('parallel safety (real shell)', () => {
  test('two concurrent bash criteria do not collide', async () => {
    const head = git(['rev-parse', 'HEAD']);
    const a = verifyBashCriterion(
      bashCriterion('echo a > shared.txt && sleep 0.2 && grep -q a shared.txt', { id: 'a' }),
      { repoRoot: repo, storyHead: head },
    );
    const b = verifyBashCriterion(
      bashCriterion('echo b > shared.txt && sleep 0.2 && grep -q b shared.txt', { id: 'b' }),
      { repoRoot: repo, storyHead: head },
    );
    const [ra, rb] = await Promise.all([a, b]);
    // Each saw only its own write — the worktrees never shared a file.
    expect(ra.ok).toBe(true);
    expect(rb.ok).toBe(true);
    expect(ra.sha).toBe(rb.sha);
    // The real tree never received either write.
    expect(existsSync(join(repo, 'shared.txt'))).toBe(false);
    // No leaked worktrees.
    expect(git(['worktree', 'list']).split('\n')).toHaveLength(1);
  }, 10_000);
});
