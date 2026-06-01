/**
 * schema-migrate.ts tests — run-state artifact version chain (plan.json etc).
 *
 * Pins: version bump, `bounds`-absent default preservation, data passthrough,
 * and the full chain from v1.
 */

import { describe, expect, test } from 'bun:test';
import { MIGRATIONS, detectVersion, planMigration } from './schema-migrate';
import { CURRENT_SCHEMA_VERSION } from './schemas';

describe('detectVersion', () => {
  test('reads an explicit schema_version', () => {
    expect(detectVersion({ schema_version: '1' })).toBe('1');
    expect(detectVersion({ schema_version: '2' })).toBe('2');
  });

  test('treats a missing schema_version as v1 (first versioned schema)', () => {
    expect(detectVersion({ kind: 'plan' })).toBe('1');
  });
});

describe('v1 -> v2', () => {
  const v1Plan = {
    schema_version: '1',
    kind: 'plan',
    mode: 'full',
    tasks: [
      {
        id: '1.1',
        title: 'First',
        wave: 1,
        deps: [],
        worktree: { path: '/tmp/wt', branch: 'task/x/1' },
        steps: [{ id: '1.1.1', title: 'Step', acceptance_criteria: [] }],
      },
    ],
  };

  test('bumps schema_version to "2"', () => {
    const [out, changes] = planMigration(v1Plan);
    expect(out.schema_version).toBe('2');
    expect(changes).toHaveLength(1);
    expect(changes[0].path).toBe('schema_version');
  });

  test('leaves bounds absent (absent = current behavior, no injection)', () => {
    const [out] = planMigration(v1Plan);
    const tasks = out.tasks as Record<string, unknown>[];
    expect('bounds' in tasks[0]).toBe(false);
  });

  test('preserves all other fields byte-for-byte', () => {
    const [out] = planMigration(v1Plan);
    expect(out.kind).toBe('plan');
    expect(out.mode).toBe('full');
    expect(out.tasks).toEqual(v1Plan.tasks);
  });

  test('does not mutate the input', () => {
    const input = { ...v1Plan };
    planMigration(input);
    expect(input.schema_version).toBe('1');
  });

  test('passes an existing bounds field through untouched', () => {
    const withBounds = {
      schema_version: '1',
      kind: 'plan',
      mode: 'simple',
      tasks: [
        {
          id: '1.1',
          title: 'Bounded',
          wave: 1,
          steps: [],
          bounds: {
            write: ['src/auth/**'],
            tools: { deny: ['Bash(git push *)'] },
            budgets: { tokens: 200000 },
          },
        },
      ],
    };
    const [out] = planMigration(withBounds);
    const tasks = out.tasks as Record<string, unknown>[];
    expect(tasks[0].bounds).toEqual(withBounds.tasks[0].bounds);
  });
});

describe('full chain to CURRENT_SCHEMA_VERSION', () => {
  test('a v1 artifact lands on the current version', () => {
    const [out] = planMigration({ schema_version: '1', kind: 'plan', tasks: [] });
    expect(out.schema_version).toBe(CURRENT_SCHEMA_VERSION);
  });

  test('an already-current artifact is a no-op (no backup, no changes)', () => {
    const current = { schema_version: CURRENT_SCHEMA_VERSION, kind: 'plan', tasks: [] };
    const [out, changes] = planMigration(current);
    expect(changes).toEqual([]);
    expect(out.schema_version).toBe(CURRENT_SCHEMA_VERSION);
  });

  test('every registered hop targets the version named in its key', () => {
    for (const [key, fn] of Object.entries(MIGRATIONS)) {
      const target = key.split('_to_')[1];
      const [out] = fn({ schema_version: key.split('_to_')[0] });
      expect(out.schema_version).toBe(target);
    }
  });
});
