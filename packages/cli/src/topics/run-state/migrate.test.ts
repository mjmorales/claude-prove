/**
 * migrate.ts tests — legacy markdown → JSON conversion for `.prove/runs`.
 *
 * Mirrors `tools/run_state/test_migrate.py` semantic pins and adds parity
 * fixtures that compare TS output byte-for-byte against Python captures.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  _clock,
  deriveStateFromProgress,
  migrateAll,
  migrateRun,
  newPlan,
  newPrd,
  newState,
  parsePlanMd,
  parsePrdMd,
} from './migrate';
import { validateData } from './validate';

// --- shared markdown fixtures, identical to test_migrate.py -------------------

const PRD_MD = `# Example PRD

## Context

Reasons for this run.

## Goals

- Deliver A
- Deliver B

## Scope

### In
- foo
- bar

## Acceptance Criteria

- All tests pass
- No regressions

## Test Strategy

Run pytest and manually verify edge cases.
`;

const PLAN_MD = `# Task Plan: Example

## Implementation Steps

### Task 1.1: First task

**Worktree:** /tmp/wt1
**Branch:** orch/demo-1

Do the first thing.

#### Step 1.1.1: Edit files
Edit the files.

#### Step 1.1.2: Run tests
Run the tests.

### Task 2.1: Second task

**Worktree:** /tmp/wt2

Do the second thing (single implicit step).
`;

const PROGRESS_MD = `# Progress

- [x] Task 1.1: First task
- [~] Task 2.1: Second task
`;

// --- deterministic clock (Python tests implicitly accept drift; ours pin it) --

const ORIGINAL_CLOCK = _clock.now;
const FROZEN_TS = '2026-04-22T00:00:00Z';
beforeAll(() => {
  _clock.now = () => FROZEN_TS;
});
afterAll(() => {
  _clock.now = ORIGINAL_CLOCK;
});

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), 'run-state-migrate-'));
}

function setupLegacyRun(root: string, branch: string, slug: string): string {
  const runDir = join(root, branch, slug);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'PRD.md'), PRD_MD);
  writeFileSync(join(runDir, 'TASK_PLAN.md'), PLAN_MD);
  writeFileSync(join(runDir, 'PROGRESS.md'), PROGRESS_MD);
  return runDir;
}

// --- parsePrdMd ---------------------------------------------------------------

describe('parsePrdMd', () => {
  test('extracts sections', () => {
    const prd = parsePrdMd(PRD_MD);
    expect(prd.title).toBe('Example PRD');
    expect(prd.context).toContain('Reasons for this run');
    expect(prd.goals).toEqual(['Deliver A', 'Deliver B']);
    expect(prd.acceptance_criteria).toEqual(['All tests pass', 'No regressions']);
    expect(prd.test_strategy).toContain('pytest');
    expect((prd.body_markdown as string).startsWith('# Example PRD')).toBe(true);
  });

  test('validates', () => {
    const prd = parsePrdMd(PRD_MD);
    const r = validateData(prd, 'prd');
    expect(r.ok).toBe(true);
  });

  test('missing title defaults to Untitled Run', () => {
    const prd = parsePrdMd('no heading at all');
    expect(prd.title).toBe('Untitled Run');
  });
});

// --- parsePlanMd --------------------------------------------------------------

describe('parsePlanMd', () => {
  test('extracts tasks and steps', () => {
    const plan = parsePlanMd(PLAN_MD);
    expect(plan.mode).toBe('full'); // wave 2 present
    const tasks = plan.tasks as Record<string, unknown>[];
    expect(tasks).toHaveLength(2);

    const t1 = tasks[0];
    expect(t1.id).toBe('1.1');
    expect(t1.title).toBe('First task');
    expect(t1.wave).toBe(1);
    expect((t1.worktree as Record<string, unknown>).path).toBe('/tmp/wt1');
    expect((t1.worktree as Record<string, unknown>).branch).toBe('orch/demo-1');
    const t1Steps = t1.steps as Record<string, unknown>[];
    expect(t1Steps).toHaveLength(2);
    expect(t1Steps[0].id).toBe('1.1.1');

    const t2 = tasks[1];
    expect(t2.id).toBe('2.1');
    expect(t2.wave).toBe(2);
    const t2Steps = t2.steps as Record<string, unknown>[];
    expect(t2Steps).toHaveLength(1); // implicit step
    expect(t2Steps[0].id).toBe('2.1.1');
  });

  test('validates', () => {
    const plan = parsePlanMd(PLAN_MD);
    const r = validateData(plan, 'plan');
    expect(r.ok).toBe(true);
  });

  test('empty input yields empty tasks, simple mode', () => {
    const plan = parsePlanMd('nothing here');
    expect(plan.mode).toBe('simple');
    expect(plan.tasks).toEqual([]);
  });
});

// --- deriveStateFromProgress --------------------------------------------------

describe('deriveStateFromProgress', () => {
  test('applies statuses', () => {
    const plan = parsePlanMd(PLAN_MD);
    const state = deriveStateFromProgress(PROGRESS_MD, plan, 'demo', 'feature');
    const tasks = state.tasks as Record<string, unknown>[];
    expect(tasks[0].status).toBe('completed');
    expect(tasks[1].status).toBe('in_progress');
    expect(state.run_status).toBe('running');
  });

  test('validates', () => {
    const plan = parsePlanMd(PLAN_MD);
    const state = deriveStateFromProgress(PROGRESS_MD, plan, 'demo', 'feature');
    const r = validateData(state, 'state');
    expect(r.ok).toBe(true);
  });

  test('all completed flips run_status to completed', () => {
    const plan = parsePlanMd(PLAN_MD);
    const progress = `# Progress\n- [x] Task 1.1\n- [x] Task 2.1\n`;
    const state = deriveStateFromProgress(progress, plan, 'demo', 'feature');
    expect(state.run_status).toBe('completed');
    expect(state.ended_at).toBe(FROZEN_TS);
  });
});

// --- migrateRun ---------------------------------------------------------------

describe('migrateRun', () => {
  test('writes all three', () => {
    const root = makeTmp();
    try {
      const runDir = setupLegacyRun(join(root, 'runs'), 'feature', 'demo');
      const result = migrateRun(runDir, { branch: 'feature', slug: 'demo' });
      expect(result.prdWritten).toBe(true);
      expect(result.planWritten).toBe(true);
      expect(result.stateWritten).toBe(true);
      expect(existsSync(join(runDir, 'prd.json'))).toBe(true);
      expect(existsSync(join(runDir, 'plan.json'))).toBe(true);
      expect(existsSync(join(runDir, 'state.json'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('is idempotent', () => {
    const root = makeTmp();
    try {
      const runDir = setupLegacyRun(join(root, 'runs'), 'feature', 'demo');
      migrateRun(runDir, { branch: 'feature', slug: 'demo' });
      const result = migrateRun(runDir, { branch: 'feature', slug: 'demo' });
      expect(result.prdWritten).toBe(false);
      expect(result.planWritten).toBe(false);
      expect(result.stateWritten).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('overwrite flag re-writes everything', () => {
    const root = makeTmp();
    try {
      const runDir = setupLegacyRun(join(root, 'runs'), 'feature', 'demo');
      migrateRun(runDir, { branch: 'feature', slug: 'demo' });
      const result = migrateRun(runDir, {
        branch: 'feature',
        slug: 'demo',
        overwrite: true,
      });
      expect(result.prdWritten).toBe(true);
      expect(result.planWritten).toBe(true);
      expect(result.stateWritten).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('folds dispatch-state.json', () => {
    const root = makeTmp();
    try {
      const runDir = setupLegacyRun(join(root, 'runs'), 'feature', 'demo');
      writeFileSync(
        join(runDir, 'dispatch-state.json'),
        JSON.stringify({
          dispatched: [{ key: 'k1', event: 'step-complete', timestamp: 't' }],
        }),
      );
      migrateRun(runDir, { branch: 'feature', slug: 'demo' });
      const state = JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8'));
      expect(state.dispatch.dispatched[0].key).toBe('k1');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('dry-run does not write', () => {
    const root = makeTmp();
    try {
      const runDir = setupLegacyRun(join(root, 'runs'), 'feature', 'demo');
      migrateRun(runDir, { branch: 'feature', slug: 'demo', dryRun: true });
      expect(existsSync(join(runDir, 'state.json'))).toBe(false);
      expect(existsSync(join(runDir, 'plan.json'))).toBe(false);
      expect(existsSync(join(runDir, 'prd.json'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('plan without progress still generates state', () => {
    const root = makeTmp();
    try {
      const runDir = join(root, 'runs', 'feature', 'demo');
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, 'TASK_PLAN.md'), PLAN_MD);
      const result = migrateRun(runDir, { branch: 'feature', slug: 'demo' });
      expect(result.planWritten).toBe(true);
      expect(result.stateWritten).toBe(true);
      expect(result.prdWritten).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// --- migrateAll ---------------------------------------------------------------

describe('migrateAll', () => {
  test('walks branches', () => {
    const root = makeTmp();
    try {
      const runsRoot = join(root, 'runs');
      setupLegacyRun(runsRoot, 'feature', 'one');
      setupLegacyRun(runsRoot, 'fix', 'two');
      const results = migrateAll(runsRoot);
      expect(results).toHaveLength(2);
      expect(results.every((r) => r.stateWritten)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('returns empty when root does not exist', () => {
    const results = migrateAll('/nonexistent/path/xyz123');
    expect(results).toEqual([]);
  });
});

// --- factory helpers (key-order parity with Python) ---------------------------

describe('newPrd / newPlan / newState', () => {
  test('newPrd key order matches Python construction', () => {
    const prd = newPrd('hello', { context: 'ctx' });
    expect(Object.keys(prd)).toEqual([
      'schema_version',
      'kind',
      'context',
      'goals',
      'scope',
      'acceptance_criteria',
      'test_strategy',
      'body_markdown',
      'title',
    ]);
  });

  test('newPlan key order', () => {
    const plan = newPlan([], 'simple');
    expect(Object.keys(plan)).toEqual(['schema_version', 'kind', 'mode', 'tasks']);
  });

  test('newState key order and defaults', () => {
    const plan = newPlan([{ id: '1.1', title: 't', wave: 1, steps: [] }], 'simple');
    const state = newState('slug', 'branch', plan);
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
    expect(state.updated_at).toBe(FROZEN_TS);
  });
});

// --- parity fixtures: byte-equal Python captures ------------------------------

const FIXTURE_DIR = join(import.meta.dir, '__fixtures__/migrate');
const PY_CAP_DIR = join(FIXTURE_DIR, 'python-captures');

describe('parity vs python captures', () => {
  if (!existsSync(PY_CAP_DIR)) {
    test.skip('python captures present', () => {});
    return;
  }

  const caseFiles = readdirSync(PY_CAP_DIR).filter((n) => n.endsWith('.json'));
  if (caseFiles.length === 0) {
    test.skip('at least one python capture', () => {});
    return;
  }

  for (const name of caseFiles) {
    test(`byte-equal: ${name}`, () => {
      const expected = readFileSync(join(PY_CAP_DIR, name), 'utf8');
      const tsOut = produceCase(name);
      expect(tsOut).toBe(expected);
    });
  }
});

/**
 * Reproduce a named parity case. Each case file contains the Python
 * capture for one scenario; `produceCase` runs the TS port against the
 * same input and returns the serialized envelope the capture script
 * wrote. The envelope shape — `{name, artifact, data}` with a trailing
 * newline — is defined by `__fixtures__/migrate/capture.sh`.
 */
function produceCase(filename: string): string {
  const base = filename.replace(/\.json$/, '');
  const envelope = runCase(base);
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

interface Envelope {
  name: string;
  artifact: string;
  data: unknown;
}

function runCase(name: string): Envelope {
  if (name === 'prd_from_md') {
    return { name, artifact: 'prd', data: parsePrdMd(PRD_MD) };
  }
  if (name === 'plan_from_md') {
    return { name, artifact: 'plan', data: parsePlanMd(PLAN_MD) };
  }
  if (name === 'state_from_progress') {
    const plan = parsePlanMd(PLAN_MD);
    return {
      name,
      artifact: 'state',
      data: deriveStateFromProgress(PROGRESS_MD, plan, 'demo', 'feature'),
    };
  }
  if (name === 'state_all_completed') {
    const plan = parsePlanMd(PLAN_MD);
    const progress = `# Progress\n- [x] Task 1.1\n- [x] Task 2.1\n`;
    return {
      name,
      artifact: 'state',
      data: deriveStateFromProgress(progress, plan, 'demo', 'feature'),
    };
  }
  if (name === 'new_prd_defaults') {
    return { name, artifact: 'prd', data: newPrd('Seed title') };
  }
  if (name === 'new_plan_empty') {
    return { name, artifact: 'plan', data: newPlan([], 'simple') };
  }
  if (name === 'new_state_empty_plan') {
    return {
      name,
      artifact: 'state',
      data: newState('s', 'b', newPlan([], 'simple')),
    };
  }
  throw new Error(`unknown parity case: ${name}`);
}
