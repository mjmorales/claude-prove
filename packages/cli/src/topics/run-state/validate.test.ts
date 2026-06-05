/**
 * validate.ts tests — entry-point wrapper that bridges JSON on disk /
 * parsed data to the field-spec validator-engine, including the file-I/O
 * edge cases.
 */

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateData, validateFile } from './validate';

const SCHEMA_FIXTURES = join(import.meta.dir, '__fixtures__/schemas');

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), 'run-state-validate-'));
}

describe('validateData', () => {
  test('missing required fields on plan', () => {
    const r = validateData({}, 'plan');
    expect(r.ok).toBe(false);
    expect(r.kind).toBe('plan');
    expect(r.version).toBe('4');
    expect(r.errors).toEqual([
      '  ERROR: schema_version: required field is missing',
      '  ERROR: kind: required field is missing',
      '  ERROR: tasks: required field is missing',
    ]);
  });

  test('enum violation on state.run_status', () => {
    const r = validateData(
      {
        schema_version: '1',
        kind: 'state',
        run_status: 'weird',
        slug: 'x',
        updated_at: 't',
        tasks: [],
      },
      'state',
    );
    expect(r.ok).toBe(false);
    expect(r.errors).toContain(
      "  ERROR: run_status: must be one of ['pending', 'running', 'completed', 'failed', 'halted'], got 'weird'",
    );
  });

  test('nested wrong type under tasks[].wave', () => {
    const r = validateData(
      {
        schema_version: '1',
        kind: 'plan',
        tasks: [{ id: '1.1', title: 't', wave: 'not-int', steps: [] }],
      },
      'plan',
    );
    expect(r.ok).toBe(false);
    expect(r.errors).toContain('  ERROR: tasks[0].wave: expected int, got str');
  });

  test('a valid execution directive block passes', () => {
    const r = validateData(
      {
        schema_version: '4',
        kind: 'plan',
        tasks: [
          {
            id: '1.1',
            title: 't',
            wave: 1,
            steps: [],
            execution: {
              retry: { max: 2 },
              loop: { max_iterations: 3 },
              fanout: { batch_size: 4 },
              on_fail: '1.2',
              concurrency: 'singleton',
            },
          },
        ],
      },
      'plan',
    );
    expect(r.ok).toBe(true);
  });

  test('rejects an off-enum execution.concurrency', () => {
    const r = validateData(
      {
        schema_version: '4',
        kind: 'plan',
        tasks: [{ id: '1.1', title: 't', wave: 1, steps: [], execution: { concurrency: 'bogus' } }],
      },
      'plan',
    );
    expect(r.ok).toBe(false);
    expect(r.errors).toContain(
      "  ERROR: tasks[0].execution.concurrency: must be one of ['parallel', 'singleton'], got 'bogus'",
    );
  });

  test('valid state passes clean', () => {
    const r = validateData(
      {
        schema_version: '1',
        kind: 'state',
        run_status: 'pending',
        slug: 's',
        updated_at: 't',
        tasks: [],
      },
      'state',
    );
    expect(r).toEqual({ ok: true, kind: 'state', version: '4', errors: [] });
  });

  test('unknown kind returns structured error', () => {
    const r = validateData({ x: 1 }, 'nonexistent');
    expect(r.ok).toBe(false);
    expect(r.kind).toBe('nonexistent');
    expect(r.errors).toEqual(["  ERROR: : unknown schema kind: 'nonexistent'"]);
  });

  test('non-object top-level fails cleanly', () => {
    const r = validateData(['not', 'an', 'object'], 'state');
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual(['  ERROR: : top-level value must be a JSON object']);
  });

  test('plan validates when task_id is absent (back-compat)', () => {
    const r = validateData(
      {
        schema_version: '1',
        kind: 'plan',
        tasks: [
          {
            id: '1.1',
            title: 't',
            wave: 1,
            steps: [{ id: '1.1.1', title: 's' }],
          },
        ],
      },
      'plan',
    );
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  test('plan validates when task_id is a non-empty string', () => {
    const r = validateData(
      {
        schema_version: '1',
        kind: 'plan',
        task_id: 'SCRUM-42',
        tasks: [
          {
            id: '1.1',
            title: 't',
            wave: 1,
            steps: [{ id: '1.1.1', title: 's' }],
          },
        ],
      },
      'plan',
    );
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  test('plan rejects empty task_id', () => {
    const r = validateData(
      {
        schema_version: '1',
        kind: 'plan',
        task_id: '',
        tasks: [
          {
            id: '1.1',
            title: 't',
            wave: 1,
            steps: [{ id: '1.1.1', title: 's' }],
          },
        ],
      },
      'plan',
    );
    expect(r.ok).toBe(false);
    expect(r.errors).toContain("  ERROR: task_id: must be a non-empty string, got ''");
  });

  test('plan rejects non-string task_id', () => {
    const r = validateData(
      {
        schema_version: '1',
        kind: 'plan',
        task_id: 42,
        tasks: [
          {
            id: '1.1',
            title: 't',
            wave: 1,
            steps: [{ id: '1.1.1', title: 's' }],
          },
        ],
      },
      'plan',
    );
    expect(r.ok).toBe(false);
    expect(r.errors).toContain('  ERROR: task_id: expected str, got int');
  });

  test('plan accepts nested tasks[n].task_id under strict (gh#32)', () => {
    // A plan carrying the scrum id nested at tasks[n].task_id must pass strict
    // validation rather than failing on an unknown field, so the scrum
    // reconciler can see and track such a run.
    const r = validateData(
      {
        schema_version: '1',
        kind: 'plan',
        tasks: [
          {
            id: '1.1',
            title: 't',
            wave: 1,
            task_id: 'SCRUM-42',
            steps: [{ id: '1.1.1', title: 's' }],
          },
        ],
      },
      'plan',
      true,
    );
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  test('plan rejects empty nested tasks[n].task_id', () => {
    const r = validateData(
      {
        schema_version: '1',
        kind: 'plan',
        tasks: [
          {
            id: '1.1',
            title: 't',
            wave: 1,
            task_id: '',
            steps: [{ id: '1.1.1', title: 's' }],
          },
        ],
      },
      'plan',
    );
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('task_id') && e.includes('non-empty string'))).toBe(
      true,
    );
  });

  test('minimal valid report', () => {
    const r = validateData(
      {
        schema_version: '1',
        kind: 'report',
        step_id: '1.1.1',
        task_id: '1.1',
        status: 'completed',
      },
      'report',
    );
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });
});

describe('validateFile', () => {
  test('round-trip on disk with inferred kind', () => {
    const dir = makeTmp();
    try {
      const p = join(dir, 'state.json');
      writeFileSync(
        p,
        JSON.stringify({
          schema_version: '1',
          kind: 'state',
          run_status: 'pending',
          slug: 's',
          updated_at: 't',
          tasks: [],
        }),
      );
      const r = validateFile(p);
      expect(r.ok).toBe(true);
      expect(r.kind).toBe('state');
      expect(r.errors).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('invalid JSON surfaces parse error', () => {
    const dir = makeTmp();
    try {
      const p = join(dir, 'state.json');
      writeFileSync(p, '{not json');
      const r = validateFile(p);
      expect(r.ok).toBe(false);
      expect(r.errors.length).toBe(1);
      expect(r.errors[0]).toContain('invalid JSON');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('missing file reports file not found', () => {
    const p = join(tmpdir(), `definitely-not-there-${Math.random()}`, 'state.json');
    const r = validateFile(p);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain('file not found');
  });

  test('unknown basename requires explicit kind', () => {
    const dir = makeTmp();
    try {
      const p = join(dir, 'other.json');
      writeFileSync(p, '{}');
      const r = validateFile(p);
      expect(r.ok).toBe(false);
      expect(r.errors[0]).toContain('cannot infer schema kind');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('explicit kind overrides inference', () => {
    const dir = makeTmp();
    try {
      const p = join(dir, 'other.json');
      writeFileSync(
        p,
        JSON.stringify({
          schema_version: '1',
          kind: 'report',
          step_id: '1.1.1',
          task_id: '1.1',
          status: 'completed',
        }),
      );
      const r = validateFile(p, 'report');
      expect(r.ok).toBe(true);
      expect(r.kind).toBe('report');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('parity fixtures — TS matches Python schema captures byte-for-byte', () => {
    const pyDir = join(SCHEMA_FIXTURES, 'python-captures');
    const tsDir = join(SCHEMA_FIXTURES, 'ts-captures');
    const names = readdirSync(pyDir).filter((f) => f.endsWith('.txt'));
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const py = readFileSync(join(pyDir, name), 'utf8');
      const ts = readFileSync(join(tsDir, name), 'utf8');
      expect(ts, `capture ${name} diverged`).toBe(py);
    }
  });

  test('reports/<name>.json infers report kind', () => {
    const dir = makeTmp();
    try {
      const reportsDir = join(dir, 'reports');
      mkdirSync(reportsDir);
      const p = join(reportsDir, '1_1_1.json');
      writeFileSync(
        p,
        JSON.stringify({
          schema_version: '1',
          kind: 'report',
          step_id: '1.1.1',
          task_id: '1.1',
          status: 'completed',
        }),
      );
      const r = validateFile(p);
      expect(r.ok).toBe(true);
      expect(r.kind).toBe('report');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
