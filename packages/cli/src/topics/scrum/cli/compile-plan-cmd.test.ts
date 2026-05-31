/**
 * Unit tests for `scrum compile-plan`. Each test seeds a milestone + tasks +
 * deps directly through `ScrumStore`, then invokes `runCompilePlanCmd` and
 * asserts on the captured stdout JSON (`{ plan, scrum_map, plan_path? }`).
 *
 * Harness mirrors cli.test.ts: capture stdout/stderr, chdir into a fresh
 * `.git`-shaped tmpdir so the store lands under `<tmp>/.prove/prove.db`.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type ScrumStore, openScrumStore } from '../store';
import { runCompilePlanCmd } from './compile-plan-cmd';

interface Captured {
  stdout: string;
  stderr: string;
  exit: number;
}

function withCapture(fn: () => number): Captured {
  let stdout = '';
  let stderr = '';
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stderr.write;
  try {
    const exit = fn();
    return { stdout, stderr, exit };
  } finally {
    process.stdout.write = origStdout;
    process.stderr.write = origStderr;
  }
}

interface PlanShape {
  schema_version: string;
  kind: string;
  mode: string;
  task_id: string;
  tasks: Array<{
    id: string;
    title: string;
    wave: number;
    deps: string[];
    acceptance_criteria: string[];
    steps: Array<{ acceptance_criteria: string[] }>;
  }>;
}

function parsePlan(stdout: string): {
  plan: PlanShape;
  scrum_map: Record<string, string>;
  plan_path?: string;
  map_path?: string;
} {
  return JSON.parse(stdout.trim());
}

let workspace: string;
let originalCwd: string;
let store: ScrumStore;

/** Open the workspace store; seed via the returned handle, then close. */
function openStore(): ScrumStore {
  return openScrumStore({ override: join(workspace, '.prove', 'prove.db') });
}

/** Create a task at a deterministic timestamp so created_at ordering is stable. */
function seedTask(s: ScrumStore, id: string, milestoneId: string, seq: number, status = 'backlog') {
  s.createTask({
    id,
    title: `Task ${id}`,
    milestoneId,
    status: status as never,
    createdAt: `2026-01-01T00:00:${String(seq).padStart(2, '0')}.000Z`,
  });
}

beforeEach(() => {
  originalCwd = process.cwd();
  workspace = mkdtempSync(join(tmpdir(), 'scrum-compile-'));
  mkdirSync(join(workspace, '.git'), { recursive: true });
  process.chdir(workspace);
  store = openStore();
});

afterEach(() => {
  try {
    store.close();
  } catch {
    /* already closed */
  }
  process.chdir(originalCwd);
  try {
    rmSync(workspace, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('runCompilePlanCmd — guards', () => {
  test('missing --milestone exits 1', () => {
    const res = withCapture(() => runCompilePlanCmd({ workspaceRoot: workspace }));
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('--milestone <id> is required');
  });

  test('unknown milestone exits 1', () => {
    const res = withCapture(() =>
      runCompilePlanCmd({ milestone: 'nope', workspaceRoot: workspace }),
    );
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain("unknown milestone 'nope'");
  });

  test('milestone with only done/cancelled tasks exits 1', () => {
    store.createMilestone({ id: 'm1', title: 'M1' });
    seedTask(store, 'a', 'm1', 1, 'done');
    seedTask(store, 'b', 'm1', 2, 'cancelled');
    const res = withCapture(() => runCompilePlanCmd({ milestone: 'm1', workspaceRoot: workspace }));
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('no actionable tasks');
  });
});

describe('runCompilePlanCmd — compilation', () => {
  test('linear chain a->b->c yields waves 1/2/3, mapped deps, simple mode', () => {
    store.createMilestone({ id: 'm1', title: 'M1' });
    seedTask(store, 'a', 'm1', 1);
    seedTask(store, 'b', 'm1', 2);
    seedTask(store, 'c', 'm1', 3);
    store.addDep('a', 'b', 'blocks'); // a blocks b => b depends on a
    store.addDep('b', 'c', 'blocks'); // b blocks c => c depends on b

    const res = withCapture(() => runCompilePlanCmd({ milestone: 'm1', workspaceRoot: workspace }));
    expect(res.exit).toBe(0);
    const { plan, scrum_map } = parsePlan(res.stdout);

    expect(plan.kind).toBe('plan');
    expect(plan.schema_version).toBe('1');
    expect(plan.mode).toBe('simple'); // 3 tasks < 4
    expect(plan.task_id).toBe('m1');
    expect(plan.tasks.map((t) => [t.id, t.wave])).toEqual([
      ['1.1', 1],
      ['2.1', 2],
      ['3.1', 3],
    ]);
    const byId = Object.fromEntries(plan.tasks.map((t) => [t.id, t]));
    expect(byId['1.1'].deps).toEqual([]);
    expect(byId['2.1'].deps).toEqual(['1.1']);
    expect(byId['3.1'].deps).toEqual(['2.1']);
    expect(byId['1.1'].steps).toEqual([
      { id: '1.1.1', title: 'Task a', description: '', acceptance_criteria: [] },
    ]);
    expect(scrum_map).toEqual({ '1.1': 'a', '2.1': 'b', '3.1': 'c' });
  });

  test('diamond with 4 tasks yields full mode and correct wave levels', () => {
    store.createMilestone({ id: 'm1', title: 'M1' });
    seedTask(store, 'a', 'm1', 1);
    seedTask(store, 'b', 'm1', 2);
    seedTask(store, 'c', 'm1', 3);
    seedTask(store, 'd', 'm1', 4);
    store.addDep('a', 'b', 'blocks');
    store.addDep('a', 'c', 'blocks');
    store.addDep('b', 'd', 'blocks');
    store.addDep('c', 'd', 'blocks');

    const res = withCapture(() => runCompilePlanCmd({ milestone: 'm1', workspaceRoot: workspace }));
    expect(res.exit).toBe(0);
    const { plan, scrum_map } = parsePlan(res.stdout);

    expect(plan.mode).toBe('full'); // 4 tasks
    const byScrum = Object.fromEntries(Object.entries(scrum_map).map(([p, s]) => [s, p]));
    const byId = Object.fromEntries(plan.tasks.map((t) => [t.id, t]));
    expect(byId[byScrum.a].wave).toBe(1);
    expect(byId[byScrum.b].wave).toBe(2);
    expect(byId[byScrum.c].wave).toBe(2);
    expect(byId[byScrum.d].wave).toBe(3);
    expect(byId[byScrum.d].deps.sort()).toEqual([byScrum.b, byScrum.c].sort());
  });

  test('dependency on a done (out-of-scope) task is dropped as satisfied', () => {
    store.createMilestone({ id: 'm1', title: 'M1' });
    seedTask(store, 'a', 'm1', 1, 'done');
    seedTask(store, 'b', 'm1', 2);
    store.addDep('a', 'b', 'blocks'); // b depends on a, but a is done

    const res = withCapture(() => runCompilePlanCmd({ milestone: 'm1', workspaceRoot: workspace }));
    expect(res.exit).toBe(0);
    const { plan, scrum_map } = parsePlan(res.stdout);
    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0].wave).toBe(1);
    expect(plan.tasks[0].deps).toEqual([]);
    expect(scrum_map).toEqual({ '1.1': 'b' });
  });

  test('dependency cycle exits 1', () => {
    store.createMilestone({ id: 'm1', title: 'M1' });
    seedTask(store, 'a', 'm1', 1);
    seedTask(store, 'b', 'm1', 2);
    store.addDep('a', 'b', 'blocks');
    store.addDep('b', 'a', 'blocks'); // cycle

    const res = withCapture(() => runCompilePlanCmd({ milestone: 'm1', workspaceRoot: workspace }));
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('dependency cycle');
  });

  test('--out writes plan.json and scrum-map.json sibling', () => {
    store.createMilestone({ id: 'm1', title: 'M1' });
    seedTask(store, 'a', 'm1', 1);
    seedTask(store, 'b', 'm1', 2);
    store.addDep('a', 'b', 'blocks');

    const outDir = join(workspace, '.prove', 'runs', 'feature', 'm1');
    const planPath = join(outDir, 'plan.json');
    const res = withCapture(() =>
      runCompilePlanCmd({ milestone: 'm1', out: planPath, workspaceRoot: workspace }),
    );
    expect(res.exit).toBe(0);

    const mapPath = join(outDir, 'scrum-map.json');
    expect(existsSync(planPath)).toBe(true);
    expect(existsSync(mapPath)).toBe(true);

    const writtenPlan = JSON.parse(readFileSync(planPath, 'utf8'));
    expect(writtenPlan.kind).toBe('plan');
    expect(writtenPlan.tasks).toHaveLength(2);
    const writtenMap = JSON.parse(readFileSync(mapPath, 'utf8'));
    expect(writtenMap).toEqual({ '1.1': 'a', '2.1': 'b' });

    const { plan_path, map_path } = parsePlan(res.stdout);
    expect(plan_path).toBe(planPath);
    expect(map_path).toBe(mapPath);
  });

  test('forwards a task acceptance criteria texts (active only) into plan + step', () => {
    store.createMilestone({ id: 'm1', title: 'M1' });
    store.createTask({
      id: 'a',
      title: 'Task a',
      milestoneId: 'm1',
      createdAt: '2026-01-01T00:00:01.000Z',
      acceptance: {
        criteria: [
          {
            id: 'c1',
            text: 'builds clean',
            verifies_by: 'bash',
            check: 'bun run build',
            status: 'active',
            idempotent: true,
            superseded_by: null,
            reason: null,
            inherited_from: null,
          },
          {
            id: 'c2',
            text: 'dropped criterion',
            verifies_by: 'bash',
            check: 'true',
            status: 'superseded',
            idempotent: true,
            superseded_by: null,
            reason: 'obsolete',
            inherited_from: null,
          },
        ],
      },
    });

    const res = withCapture(() => runCompilePlanCmd({ milestone: 'm1', workspaceRoot: workspace }));
    expect(res.exit).toBe(0);
    const { plan } = parsePlan(res.stdout);
    const task = plan.tasks[0];
    if (!task) throw new Error('expected one plan task');
    // Superseded criterion is excluded; only the active text forwards.
    expect(task.acceptance_criteria).toEqual(['builds clean']);
    expect(task.steps[0]?.acceptance_criteria).toEqual(['builds clean']);
  });

  test('task with no acceptance forwards an empty criteria list', () => {
    store.createMilestone({ id: 'm1', title: 'M1' });
    seedTask(store, 'a', 'm1', 1);
    const res = withCapture(() => runCompilePlanCmd({ milestone: 'm1', workspaceRoot: workspace }));
    const { plan } = parsePlan(res.stdout);
    expect(plan.tasks[0]?.acceptance_criteria).toEqual([]);
  });
});
