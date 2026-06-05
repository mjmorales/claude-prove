/**
 * schema-migrate.ts tests — run-state artifact version chain (plan.json etc).
 *
 * Pins: version bump, `bounds`-absent default preservation, data passthrough,
 * and the full chain from v1.
 */

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MIGRATIONS,
  type MigrationFn,
  canAdvanceStructurally,
  detectVersion,
  migrateAllArtifacts,
  migrateRunArtifacts,
  planMigration,
} from './schema-migrate';
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

  // Exercise the single hop directly: planMigration now walks past v2 to v3,
  // so version-pinned assertions use the registered '1_to_2' migrator.
  const v1ToV2 = MIGRATIONS['1_to_2'] as MigrationFn;

  test('bumps schema_version to "2"', () => {
    const [out, changes] = v1ToV2(v1Plan);
    expect(out.schema_version).toBe('2');
    expect(changes).toHaveLength(1);
    expect(changes[0].path).toBe('schema_version');
  });

  test('leaves bounds absent (absent = current behavior, no injection)', () => {
    const [out] = v1ToV2(v1Plan);
    const tasks = out.tasks as Record<string, unknown>[];
    expect('bounds' in tasks[0]).toBe(false);
  });

  test('preserves all other fields byte-for-byte', () => {
    const [out] = v1ToV2(v1Plan);
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
    const [out] = v1ToV2(withBounds);
    const tasks = out.tasks as Record<string, unknown>[];
    expect(tasks[0].bounds).toEqual(withBounds.tasks[0].bounds);
  });
});

describe('v2 -> v3', () => {
  const v2ToV3 = MIGRATIONS['2_to_3'] as MigrationFn;

  const v2Plan = {
    schema_version: '2',
    kind: 'plan',
    mode: 'full',
    tasks: [
      {
        id: '1.1',
        title: 'First',
        wave: 1,
        deps: [],
        acceptance_criteria: ['builds clean', 'tests pass'],
        worktree: { path: '/tmp/wt', branch: 'task/x/1' },
        steps: [{ id: '1.1.1', title: 'Step', acceptance_criteria: ['step holds'] }],
      },
    ],
  };

  test('bumps schema_version to "3"', () => {
    const [out, changes] = v2ToV3(v2Plan);
    expect(out.schema_version).toBe('3');
    expect(changes[0].path).toBe('schema_version');
  });

  test('wraps each task acceptance_criteria string as { text }', () => {
    const [out] = v2ToV3(v2Plan);
    const tasks = out.tasks as Record<string, unknown>[];
    expect(tasks[0].acceptance_criteria).toEqual([
      { text: 'builds clean' },
      { text: 'tests pass' },
    ]);
  });

  test('wraps step acceptance_criteria strings too', () => {
    const [out] = v2ToV3(v2Plan);
    const tasks = out.tasks as Record<string, unknown>[];
    const steps = tasks[0].steps as Record<string, unknown>[];
    expect(steps[0].acceptance_criteria).toEqual([{ text: 'step holds' }]);
  });

  test('records a criteria-conversion change when strings were wrapped', () => {
    const [, changes] = v2ToV3(v2Plan);
    const acChange = changes.find((c) => c.path === 'tasks[].acceptance_criteria');
    expect(acChange).toBeDefined();
  });

  test('already-structured items pass through (idempotent on v3 data)', () => {
    const structured = {
      schema_version: '2',
      kind: 'plan',
      tasks: [
        {
          id: '1.1',
          title: 'T',
          acceptance_criteria: [{ text: 'already', verifies_by: 'bash', check: 'x' }],
          steps: [],
        },
      ],
    };
    const [out, changes] = v2ToV3(structured);
    const tasks = out.tasks as Record<string, unknown>[];
    expect(tasks[0].acceptance_criteria).toEqual([
      { text: 'already', verifies_by: 'bash', check: 'x' },
    ]);
    expect(changes.find((c) => c.path === 'tasks[].acceptance_criteria')).toBeUndefined();
  });

  test('pure version bump for prd/state/report (no acceptance_criteria on tasks)', () => {
    const prd = { schema_version: '2', kind: 'prd', title: 'T', acceptance_criteria: ['a', 'b'] };
    const [out, changes] = v2ToV3(prd);
    // PRD acceptance_criteria are top-level strings, NOT plan tasks — untouched.
    expect(out.acceptance_criteria).toEqual(['a', 'b']);
    expect(out.schema_version).toBe('3');
    expect(changes).toHaveLength(1);
  });

  test('does not mutate the input', () => {
    const input = JSON.parse(JSON.stringify(v2Plan));
    v2ToV3(v2Plan);
    expect(v2Plan).toEqual(input);
  });
});

describe('v3 -> v4', () => {
  const v3ToV4 = MIGRATIONS['3_to_4'] as MigrationFn;
  const v3Plan = {
    schema_version: '3',
    kind: 'plan',
    mode: 'full',
    tasks: [
      {
        id: '1.1',
        title: 'First',
        wave: 1,
        acceptance_criteria: [{ text: 'builds clean' }],
        steps: [{ id: '1.1.1', title: 'Step', acceptance_criteria: [] }],
      },
    ],
  };

  test('bumps schema_version to "4"', () => {
    const [out, changes] = v3ToV4(v3Plan);
    expect(out.schema_version).toBe('4');
    expect(changes).toHaveLength(1);
    expect(changes[0].path).toBe('schema_version');
  });

  test('leaves execution absent (absent = run-once/no-retry/halt-on-fail/parallel, no injection)', () => {
    const [out] = v3ToV4(v3Plan);
    const tasks = out.tasks as Record<string, unknown>[];
    expect('execution' in tasks[0]).toBe(false);
  });

  test('preserves all other fields byte-for-byte', () => {
    const [out] = v3ToV4(v3Plan);
    expect(out.kind).toBe('plan');
    expect(out.mode).toBe('full');
    expect(out.tasks).toEqual(v3Plan.tasks);
  });

  test('passes an existing execution block through untouched', () => {
    const withExec = {
      schema_version: '3',
      kind: 'plan',
      tasks: [
        {
          id: '1.1',
          title: 'Looped',
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
    };
    const [out] = v3ToV4(withExec);
    const tasks = out.tasks as Record<string, unknown>[];
    expect(tasks[0].execution).toEqual(withExec.tasks[0].execution);
  });
});

describe('full chain to CURRENT_SCHEMA_VERSION', () => {
  test('a v1 artifact lands on the current version', () => {
    const [out] = planMigration({ schema_version: '1', kind: 'plan', tasks: [] });
    expect(out.schema_version).toBe(CURRENT_SCHEMA_VERSION);
  });

  test('a v1 plan with string criteria walks to v3 structured criteria', () => {
    const v1Plan = {
      schema_version: '1',
      kind: 'plan',
      mode: 'simple',
      tasks: [
        {
          id: '1.1',
          title: 'First',
          wave: 1,
          acceptance_criteria: ['legacy criterion'],
          steps: [{ id: '1.1.1', title: 'Step', acceptance_criteria: ['legacy step criterion'] }],
        },
      ],
    };
    const [out] = planMigration(v1Plan);
    expect(out.schema_version).toBe(CURRENT_SCHEMA_VERSION);
    const tasks = out.tasks as Record<string, unknown>[];
    expect(tasks[0].acceptance_criteria).toEqual([{ text: 'legacy criterion' }]);
    const steps = tasks[0].steps as Record<string, unknown>[];
    expect(steps[0].acceptance_criteria).toEqual([{ text: 'legacy step criterion' }]);
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

describe('canAdvanceStructurally', () => {
  test('a version with a registered first hop can advance', () => {
    expect(canAdvanceStructurally('1')).toBe(true);
    expect(canAdvanceStructurally('3')).toBe(true);
  });

  test('the current version has no next hop and cannot advance', () => {
    expect(canAdvanceStructurally(CURRENT_SCHEMA_VERSION)).toBe(false);
  });

  test('a version with no registered first hop cannot advance', () => {
    withoutHop('3_to_4', () => {
      expect(canAdvanceStructurally('3')).toBe(false);
    });
  });
});

/** Remove a structural hop for the duration of one test, then restore it. */
function withoutHop(key: string, body: () => void): void {
  const saved = MIGRATIONS[key];
  delete MIGRATIONS[key];
  try {
    body();
  } finally {
    if (saved) MIGRATIONS[key] = saved;
  }
}

describe('migrateRunArtifacts / migrateAllArtifacts', () => {
  let root: string;

  function setup(): string {
    root = mkdtempSync(join(tmpdir(), 'schema-migrate-artifacts-'));
    return root;
  }

  function writeArtifact(runDir: string, name: string, data: Record<string, unknown>): void {
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, name), `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  }

  test('bumps a behind-version plan.json in place and preserves data', () => {
    const runDir = join(setup(), 'main', 'a');
    writeArtifact(runDir, 'plan.json', {
      schema_version: '3',
      kind: 'plan',
      tasks: [{ id: '1.1', title: 'T' }],
    });
    try {
      const result = migrateRunArtifacts(runDir);
      expect(result.bumped).toEqual(['plan.json']);
      const out = JSON.parse(readFileSync(join(runDir, 'plan.json'), 'utf8'));
      expect(out.schema_version).toBe(CURRENT_SCHEMA_VERSION);
      expect(out.tasks[0].id).toBe('1.1');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a current artifact is a no-op (no bump, no rewrite)', () => {
    const runDir = join(setup(), 'main', 'a');
    const body = `${JSON.stringify({ schema_version: CURRENT_SCHEMA_VERSION, kind: 'plan' }, null, 2)}\n`;
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'plan.json'), body, 'utf8');
    try {
      const result = migrateRunArtifacts(runDir);
      expect(result.bumped).toEqual([]);
      expect(readFileSync(join(runDir, 'plan.json'), 'utf8')).toBe(body);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('--dry-run reports the bump without writing', () => {
    const runDir = join(setup(), 'main', 'a');
    const body = `${JSON.stringify({ schema_version: '3', kind: 'plan' }, null, 2)}\n`;
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'plan.json'), body, 'utf8');
    try {
      const result = migrateRunArtifacts(runDir, { dryRun: true });
      expect(result.bumped).toEqual(['plan.json']);
      expect(readFileSync(join(runDir, 'plan.json'), 'utf8')).toBe(body);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a corrupt artifact records a per-run error without aborting', () => {
    const runDir = join(setup(), 'main', 'a');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'plan.json'), '{ not json', 'utf8');
    try {
      const result = migrateRunArtifacts(runDir);
      expect(result.error).toBeDefined();
      expect(result.bumped).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('migrateAllArtifacts sweeps every behind-version run dir', () => {
    setup();
    const runsRoot = join(root, '.prove', 'runs');
    writeArtifact(join(runsRoot, 'main', 'a'), 'plan.json', { schema_version: '3', kind: 'plan' });
    writeArtifact(join(runsRoot, 'feat', 'b'), 'prd.json', { schema_version: '2', kind: 'prd' });
    writeArtifact(join(runsRoot, 'main', 'c'), 'state.json', {
      schema_version: CURRENT_SCHEMA_VERSION,
      kind: 'state',
    });
    try {
      const results = migrateAllArtifacts(runsRoot);
      const bumpedRuns = results.filter((r) => r.bumped.length > 0);
      expect(bumpedRuns).toHaveLength(2);
      expect(
        JSON.parse(readFileSync(join(runsRoot, 'main', 'a', 'plan.json'), 'utf8')).schema_version,
      ).toBe(CURRENT_SCHEMA_VERSION);
      expect(
        JSON.parse(readFileSync(join(runsRoot, 'feat', 'b', 'prd.json'), 'utf8')).schema_version,
      ).toBe(CURRENT_SCHEMA_VERSION);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a missing runs root yields an empty sweep', () => {
    expect(migrateAllArtifacts(join(tmpdir(), 'no-such-runs-root-xyz'))).toEqual([]);
  });
});
