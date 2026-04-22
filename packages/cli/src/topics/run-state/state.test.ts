/**
 * state.ts tests — mirrors tools/run_state/test_state.py + test_reconcile.py.
 *
 * Each test uses a fresh tmp directory; no fixture reuse. Mirrors Python's
 * per-test `@pytest.fixture(tmp_path)` isolation.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunPaths } from './paths';
import {
  type PlanData,
  type StateData,
  StateError,
  type StepData,
  type TaskData,
  dispatchHas,
  dispatchRecord,
  findInprogressSteps,
  initRun,
  loadState,
  newPlan,
  newPrd,
  newState,
  reconcile,
  reportWrite,
  stepComplete,
  stepFail,
  stepHalt,
  stepStart,
  taskReview,
  validatorSet,
} from './state';
import { validateData } from './validate';

function mkTmp(prefix = 'run-state-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Unwrap an optional-by-type value that must exist for the test's premise. */
function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`test expected ${name} to be defined`);
  return value;
}

function firstTask(s: StateData): TaskData {
  return required(s.tasks[0], 'tasks[0]');
}

function firstStep(s: StateData): StepData {
  return required(firstTask(s).steps[0], 'tasks[0].steps[0]');
}

function samplePlan(): PlanData {
  return newPlan(
    [
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
      {
        id: '1.2',
        title: 'Second task',
        wave: 1,
        deps: [],
        description: '',
        acceptance_criteria: [],
        worktree: { path: '', branch: '' },
        steps: [{ id: '1.2.1', title: 'Step C', description: '', acceptance_criteria: [] }],
      },
    ],
    'simple',
  );
}

function makeRun(): { tmp: string; paths: RunPaths } {
  const tmp = mkTmp();
  const paths = initRun(join(tmp, 'runs'), 'feature', 'demo', samplePlan(), {
    prd: newPrd('Demo'),
  });
  return { tmp, paths };
}

function cleanup(tmp: string): void {
  rmSync(tmp, { recursive: true, force: true });
}

// --- init_run -----------------------------------------------------------

describe('initRun', () => {
  test('creates prd.json, plan.json, state.json, reports/ dir', () => {
    const { tmp, paths } = makeRun();
    try {
      expect(existsSync(paths.prd)).toBe(true);
      expect(existsSync(paths.plan)).toBe(true);
      expect(existsSync(paths.state)).toBe(true);
      expect(statSync(paths.reports_dir).isDirectory()).toBe(true);
    } finally {
      cleanup(tmp);
    }
  });

  test('refuses to overwrite existing run without opts.overwrite', () => {
    const tmp = mkTmp();
    try {
      const runs = join(tmp, 'runs');
      initRun(runs, 'feature', 'demo', samplePlan());
      expect(() => initRun(runs, 'feature', 'demo', samplePlan())).toThrow(/already initialized/);
    } finally {
      cleanup(tmp);
    }
  });

  test('overwrite: true replaces an existing run', () => {
    const tmp = mkTmp();
    try {
      const runs = join(tmp, 'runs');
      initRun(runs, 'feature', 'demo', samplePlan());
      expect(() =>
        initRun(runs, 'feature', 'demo', samplePlan(), { overwrite: true }),
      ).not.toThrow();
    } finally {
      cleanup(tmp);
    }
  });

  test('initial state.json passes its own schema validation', () => {
    const { tmp, paths } = makeRun();
    try {
      const data = JSON.parse(readFileSync(paths.state, 'utf8'));
      const r = validateData(data, 'state');
      expect(r.ok).toBe(true);
    } finally {
      cleanup(tmp);
    }
  });

  test('state.json is byte-deterministic (2-space indent + trailing newline)', () => {
    const { tmp, paths } = makeRun();
    try {
      const raw = readFileSync(paths.state, 'utf8');
      expect(raw.endsWith('\n')).toBe(true);
      expect(raw).toMatch(/\n {2}"schema_version"/);
    } finally {
      cleanup(tmp);
    }
  });

  test('lock sidecar is created on init', () => {
    const { tmp, paths } = makeRun();
    try {
      expect(existsSync(paths.state_lock)).toBe(true);
    } finally {
      cleanup(tmp);
    }
  });
});

// --- stepStart ---------------------------------------------------------

describe('stepStart', () => {
  test('promotes step, task, and run to active', () => {
    const { tmp, paths } = makeRun();
    try {
      const s = stepStart(paths, '1.1.1');
      expect(s.run_status).toBe('running');
      expect(s.current_step).toBe('1.1.1');
      expect(s.current_task).toBe('1.1');
      expect(firstTask(s).status).toBe('in_progress');
      expect(firstStep(s).status).toBe('in_progress');
      expect(firstStep(s).started_at).not.toBe('');
    } finally {
      cleanup(tmp);
    }
  });

  test('is idempotent when already in_progress', () => {
    const { tmp, paths } = makeRun();
    try {
      stepStart(paths, '1.1.1');
      const s = stepStart(paths, '1.1.1');
      expect(firstStep(s).status).toBe('in_progress');
    } finally {
      cleanup(tmp);
    }
  });

  test('unknown step id errors', () => {
    const { tmp, paths } = makeRun();
    try {
      expect(() => stepStart(paths, '9.9.9')).toThrow(/step not found/);
    } finally {
      cleanup(tmp);
    }
  });
});

// --- stepComplete ------------------------------------------------------

describe('stepComplete', () => {
  test('records commit_sha and advances current_step', () => {
    const { tmp, paths } = makeRun();
    try {
      stepStart(paths, '1.1.1');
      const s = stepComplete(paths, '1.1.1', { commitSha: 'abc123' });
      expect(firstStep(s).status).toBe('completed');
      expect(firstStep(s).commit_sha).toBe('abc123');
      expect(s.current_step).toBe('1.1.2');
    } finally {
      cleanup(tmp);
    }
  });

  test('completing last step in task finalizes the task', () => {
    const { tmp, paths } = makeRun();
    try {
      stepStart(paths, '1.1.1');
      stepComplete(paths, '1.1.1');
      stepStart(paths, '1.1.2');
      const s = stepComplete(paths, '1.1.2');
      expect(firstTask(s).status).toBe('completed');
      expect(s.current_step).toBe('1.2.1');
    } finally {
      cleanup(tmp);
    }
  });

  test('completing every step finalizes the whole run', () => {
    const { tmp, paths } = makeRun();
    try {
      for (const sid of ['1.1.1', '1.1.2', '1.2.1']) {
        stepStart(paths, sid);
        stepComplete(paths, sid);
      }
      const s = loadState(paths);
      expect(s.run_status).toBe('completed');
      expect(s.ended_at).not.toBe('');
      expect(s.current_step).toBe('');
    } finally {
      cleanup(tmp);
    }
  });

  test('illegal transition pending -> completed is rejected', () => {
    const { tmp, paths } = makeRun();
    try {
      expect(() => stepComplete(paths, '1.1.1')).toThrow(/illegal transition/);
    } finally {
      cleanup(tmp);
    }
  });
});

// --- stepFail / stepHalt -----------------------------------------------

describe('stepFail / stepHalt', () => {
  test('stepFail marks task + run failed and records reason', () => {
    const { tmp, paths } = makeRun();
    try {
      stepStart(paths, '1.1.1');
      const s = stepFail(paths, '1.1.1', { reason: 'lint exploded' });
      expect(firstTask(s).status).toBe('failed');
      expect(s.run_status).toBe('failed');
      expect(firstStep(s).halt_reason).toBe('lint exploded');
    } finally {
      cleanup(tmp);
    }
  });

  test('stepHalt marks task + run halted', () => {
    const { tmp, paths } = makeRun();
    try {
      stepStart(paths, '1.1.1');
      const s = stepHalt(paths, '1.1.1', { reason: 'user halt' });
      expect(s.run_status).toBe('halted');
      expect(firstTask(s).status).toBe('halted');
    } finally {
      cleanup(tmp);
    }
  });

  test('retry path: failed -> in_progress is allowed', () => {
    const { tmp, paths } = makeRun();
    try {
      stepStart(paths, '1.1.1');
      stepFail(paths, '1.1.1');
      const s = stepStart(paths, '1.1.1');
      expect(firstStep(s).status).toBe('in_progress');
    } finally {
      cleanup(tmp);
    }
  });
});

// --- validatorSet ------------------------------------------------------

describe('validatorSet', () => {
  test('records phase + status on the step summary', () => {
    const { tmp, paths } = makeRun();
    try {
      stepStart(paths, '1.1.1');
      const s = validatorSet(paths, '1.1.1', 'build', 'pass');
      expect(firstStep(s).validator_summary.build).toBe('pass');
    } finally {
      cleanup(tmp);
    }
  });

  test('second call for same phase overwrites in place (dict semantics)', () => {
    const { tmp, paths } = makeRun();
    try {
      stepStart(paths, '1.1.1');
      validatorSet(paths, '1.1.1', 'build', 'pass');
      const s = validatorSet(paths, '1.1.1', 'build', 'fail');
      expect(firstStep(s).validator_summary.build).toBe('fail');
    } finally {
      cleanup(tmp);
    }
  });

  test('unknown phase errors with verbatim Python message', () => {
    const { tmp, paths } = makeRun();
    try {
      expect(() => validatorSet(paths, '1.1.1', 'bogus', 'pass')).toThrow(
        /unknown validator phase: 'bogus'/,
      );
    } finally {
      cleanup(tmp);
    }
  });

  test('unknown status errors with verbatim Python message', () => {
    const { tmp, paths } = makeRun();
    try {
      expect(() => validatorSet(paths, '1.1.1', 'build', 'banana')).toThrow(
        /unknown validator status: 'banana'/,
      );
    } finally {
      cleanup(tmp);
    }
  });
});

// --- taskReview -------------------------------------------------------

describe('taskReview', () => {
  test('records verdict, notes, reviewer, and timestamp', () => {
    const { tmp, paths } = makeRun();
    try {
      const s = taskReview(paths, '1.1', {
        verdict: 'approved',
        notes: 'clean',
        reviewer: 'arch',
      });
      const review = firstTask(s).review;
      expect(review.verdict).toBe('approved');
      expect(review.notes).toBe('clean');
      expect(review.reviewer).toBe('arch');
      expect(review.reviewed_at).not.toBe('');
    } finally {
      cleanup(tmp);
    }
  });

  test('rejected verdict is also accepted', () => {
    const { tmp, paths } = makeRun();
    try {
      const s = taskReview(paths, '1.1', { verdict: 'rejected', notes: 'nope' });
      expect(firstTask(s).review.verdict).toBe('rejected');
    } finally {
      cleanup(tmp);
    }
  });

  test('invalid verdict is rejected', () => {
    const { tmp, paths } = makeRun();
    try {
      expect(() => taskReview(paths, '1.1', { verdict: 'maybe' })).toThrow(
        /invalid review verdict/,
      );
    } finally {
      cleanup(tmp);
    }
  });
});

// --- dispatch ---------------------------------------------------------

describe('dispatch', () => {
  test('dispatchRecord is idempotent (second call returns false)', () => {
    const { tmp, paths } = makeRun();
    try {
      expect(dispatchRecord(paths, 'step-complete:1.1.1', 'step-complete')).toBe(true);
      expect(dispatchRecord(paths, 'step-complete:1.1.1', 'step-complete')).toBe(false);
      const s = loadState(paths);
      expect(s.dispatch.dispatched.length).toBe(1);
      const entry = required(s.dispatch.dispatched[0], 'dispatched[0]');
      expect(entry.event).toBe('step-complete');
    } finally {
      cleanup(tmp);
    }
  });

  test('dispatchHas: hit vs miss', () => {
    const { tmp, paths } = makeRun();
    try {
      dispatchRecord(paths, 'k1', 'step-complete');
      expect(dispatchHas(paths, 'k1')).toBe(true);
      expect(dispatchHas(paths, 'k2')).toBe(false);
    } finally {
      cleanup(tmp);
    }
  });
});

// --- reportWrite ------------------------------------------------------

describe('reportWrite', () => {
  test('persists a valid report.json passing schema validation', () => {
    const { tmp, paths } = makeRun();
    try {
      const report = {
        schema_version: '1',
        kind: 'report',
        step_id: '1.1.1',
        task_id: '1.1',
        status: 'completed' as const,
        commit_sha: 'abc',
        started_at: '2026-04-17T00:00:00Z',
        ended_at: '2026-04-17T00:00:01Z',
        diff_stats: { files_changed: 1, insertions: 5, deletions: 2 },
        validators: [],
        artifacts: [],
        notes: '',
      };
      const target = reportWrite(paths, report);
      expect(existsSync(target)).toBe(true);
      const data = JSON.parse(readFileSync(target, 'utf8'));
      const r = validateData(data, 'report');
      expect(r.ok).toBe(true);
    } finally {
      cleanup(tmp);
    }
  });

  test('normalizes dots in step id to underscores in filename', () => {
    const { tmp, paths } = makeRun();
    try {
      const target = reportWrite(paths, {
        schema_version: '1',
        kind: 'report',
        step_id: '1.2.3',
        task_id: '1.2',
        status: 'completed',
      });
      expect(target.endsWith('1_2_3.json')).toBe(true);
    } finally {
      cleanup(tmp);
    }
  });
});

// --- newState ---------------------------------------------------------

describe('newState', () => {
  test('initial state.json passes schema validation', () => {
    const state = newState('slug', 'main', samplePlan());
    const r = validateData(state as unknown as Record<string, unknown>, 'state');
    expect(r.ok).toBe(true);
    expect(state.updated_at).not.toBe('');
  });

  test('key order mirrors Python construction order', () => {
    const state = newState('slug', 'main', samplePlan());
    expect(Object.keys(state)).toEqual([
      'schema_version',
      'kind',
      'run_status',
      'slug',
      'branch',
      'current_task',
      'current_step',
      'started_at',
      'updated_at',
      'ended_at',
      'tasks',
      'dispatch',
    ]);
  });
});

// --- reconcile --------------------------------------------------------

describe('reconcile', () => {
  test('noop when no in_progress steps', () => {
    const { tmp, paths } = makeRun();
    try {
      expect(reconcile(paths)).toEqual([]);
    } finally {
      cleanup(tmp);
    }
  });

  test('halts in_progress step without commit, records reason', () => {
    const { tmp, paths } = makeRun();
    try {
      stepStart(paths, '1.1.1');
      const changes = reconcile(paths, { reasonOnHalt: 'timed out' });
      expect(changes).toEqual([{ step_id: '1.1.1', action: 'halted', detail: 'timed out' }]);

      const s = loadState(paths);
      expect(firstStep(s).status).toBe('halted');
      expect(firstStep(s).halt_reason).toBe('timed out');
      expect(s.run_status).toBe('halted');
    } finally {
      cleanup(tmp);
    }
  });

  test('auto-completes in_progress step when worktreeLatestCommit supplied', () => {
    const { tmp, paths } = makeRun();
    try {
      stepStart(paths, '1.1.1');
      const changes = reconcile(paths, { worktreeLatestCommit: 'abc123def456' });
      expect(changes.length).toBe(1);
      const change = required(changes[0], 'changes[0]');
      expect(change.action).toBe('completed');

      const s = loadState(paths);
      expect(firstStep(s).status).toBe('completed');
      expect(firstStep(s).commit_sha).toBe('abc123def456');
    } finally {
      cleanup(tmp);
    }
  });

  test('respects scopeStepIds — skips unrelated in_progress steps', () => {
    const { tmp, paths } = makeRun();
    try {
      stepStart(paths, '1.1.1');
      stepComplete(paths, '1.1.1');
      stepStart(paths, '1.1.2');
      expect(findInprogressSteps(loadState(paths)).length).toBe(1);

      const changes = reconcile(paths, { scopeStepIds: new Set(['1.1.1']) });
      expect(changes).toEqual([]);
      const secondStep = required(firstTask(loadState(paths)).steps[1], 'steps[1]');
      expect(secondStep.status).toBe('in_progress');
    } finally {
      cleanup(tmp);
    }
  });

  test('idempotent: second reconcile after terminal is noop', () => {
    const { tmp, paths } = makeRun();
    try {
      stepStart(paths, '1.1.1');
      reconcile(paths);
      expect(reconcile(paths)).toEqual([]);
    } finally {
      cleanup(tmp);
    }
  });
});

// --- StateError class --------------------------------------------------

describe('StateError', () => {
  test('is an Error subclass with name "StateError"', () => {
    const err = new StateError('nope');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('StateError');
    expect(err.message).toBe('nope');
  });
});

// --- byte-level parity hint --------------------------------------------

describe('JSON output shape', () => {
  test('state.json ends in \\n and uses 2-space indent (Python parity)', () => {
    const { tmp, paths } = makeRun();
    try {
      const raw = readFileSync(paths.state, 'utf8');
      expect(raw.endsWith('\n')).toBe(true);
      const secondLine = required(raw.split('\n')[1], 'line[1]');
      expect(secondLine.startsWith('  "')).toBe(true);
    } finally {
      cleanup(tmp);
    }
  });

  test('key order after mutations still mirrors Python construction', () => {
    const { tmp, paths } = makeRun();
    try {
      stepStart(paths, '1.1.1');
      validatorSet(paths, '1.1.1', 'build', 'pass');
      stepComplete(paths, '1.1.1', { commitSha: 'abc' });
      const raw = readFileSync(paths.state, 'utf8');
      const data = JSON.parse(raw);
      expect(Object.keys(data)).toEqual([
        'schema_version',
        'kind',
        'run_status',
        'slug',
        'branch',
        'current_task',
        'current_step',
        'started_at',
        'updated_at',
        'ended_at',
        'tasks',
        'dispatch',
      ]);
    } finally {
      cleanup(tmp);
    }
  });
});
