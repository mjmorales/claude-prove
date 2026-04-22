/**
 * SubagentStop hook tests — the critical orchestrator seam.
 *
 * Covers the four branches:
 *   1. No slug marker -> silent no-op (hook does not interfere with non-
 *      orchestrator subagent runs).
 *   2. Slug marker + in_progress step + new commit after step.started_at
 *      -> auto-complete with HEAD's SHA.
 *   3. Slug marker + in_progress step + no new commits
 *      -> halt with diagnostic reason.
 *   4. Slug marker but state.json has no in_progress steps -> silent no-op.
 *
 * Each test spins up a real git repo via Bun.spawnSync so the commit-
 * walk logic exercises its real subprocess path. Timestamps are frozen
 * via PROVE_STATE_FROZEN_NOW to keep on-disk JSON deterministic.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSubagentStop } from './subagent-stop';

interface GitRepo {
  root: string;
  commit: (message: string) => string;
}

function sh(cmd: string[], cwd: string, extraEnv: Record<string, string> = {}): string {
  const proc = Bun.spawnSync({
    cmd,
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 't@example.com',
      ...extraEnv,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (proc.exitCode !== 0) {
    throw new Error(`cmd failed: ${cmd.join(' ')} (${proc.exitCode})\n${proc.stderr.toString()}`);
  }
  return proc.stdout.toString().trim();
}

function initGitRepo(): GitRepo {
  const root = mkdtempSync(join(tmpdir(), 'subagent-stop-'));
  sh(['git', 'init', '-q', '-b', 'main'], root);
  writeFileSync(join(root, '.gitignore'), 'state.json.lock\n');
  sh(['git', 'add', '.gitignore'], root);
  sh(['git', 'commit', '-q', '-m', 'init'], root, { GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z' });
  const commit = (message: string): string => {
    const marker = join(root, `change-${Date.now()}-${Math.random()}.txt`);
    writeFileSync(marker, 'x');
    sh(['git', 'add', marker], root);
    sh(['git', 'commit', '-q', '-m', message], root);
    return sh(['git', 'rev-parse', 'HEAD'], root);
  };
  return { root, commit };
}

function writeSlugMarker(root: string, slug: string): void {
  writeFileSync(join(root, '.prove-wt-slug.txt'), `${slug}\n`);
}

function writeState(
  root: string,
  branch: string,
  slug: string,
  stepStartedAt: string,
  stepStatus: 'in_progress' | 'pending' = 'in_progress',
): string {
  const runDir = join(root, '.prove', 'runs', branch, slug);
  mkdirSync(join(runDir, 'reports'), { recursive: true });
  const state = {
    schema_version: '1',
    kind: 'state',
    run_status: stepStatus === 'in_progress' ? 'running' : 'pending',
    slug,
    branch,
    current_task: '1.1',
    current_step: '1.1.1',
    started_at: stepStartedAt,
    updated_at: stepStartedAt,
    ended_at: '',
    tasks: [
      {
        id: '1.1',
        status: stepStatus === 'in_progress' ? 'in_progress' : 'pending',
        started_at: stepStartedAt,
        ended_at: '',
        review: { verdict: 'pending', notes: '', reviewer: '', reviewed_at: '' },
        steps: [
          {
            id: '1.1.1',
            status: stepStatus,
            started_at: stepStartedAt,
            ended_at: '',
            commit_sha: '',
            validator_summary: {
              build: 'pending',
              lint: 'pending',
              test: 'pending',
              custom: 'pending',
              llm: 'pending',
            },
            halt_reason: '',
          },
        ],
      },
    ],
    dispatch: { dispatched: [] },
  };
  writeFileSync(join(runDir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
  return runDir;
}

describe('runSubagentStop', () => {
  const savedFrozen = process.env.PROVE_STATE_FROZEN_NOW;
  beforeEach(() => {
    process.env.PROVE_STATE_FROZEN_NOW = '2026-04-22T12:00:00Z';
  });
  afterEach(() => {
    if (savedFrozen === undefined) delete process.env.PROVE_STATE_FROZEN_NOW;
    else process.env.PROVE_STATE_FROZEN_NOW = savedFrozen;
  });

  test('silent no-op when no slug marker is present', () => {
    const { root } = initGitRepo();
    try {
      const result = runSubagentStop({ cwd: root });
      expect(result).toEqual({ exitCode: 0, stdout: '', stderr: '' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('auto-completes in_progress step when HEAD advanced after started_at', () => {
    const { root, commit } = initGitRepo();
    try {
      writeSlugMarker(root, 'demo');
      // Step started BEFORE any subagent commit.
      const startedAt = '2020-06-01T00:00:00Z';
      writeState(root, 'feature', 'demo', startedAt, 'in_progress');
      const sha = commit('subagent work');

      const result = runSubagentStop({ cwd: root });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('completed');
      expect(result.stdout).toContain(sha.slice(0, 12));

      const after = JSON.parse(
        readFileSync(join(root, '.prove', 'runs', 'feature', 'demo', 'state.json'), 'utf8'),
      );
      expect(after.tasks[0].steps[0].status).toBe('completed');
      expect(after.tasks[0].steps[0].commit_sha).toBe(sha);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('halts with diagnostic when HEAD is older than started_at', () => {
    const { root } = initGitRepo();
    try {
      writeSlugMarker(root, 'demo');
      // Step "started" in the far future relative to HEAD's 2020 commit.
      writeState(root, 'feature', 'demo', '2099-01-01T00:00:00Z', 'in_progress');

      const result = runSubagentStop({ cwd: root });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('halted');
      expect(result.stdout).toContain('no new commits found');

      const after = JSON.parse(
        readFileSync(join(root, '.prove', 'runs', 'feature', 'demo', 'state.json'), 'utf8'),
      );
      expect(after.tasks[0].steps[0].status).toBe('halted');
      expect(after.run_status).toBe('halted');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('silent when slug resolves but no in_progress step exists', () => {
    const { root } = initGitRepo();
    try {
      writeSlugMarker(root, 'demo');
      writeState(root, 'feature', 'demo', '', 'pending');
      const result = runSubagentStop({ cwd: root });
      expect(result).toEqual({ exitCode: 0, stdout: '', stderr: '' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('silent when slug marker exists but slug is not registered', () => {
    const { root } = initGitRepo();
    try {
      writeSlugMarker(root, 'missing-slug');
      const result = runSubagentStop({ cwd: root });
      expect(result).toEqual({ exitCode: 0, stdout: '', stderr: '' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
