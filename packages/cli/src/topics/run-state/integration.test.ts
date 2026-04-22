/**
 * End-to-end integration tests for the `prove run-state` CLI.
 *
 * Each test spawns `bun run <repo>/packages/cli/bin/run.ts run-state <action>`
 * against a fresh tmpdir fixture, captures stdout/stderr/exit, and asserts
 * both shell-level behaviour and on-disk JSON state. Timestamps are frozen
 * via `PROVE_STATE_FROZEN_NOW` so JSON bytes are deterministic across runs.
 *
 * The tmpdir pattern mirrors `state.test.ts` — no shared fixture state
 * between tests — so each `describe` block is self-contained and the
 * failure signal points straight at one CLI path.
 */

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI_PATH = resolve(import.meta.dir, '../../../bin/run.ts');
const FROZEN = '2026-04-22T12:00:00Z';

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd: string, envExtras: Record<string, string> = {}): CliResult {
  const env = { ...process.env, PROVE_STATE_FROZEN_NOW: FROZEN, ...envExtras };
  // Strip inherited slug env so tests are deterministic unless explicit.
  delete env.PROVE_RUN_SLUG;
  delete env.PROVE_RUN_BRANCH;
  const proc = Bun.spawnSync({
    cmd: ['bun', 'run', CLI_PATH, 'run-state', ...args],
    cwd,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    exitCode: proc.exitCode ?? -1,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

function mkTmp(prefix = 'run-state-cli-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function setupProjectRoot(): string {
  // Emulate a repo root: `.git` stops the slug walk-up, `.prove/runs/` is the
  // runs root the CLI will resolve by default when CLAUDE_PROJECT_DIR is set.
  const root = mkTmp();
  mkdirSync(join(root, '.git'), { recursive: true });
  mkdirSync(join(root, '.prove', 'runs'), { recursive: true });
  return root;
}

function samplePlan(): Record<string, unknown> {
  return {
    schema_version: '1',
    kind: 'plan',
    mode: 'simple',
    tasks: [
      {
        id: '1.1',
        title: 'First task',
        wave: 1,
        deps: [],
        description: '',
        acceptance_criteria: [],
        worktree: { path: '', branch: '' },
        steps: [
          { id: '1.1.1', title: 'Step A', description: '', acceptance_criteria: [] },
          { id: '1.1.2', title: 'Step B', description: '', acceptance_criteria: [] },
        ],
      },
    ],
  };
}

function samplePrd(): Record<string, unknown> {
  return {
    schema_version: '1',
    kind: 'prd',
    title: 'Integration Test Run',
    context: '',
    goals: [],
    scope: { in: [], out: [] },
    acceptance_criteria: [],
    test_strategy: '',
    body_markdown: '',
  };
}

function writePlan(root: string): string {
  const path = join(root, 'plan.json');
  writeFileSync(path, `${JSON.stringify(samplePlan(), null, 2)}\n`);
  return path;
}

function writePrd(root: string): string {
  const path = join(root, 'prd.json');
  writeFileSync(path, `${JSON.stringify(samplePrd(), null, 2)}\n`);
  return path;
}

describe('run-state CLI integration', () => {
  test('full happy path: init → step start → validator set → step complete → task review → report write', () => {
    const root = setupProjectRoot();
    try {
      const plan = writePlan(root);
      const runsRoot = join(root, '.prove', 'runs');

      const init = runCli(
        ['init', '--branch', 'feature', '--slug', 'demo', '--plan', plan, '--runs-root', runsRoot],
        root,
      );
      expect(init.exitCode).toBe(0);
      expect(init.stdout).toContain('initialized:');

      const runDir = join(runsRoot, 'feature', 'demo');
      expect(Bun.file(join(runDir, 'state.json')).size).toBeGreaterThan(0);
      expect(Bun.file(join(runDir, 'plan.json')).size).toBeGreaterThan(0);
      expect(Bun.file(join(runDir, 'prd.json')).size).toBeGreaterThan(0);

      const start = runCli(
        [
          'step',
          'start',
          '1.1.1',
          '--branch',
          'feature',
          '--slug',
          'demo',
          '--runs-root',
          runsRoot,
          '--format',
          'json',
        ],
        root,
      );
      expect(start.exitCode).toBe(0);
      const afterStart = JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8'));
      expect(afterStart.run_status).toBe('running');
      expect(afterStart.current_step).toBe('1.1.1');

      const validator = runCli(
        [
          'validator',
          'set',
          '1.1.1',
          'build',
          'pass',
          '--branch',
          'feature',
          '--slug',
          'demo',
          '--runs-root',
          runsRoot,
          '--format',
          'json',
        ],
        root,
      );
      expect(validator.exitCode).toBe(0);
      const afterValidator = JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8'));
      expect(afterValidator.tasks[0].steps[0].validator_summary.build).toBe('pass');

      const complete = runCli(
        [
          'step',
          'complete',
          '1.1.1',
          '--commit',
          'abc1234',
          '--branch',
          'feature',
          '--slug',
          'demo',
          '--runs-root',
          runsRoot,
          '--format',
          'json',
        ],
        root,
      );
      expect(complete.exitCode).toBe(0);
      const afterComplete = JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8'));
      expect(afterComplete.tasks[0].steps[0].status).toBe('completed');
      expect(afterComplete.tasks[0].steps[0].commit_sha).toBe('abc1234');

      const review = runCli(
        [
          'task',
          'review',
          '1.1',
          '--verdict',
          'approved',
          '--notes',
          'looks good',
          '--reviewer',
          'principal',
          '--branch',
          'feature',
          '--slug',
          'demo',
          '--runs-root',
          runsRoot,
          '--format',
          'json',
        ],
        root,
      );
      expect(review.exitCode).toBe(0);
      const afterReview = JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8'));
      expect(afterReview.tasks[0].review.verdict).toBe('approved');
      expect(afterReview.tasks[0].review.reviewer).toBe('principal');

      const report = runCli(
        [
          'report',
          'write',
          '1.1.1',
          '--status',
          'completed',
          '--commit',
          'abc1234',
          '--branch',
          'feature',
          '--slug',
          'demo',
          '--runs-root',
          runsRoot,
        ],
        root,
      );
      expect(report.exitCode).toBe(0);
      expect(report.stdout).toContain('wrote:');
      const reportPath = join(runDir, 'reports', '1_1_1.json');
      const reportData = JSON.parse(readFileSync(reportPath, 'utf8'));
      expect(reportData.step_id).toBe('1.1.1');
      expect(reportData.status).toBe('completed');
      expect(reportData.commit_sha).toBe('abc1234');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('show --format json emits the raw state.json', () => {
    const root = setupProjectRoot();
    try {
      const plan = writePlan(root);
      const runsRoot = join(root, '.prove', 'runs');
      runCli(
        ['init', '--branch', 'feature', '--slug', 'demo', '--plan', plan, '--runs-root', runsRoot],
        root,
      );
      const show = runCli(
        ['show', '--branch', 'feature', '--slug', 'demo', '--runs-root', runsRoot, '--format', 'json'],
        root,
      );
      expect(show.exitCode).toBe(0);
      const data = JSON.parse(show.stdout);
      expect(data.kind).toBe('state');
      expect(data.slug).toBe('demo');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('dispatch record + dedup exit codes match Python', () => {
    const root = setupProjectRoot();
    try {
      const plan = writePlan(root);
      const runsRoot = join(root, '.prove', 'runs');
      runCli(
        ['init', '--branch', 'feature', '--slug', 'demo', '--plan', plan, '--runs-root', runsRoot],
        root,
      );

      const first = runCli(
        [
          'dispatch',
          'record',
          'key1',
          'event1',
          '--branch',
          'feature',
          '--slug',
          'demo',
          '--runs-root',
          runsRoot,
        ],
        root,
      );
      expect(first.exitCode).toBe(0);
      expect(first.stdout.trim()).toBe('recorded');

      const dup = runCli(
        [
          'dispatch',
          'record',
          'key1',
          'event1',
          '--branch',
          'feature',
          '--slug',
          'demo',
          '--runs-root',
          runsRoot,
        ],
        root,
      );
      expect(dup.exitCode).toBe(3);
      expect(dup.stdout.trim()).toBe('duplicate');

      const hasKnown = runCli(
        [
          'dispatch',
          'has',
          'key1',
          '--branch',
          'feature',
          '--slug',
          'demo',
          '--runs-root',
          runsRoot,
        ],
        root,
      );
      expect(hasKnown.exitCode).toBe(0);
      expect(hasKnown.stdout.trim()).toBe('yes');

      const hasUnknown = runCli(
        [
          'dispatch',
          'has',
          'missing',
          '--branch',
          'feature',
          '--slug',
          'demo',
          '--runs-root',
          runsRoot,
        ],
        root,
      );
      expect(hasUnknown.exitCode).toBe(3);
      expect(hasUnknown.stdout.trim()).toBe('no');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('validate exits 2 on invalid JSON, 0 on valid', () => {
    const root = setupProjectRoot();
    try {
      const good = writePlan(root);
      const goodResult = runCli(['validate', good], root);
      expect(goodResult.exitCode).toBe(0);
      expect(goodResult.stdout).toContain('ok:');

      const bad = join(root, 'plan-bad.json');
      writeFileSync(bad, JSON.stringify({ kind: 'plan' }));
      const badResult = runCli(['validate', bad, '--kind', 'plan'], root);
      expect(badResult.exitCode).toBe(2);
      expect(badResult.stderr).toContain('ERROR');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('illegal state transition exits 2 with Python-parity error', () => {
    const root = setupProjectRoot();
    try {
      const plan = writePlan(root);
      const runsRoot = join(root, '.prove', 'runs');
      runCli(
        ['init', '--branch', 'feature', '--slug', 'demo', '--plan', plan, '--runs-root', runsRoot],
        root,
      );
      // start + complete
      runCli(
        ['step', 'start', '1.1.1', '--branch', 'feature', '--slug', 'demo', '--runs-root', runsRoot],
        root,
      );
      runCli(
        ['step', 'complete', '1.1.1', '--branch', 'feature', '--slug', 'demo', '--runs-root', runsRoot],
        root,
      );
      // start again on already-completed step — invalid
      const again = runCli(
        ['step', 'start', '1.1.1', '--branch', 'feature', '--slug', 'demo', '--runs-root', runsRoot],
        root,
      );
      expect(again.exitCode).toBe(2);
      expect(again.stderr).toContain("illegal transition: 'completed' -> 'in_progress'");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('slug autodetect via .prove-wt-slug.txt marker', () => {
    const root = setupProjectRoot();
    try {
      const plan = writePlan(root);
      const runsRoot = join(root, '.prove', 'runs');
      runCli(
        ['init', '--branch', 'feature', '--slug', 'demo', '--plan', plan, '--runs-root', runsRoot],
        root,
      );
      writeFileSync(join(root, '.prove-wt-slug.txt'), 'demo\n');

      // No --slug / --branch — autodetect from marker + registered run
      const show = runCli(['show', '--runs-root', runsRoot, '--format', 'json'], root);
      expect(show.exitCode).toBe(0);
      const data = JSON.parse(show.stdout);
      expect(data.slug).toBe('demo');
      expect(data.branch).toBe('feature');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('missing slug returns exit 2 with the Python error message', () => {
    const root = setupProjectRoot();
    try {
      const result = runCli(['show', '--runs-root', join(root, '.prove', 'runs')], root);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('no run slug found');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('unknown action exits 1 with usage hint', () => {
    const root = setupProjectRoot();
    try {
      const result = runCli(['bogus'], root);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("unknown run-state action 'bogus'");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('migrate on a legacy md-based run promotes the layout to JSON-first', () => {
    const root = setupProjectRoot();
    try {
      const runsRoot = join(root, '.prove', 'runs');
      const legacy = join(runsRoot, 'main', 'legacy');
      mkdirSync(join(legacy, 'reports'), { recursive: true });
      writeFileSync(
        join(legacy, 'PRD.md'),
        '# Legacy Run\n\n## Context\nExample.\n\n## Goals\n- convert to json\n',
      );
      writeFileSync(
        join(legacy, 'TASK_PLAN.md'),
        '# Task Plan: Legacy\n\n### Task 1.1: First\nBody here.\n',
      );

      const result = runCli(['migrate', '--runs-root', runsRoot], root);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('1 runs processed');
      const plan = JSON.parse(readFileSync(join(legacy, 'plan.json'), 'utf8'));
      expect(plan.kind).toBe('plan');
      expect(plan.tasks.length).toBe(1);
      expect(plan.tasks[0].id).toBe('1.1');
      const state = JSON.parse(readFileSync(join(legacy, 'state.json'), 'utf8'));
      expect(state.kind).toBe('state');
      expect(state.slug).toBe('legacy');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
