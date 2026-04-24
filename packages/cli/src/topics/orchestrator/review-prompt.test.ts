/**
 * Parity tests for `claude-prove orchestrator review-prompt`.
 *
 * Covers structural invariants from the retired shell template:
 *   - top header matches `# Architectural Review: Task <id> — <title>`
 *   - `Files actually changed:` line reflects `git diff --name-only` output
 *   - the diff block is wrapped in ```diff fences
 *   - missing plan/prd → exit 1 with stderr diagnostic
 *   - task id not found → exit 1 with stderr diagnostic
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runReviewPrompt } from './review-prompt';

let root: string;
let runDir: string;
let worktree: string;
let stdoutBuf: string;
let stderrBuf: string;
let writeSpy: { restore: () => void };

function spyStd(): { restore: () => void } {
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  stdoutBuf = '';
  stderrBuf = '';
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdoutBuf += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderrBuf += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stderr.write;
  return {
    restore: () => {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    },
  };
}

function git(cwd: string, ...args: string[]): void {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
}

function seedRepo(): string {
  const repo = join(root, 'repo');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  writeFileSync(join(repo, 'a.txt'), 'base\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');

  git(repo, 'checkout', '-q', '-b', 'feature');
  writeFileSync(join(repo, 'a.txt'), 'base\nchange\n');
  writeFileSync(join(repo, 'b.txt'), 'new\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'feat: extend');
  return repo;
}

const PLAN = {
  tasks: [
    {
      id: '1',
      title: 'extend-feature',
      description: 'Extend the feature.',
      acceptance_criteria: ['Must work'],
    },
  ],
};

const PRD = { acceptance_criteria: ['Ship it'] };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'review-prompt-'));
  runDir = join(root, 'run');
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'plan.json'), JSON.stringify(PLAN));
  writeFileSync(join(runDir, 'prd.json'), JSON.stringify(PRD));
  worktree = seedRepo();
  writeSpy = spyStd();
});

afterEach(() => {
  writeSpy.restore();
  rmSync(root, { recursive: true, force: true });
});

describe('orchestrator review-prompt', () => {
  test('renders header, files-changed, and fenced diff', () => {
    const code = runReviewPrompt({
      runDir,
      taskId: '1',
      worktreePath: worktree,
      baseBranch: 'main',
    });
    expect(code).toBe(0);
    expect(stdoutBuf).toContain('# Architectural Review: Task 1 — extend-feature');
    expect(stdoutBuf).toContain('Files actually changed: a.txt\nb.txt');
    expect(stdoutBuf).toMatch(/```diff[\s\S]*diff --git[\s\S]*```/);
    expect(stdoutBuf).toContain('- Must work');
    expect(stdoutBuf).toContain('- Ship it');
  });

  test('missing plan.json → exit 1 with stderr diagnostic', () => {
    rmSync(join(runDir, 'plan.json'));
    const code = runReviewPrompt({
      runDir,
      taskId: '1',
      worktreePath: worktree,
      baseBranch: 'main',
    });
    expect(code).toBe(1);
    expect(stderrBuf).toContain('plan.json/prd.json missing');
  });

  test('unknown task id → exit 1', () => {
    const code = runReviewPrompt({
      runDir,
      taskId: '99',
      worktreePath: worktree,
      baseBranch: 'main',
    });
    expect(code).toBe(1);
    expect(stderrBuf).toContain('task 99 not found');
  });
});
