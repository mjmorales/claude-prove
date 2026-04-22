/**
 * Schema exports + inferKind tests. Exercises each of the four
 * SCHEMA_BY_KIND entries on canonical + boundary data.
 *
 * Parity fixtures under `__fixtures__/schemas/` exercise the same schemas
 * end-to-end against the Python source; this file covers the unit-level
 * invariants (correct literals, correct kind inference, correct SCHEMA_BY_KIND
 * mapping).
 */

import { describe, expect, test } from 'bun:test';
import {
  CURRENT_SCHEMA_VERSION,
  PLAN_SCHEMA,
  PRD_SCHEMA,
  REPORT_SCHEMA,
  RUN_STATUSES,
  SCHEMA_BY_KIND,
  STATE_SCHEMA,
  STEP_STATUSES,
  TASK_STATUSES,
  VALIDATOR_PHASES,
  VALIDATOR_STATUSES,
  inferKind,
} from './schemas';

describe('CURRENT_SCHEMA_VERSION', () => {
  test("matches tools/run_state/__init__.py literal ('1')", () => {
    expect(CURRENT_SCHEMA_VERSION).toBe('1');
  });

  test('each schema echoes the current version', () => {
    expect(PRD_SCHEMA.version).toBe(CURRENT_SCHEMA_VERSION);
    expect(PLAN_SCHEMA.version).toBe(CURRENT_SCHEMA_VERSION);
    expect(STATE_SCHEMA.version).toBe(CURRENT_SCHEMA_VERSION);
    expect(REPORT_SCHEMA.version).toBe(CURRENT_SCHEMA_VERSION);
  });
});

describe('status constants', () => {
  test('STEP_STATUSES', () => {
    expect(STEP_STATUSES).toEqual([
      'pending',
      'in_progress',
      'completed',
      'failed',
      'skipped',
      'halted',
    ]);
  });

  test('TASK_STATUSES', () => {
    expect(TASK_STATUSES).toEqual(['pending', 'in_progress', 'completed', 'failed', 'halted']);
  });

  test('RUN_STATUSES', () => {
    expect(RUN_STATUSES).toEqual(['pending', 'running', 'completed', 'failed', 'halted']);
  });

  test('VALIDATOR_PHASES', () => {
    expect(VALIDATOR_PHASES).toEqual(['build', 'lint', 'test', 'custom', 'llm']);
  });

  test('VALIDATOR_STATUSES', () => {
    expect(VALIDATOR_STATUSES).toEqual(['pending', 'pass', 'fail', 'skipped']);
  });
});

describe('SCHEMA_BY_KIND', () => {
  test('maps each kind label to its schema', () => {
    expect(SCHEMA_BY_KIND.prd).toBe(PRD_SCHEMA);
    expect(SCHEMA_BY_KIND.plan).toBe(PLAN_SCHEMA);
    expect(SCHEMA_BY_KIND.state).toBe(STATE_SCHEMA);
    expect(SCHEMA_BY_KIND.report).toBe(REPORT_SCHEMA);
  });

  test('exposes exactly four kinds', () => {
    expect(Object.keys(SCHEMA_BY_KIND).sort()).toEqual(['plan', 'prd', 'report', 'state']);
  });
});

describe('inferKind', () => {
  test('prd.json via basename', () => {
    expect(inferKind('a/b/prd.json')).toBe('prd');
  });

  test('plan.json via basename', () => {
    expect(inferKind('a/b/plan.json')).toBe('plan');
  });

  test('state.json via basename', () => {
    expect(inferKind('a/b/state.json')).toBe('state');
  });

  test('reports/<anything>.json -> report', () => {
    expect(inferKind('a/b/reports/1_1_1.json')).toBe('report');
    expect(inferKind('reports/step.json')).toBe('report');
  });

  test('bare basename works the same', () => {
    expect(inferKind('prd.json')).toBe('prd');
    expect(inferKind('state.json')).toBe('state');
  });

  test('unknown filenames return null', () => {
    expect(inferKind('a/b/other.json')).toBeNull();
    expect(inferKind('README.md')).toBeNull();
    // Not under a reports/ parent — the basename alone is not enough.
    expect(inferKind('1_1_1.json')).toBeNull();
  });
});

describe('PRD_SCHEMA shape', () => {
  test('requires schema_version, kind, title', () => {
    const required = Object.entries(PRD_SCHEMA.fields)
      .filter(([, s]) => s.required)
      .map(([n]) => n)
      .sort();
    expect(required).toEqual(['kind', 'schema_version', 'title']);
  });

  test("kind enum is ['prd']", () => {
    expect(PRD_SCHEMA.fields.kind?.enum).toEqual(['prd']);
  });
});

describe('PLAN_SCHEMA shape', () => {
  test('requires schema_version, kind, tasks', () => {
    const required = Object.entries(PLAN_SCHEMA.fields)
      .filter(([, s]) => s.required)
      .map(([n]) => n)
      .sort();
    expect(required).toEqual(['kind', 'schema_version', 'tasks']);
  });

  test('tasks.items requires id, title, wave, steps', () => {
    const taskFields = PLAN_SCHEMA.fields.tasks?.items?.fields ?? {};
    const required = Object.entries(taskFields)
      .filter(([, s]) => s.required)
      .map(([n]) => n)
      .sort();
    expect(required).toEqual(['id', 'steps', 'title', 'wave']);
  });
});

describe('STATE_SCHEMA shape', () => {
  test('run_status enum matches RUN_STATUSES', () => {
    expect(STATE_SCHEMA.fields.run_status?.enum).toEqual(RUN_STATUSES);
  });

  test('dispatch.dispatched items require key, event, timestamp', () => {
    const entryFields = STATE_SCHEMA.fields.dispatch?.fields?.dispatched?.items?.fields ?? {};
    const required = Object.entries(entryFields)
      .filter(([, s]) => s.required)
      .map(([n]) => n)
      .sort();
    expect(required).toEqual(['event', 'key', 'timestamp']);
  });
});

describe('REPORT_SCHEMA shape', () => {
  test('status enum matches STEP_STATUSES', () => {
    expect(REPORT_SCHEMA.fields.status?.enum).toEqual(STEP_STATUSES);
  });

  test('requires step_id, task_id, status', () => {
    const required = Object.entries(REPORT_SCHEMA.fields)
      .filter(([, s]) => s.required)
      .map(([n]) => n)
      .sort();
    expect(required).toEqual(['kind', 'schema_version', 'status', 'step_id', 'task_id']);
  });
});
