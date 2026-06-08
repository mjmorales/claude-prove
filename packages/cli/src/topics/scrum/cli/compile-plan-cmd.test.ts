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

async function withCapture(fn: () => number | Promise<number>): Promise<Captured> {
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
    const exit = await fn();
    return { stdout, stderr, exit };
  } finally {
    process.stdout.write = origStdout;
    process.stderr.write = origStderr;
  }
}

interface PlanCriterion {
  id: string;
  text: string;
  verifies_by: string;
  check: string;
  status: string;
  idempotent: boolean;
}

interface PlanShape {
  schema_version: string;
  kind: string;
  mode: string;
  task_id?: string;
  tasks: Array<{
    id: string;
    title: string;
    wave: number;
    deps: string[];
    acceptance_criteria: PlanCriterion[];
    bounds?: unknown;
    team_slug?: string;
    steps: Array<{ acceptance_criteria: PlanCriterion[] }>;
  }>;
}

function parsePlan(stdout: string): {
  plan: PlanShape;
  scrum_map: Record<string, string>;
  team_map: Record<string, string>;
  plan_path?: string;
  map_path?: string;
  team_map_path?: string;
} {
  return JSON.parse(stdout.trim());
}

let workspace: string;
let originalCwd: string;
let store: ScrumStore;

/** Open the workspace store; seed via the returned handle, then close. */
async function openStore(): Promise<ScrumStore> {
  return await openScrumStore({ override: join(workspace, '.prove', 'prove.db') });
}

/** Create a task at a deterministic timestamp so created_at ordering is stable. */
async function seedTask(s: ScrumStore, id: string, milestoneId: string, seq: number, status = 'backlog') {
  await s.createTask({
    id,
    title: `Task ${id}`,
    milestoneId,
    status: status as never,
    createdAt: `2026-01-01T00:00:${String(seq).padStart(2, '0')}.000Z`,
  });
}

beforeEach(async () => {
  originalCwd = process.cwd();
  workspace = mkdtempSync(join(tmpdir(), 'scrum-compile-'));
  mkdirSync(join(workspace, '.git'), { recursive: true });
  process.chdir(workspace);
  store = await openStore();
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
  test('missing --milestone exits 1', async () => {
    const res = await withCapture(() => runCompilePlanCmd({ workspaceRoot: workspace }));
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('--milestone <id> is required');
  });

  test('unknown milestone exits 1', async () => {
    const res = await withCapture(() =>
      runCompilePlanCmd({ milestone: 'nope', workspaceRoot: workspace }),
    );
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain("unknown milestone 'nope'");
  });

  test('milestone with only done/cancelled tasks exits 1', async () => {
    await store.createMilestone({ id: 'm1', title: 'M1' });
    await seedTask(store, 'a', 'm1', 1, 'done');
    await seedTask(store, 'b', 'm1', 2, 'cancelled');
    const res = await withCapture(() => runCompilePlanCmd({ milestone: 'm1', workspaceRoot: workspace }));
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('no actionable tasks');
  });
});

describe('runCompilePlanCmd — compilation', () => {
  test('linear chain a->b->c yields waves 1/2/3, mapped deps, simple mode', async () => {
    await store.createMilestone({ id: 'm1', title: 'M1' });
    await seedTask(store, 'a', 'm1', 1);
    await seedTask(store, 'b', 'm1', 2);
    await seedTask(store, 'c', 'm1', 3);
    await store.addDep('a', 'b', 'blocks'); // a blocks b => b depends on a
    await store.addDep('b', 'c', 'blocks'); // b blocks c => c depends on b

    const res = await withCapture(() => runCompilePlanCmd({ milestone: 'm1', workspaceRoot: workspace }));
    expect(res.exit).toBe(0);
    const { plan, scrum_map } = parsePlan(res.stdout);

    expect(plan.kind).toBe('plan');
    expect(plan.schema_version).toBe('3');
    expect(plan.mode).toBe('simple'); // 3 tasks < 4
    // task_id is intentionally NOT set to the milestone id — run-state reserves
    // it for a single scrum task id, and a milestone plan fans out to many.
    expect(plan.task_id).toBeUndefined();
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

  test('diamond with 4 tasks yields full mode and correct wave levels', async () => {
    await store.createMilestone({ id: 'm1', title: 'M1' });
    await seedTask(store, 'a', 'm1', 1);
    await seedTask(store, 'b', 'm1', 2);
    await seedTask(store, 'c', 'm1', 3);
    await seedTask(store, 'd', 'm1', 4);
    await store.addDep('a', 'b', 'blocks');
    await store.addDep('a', 'c', 'blocks');
    await store.addDep('b', 'd', 'blocks');
    await store.addDep('c', 'd', 'blocks');

    const res = await withCapture(() => runCompilePlanCmd({ milestone: 'm1', workspaceRoot: workspace }));
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

  test('dependency on a done (out-of-scope) task is dropped as satisfied', async () => {
    await store.createMilestone({ id: 'm1', title: 'M1' });
    await seedTask(store, 'a', 'm1', 1, 'done');
    await seedTask(store, 'b', 'm1', 2);
    await store.addDep('a', 'b', 'blocks'); // b depends on a, but a is done

    const res = await withCapture(() => runCompilePlanCmd({ milestone: 'm1', workspaceRoot: workspace }));
    expect(res.exit).toBe(0);
    const { plan, scrum_map } = parsePlan(res.stdout);
    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0].wave).toBe(1);
    expect(plan.tasks[0].deps).toEqual([]);
    expect(scrum_map).toEqual({ '1.1': 'b' });
  });

  test('dependency cycle exits 1', async () => {
    await store.createMilestone({ id: 'm1', title: 'M1' });
    await seedTask(store, 'a', 'm1', 1);
    await seedTask(store, 'b', 'm1', 2);
    await store.addDep('a', 'b', 'blocks');
    await store.addDep('b', 'a', 'blocks'); // cycle

    const res = await withCapture(() => runCompilePlanCmd({ milestone: 'm1', workspaceRoot: workspace }));
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('dependency cycle');
  });

  test('--out writes plan.json and scrum-map.json sibling', async () => {
    await store.createMilestone({ id: 'm1', title: 'M1' });
    await seedTask(store, 'a', 'm1', 1);
    await seedTask(store, 'b', 'm1', 2);
    await store.addDep('a', 'b', 'blocks');

    const outDir = join(workspace, '.prove', 'runs', 'feature', 'm1');
    const planPath = join(outDir, 'plan.json');
    const res = await withCapture(() =>
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

  test('forwards full structured acceptance criteria (active only) into plan + step', async () => {
    await store.createMilestone({ id: 'm1', title: 'M1' });
    await store.createTask({
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

    const res = await withCapture(() => runCompilePlanCmd({ milestone: 'm1', workspaceRoot: workspace }));
    expect(res.exit).toBe(0);
    const { plan } = parsePlan(res.stdout);
    const task = plan.tasks[0];
    if (!task) throw new Error('expected one plan task');
    // Superseded criterion is excluded; the active criterion forwards in full
    // (id/text/verifies_by/check/status/idempotent) — not just text. The scrum
    // supersession bookkeeping (superseded_by/reason/inherited_from) is dropped.
    const forwarded = {
      id: 'c1',
      text: 'builds clean',
      verifies_by: 'bash',
      check: 'bun run build',
      status: 'active',
      idempotent: true,
    };
    expect(task.acceptance_criteria).toEqual([forwarded]);
    expect(task.steps[0]?.acceptance_criteria).toEqual([forwarded]);
  });

  test('task with no acceptance forwards an empty criteria list', async () => {
    await store.createMilestone({ id: 'm1', title: 'M1' });
    await seedTask(store, 'a', 'm1', 1);
    const res = await withCapture(() => runCompilePlanCmd({ milestone: 'm1', workspaceRoot: workspace }));
    const { plan } = parsePlan(res.stdout);
    expect(plan.tasks[0]?.acceptance_criteria).toEqual([]);
  });

  test('forwards declared bounds verbatim into the plan task', async () => {
    const bounds = {
      read: ['src/auth/**'],
      write: ['src/auth/**'],
      tools: { allow: ['Bash(go test *)'], deny: ['Bash(git push *)'] },
      budgets: { tokens: 200000, tool_calls: 100, wall_clock_s: 1800 },
    };
    await store.createMilestone({ id: 'm1', title: 'M1' });
    await store.createTask({
      id: 'a',
      title: 'Task a',
      milestoneId: 'm1',
      createdAt: '2026-01-01T00:00:01.000Z',
      bounds,
    });

    const res = await withCapture(() => runCompilePlanCmd({ milestone: 'm1', workspaceRoot: workspace }));
    expect(res.exit).toBe(0);
    const { plan } = parsePlan(res.stdout);
    expect(plan.tasks[0]?.bounds).toEqual(bounds);
  });

  test('task with no bounds emits no bounds key (absent = unbounded)', async () => {
    await store.createMilestone({ id: 'm1', title: 'M1' });
    await seedTask(store, 'a', 'm1', 1);
    const res = await withCapture(() => runCompilePlanCmd({ milestone: 'm1', workspaceRoot: workspace }));
    expect(res.exit).toBe(0);
    const { plan } = parsePlan(res.stdout);
    const task = plan.tasks[0];
    if (!task) throw new Error('expected one plan task');
    expect('bounds' in task).toBe(false);
  });

  test('forwards team_slug onto the plan task and into the parallel team map', async () => {
    await store.createMilestone({ id: 'm1', title: 'M1' });
    store.createTeam({ slug: 'payments', teamType: 'stream_aligned' });
    await store.createTask({
      id: 'a',
      title: 'Task a',
      milestoneId: 'm1',
      teamSlug: 'payments',
      createdAt: '2026-01-01T00:00:01.000Z',
    });

    const res = await withCapture(() => runCompilePlanCmd({ milestone: 'm1', workspaceRoot: workspace }));
    expect(res.exit).toBe(0);
    const { plan, team_map } = parsePlan(res.stdout);
    const task = plan.tasks[0];
    if (!task) throw new Error('expected one plan task');
    expect(task.team_slug).toBe('payments');
    // The milestone->team linkage survives in the parallel planId->team_slug map.
    expect(team_map).toEqual({ '1.1': 'payments' });
  });

  test('team-less task emits no team_slug key and no team-map entry', async () => {
    await store.createMilestone({ id: 'm1', title: 'M1' });
    await seedTask(store, 'a', 'm1', 1);
    const res = await withCapture(() => runCompilePlanCmd({ milestone: 'm1', workspaceRoot: workspace }));
    expect(res.exit).toBe(0);
    const { plan, team_map } = parsePlan(res.stdout);
    const task = plan.tasks[0];
    if (!task) throw new Error('expected one plan task');
    expect('team_slug' in task).toBe(false);
    expect(team_map).toEqual({});
  });

  test('layered milestone (epics + stories) compiles to leaf stories only', async () => {
    await store.createMilestone({ id: 'm1', title: 'M1' });
    // Two epics, each with two story children. createTask validates parent_id
    // exists, so parents are seeded first (and at earlier timestamps).
    await store.createTask({
      id: 'e1',
      title: 'Epic 1',
      milestoneId: 'm1',
      layer: 'epic',
      status: 'accepted',
      createdAt: '2026-01-01T00:00:01.000Z',
    });
    await store.createTask({
      id: 'e2',
      title: 'Epic 2',
      milestoneId: 'm1',
      layer: 'epic',
      status: 'accepted',
      createdAt: '2026-01-01T00:00:02.000Z',
    });
    for (const [seq, [id, parent]] of [
      ['e1s1', 'e1'],
      ['e1s2', 'e1'],
      ['e2s1', 'e2'],
      ['e2s2', 'e2'],
    ].entries()) {
      await store.createTask({
        id,
        title: `Story ${id}`,
        milestoneId: 'm1',
        parentId: parent,
        layer: 'story',
        createdAt: `2026-01-01T00:00:1${seq}.000Z`,
      });
    }

    const res = await withCapture(() => runCompilePlanCmd({ milestone: 'm1', workspaceRoot: workspace }));
    expect(res.exit).toBe(0);
    const { plan, scrum_map } = parsePlan(res.stdout);

    // The 4 story leaves compile in; the 2 epic containers do NOT. 4 leaves =>
    // full mode (threshold is on emitted leaves, not the actionable count of 6).
    expect(plan.tasks).toHaveLength(4);
    expect(plan.mode).toBe('full');
    const emittedScrumIds = Object.values(scrum_map).sort();
    expect(emittedScrumIds).toEqual(['e1s1', 'e1s2', 'e2s1', 'e2s2']);
    // No epic id leaks into the scrum-map sidecar.
    expect(emittedScrumIds).not.toContain('e1');
    expect(emittedScrumIds).not.toContain('e2');
    // Container-free leaves with no inter-leaf deps all land in wave 1.
    expect(plan.tasks.every((t) => t.wave === 1)).toBe(true);
    expect(plan.tasks.every((t) => t.deps.length === 0)).toBe(true);
  });

  test('flat milestone output is unchanged by the container filter', async () => {
    await store.createMilestone({ id: 'm1', title: 'M1' });
    await seedTask(store, 'a', 'm1', 1);
    await seedTask(store, 'b', 'm1', 2);
    await seedTask(store, 'c', 'm1', 3);
    await store.addDep('a', 'b', 'blocks');
    await store.addDep('b', 'c', 'blocks');

    const res = await withCapture(() => runCompilePlanCmd({ milestone: 'm1', workspaceRoot: workspace }));
    expect(res.exit).toBe(0);
    const { plan, scrum_map } = parsePlan(res.stdout);
    // Identical to the pre-filter linear-chain expectation: no parent_id present,
    // so nothing is excluded.
    expect(plan.tasks.map((t) => [t.id, t.wave])).toEqual([
      ['1.1', 1],
      ['2.1', 2],
      ['3.1', 3],
    ]);
    const byId = Object.fromEntries(plan.tasks.map((t) => [t.id, t]));
    expect(byId['2.1'].deps).toEqual(['1.1']);
    expect(byId['3.1'].deps).toEqual(['2.1']);
    expect(scrum_map).toEqual({ '1.1': 'a', '2.1': 'b', '3.1': 'c' });
  });

  test('epic whose children are all done/cancelled stays in as a leaf-equivalent', async () => {
    await store.createMilestone({ id: 'm1', title: 'M1' });
    await store.createTask({
      id: 'e1',
      title: 'Epic 1',
      milestoneId: 'm1',
      layer: 'epic',
      createdAt: '2026-01-01T00:00:01.000Z',
    });
    // Both children are terminal => out of the actionable set => e1 has no
    // in-plan child => e1 is NOT a container, it is residual parent-level work.
    await store.createTask({
      id: 'e1s1',
      title: 'Story 1',
      milestoneId: 'm1',
      parentId: 'e1',
      layer: 'story',
      status: 'done',
      createdAt: '2026-01-01T00:00:02.000Z',
    });
    await store.createTask({
      id: 'e1s2',
      title: 'Story 2',
      milestoneId: 'm1',
      parentId: 'e1',
      layer: 'story',
      status: 'cancelled',
      createdAt: '2026-01-01T00:00:03.000Z',
    });

    const res = await withCapture(() => runCompilePlanCmd({ milestone: 'm1', workspaceRoot: workspace }));
    expect(res.exit).toBe(0);
    const { plan, scrum_map } = parsePlan(res.stdout);
    expect(plan.tasks).toHaveLength(1);
    expect(scrum_map).toEqual({ '1.1': 'e1' });
  });

  test('childless epic stays in (no children at all => not a container)', async () => {
    await store.createMilestone({ id: 'm1', title: 'M1' });
    await store.createTask({
      id: 'e1',
      title: 'Epic 1',
      milestoneId: 'm1',
      layer: 'epic',
      createdAt: '2026-01-01T00:00:01.000Z',
    });
    const res = await withCapture(() => runCompilePlanCmd({ milestone: 'm1', workspaceRoot: workspace }));
    expect(res.exit).toBe(0);
    const { plan, scrum_map } = parsePlan(res.stdout);
    expect(plan.tasks).toHaveLength(1);
    expect(scrum_map).toEqual({ '1.1': 'e1' });
  });

  test('a leaf blocked_by an excluded epic re-targets onto the epic in-plan children', async () => {
    await store.createMilestone({ id: 'm1', title: 'M1' });
    await store.createTask({
      id: 'e1',
      title: 'Epic 1',
      milestoneId: 'm1',
      layer: 'epic',
      createdAt: '2026-01-01T00:00:01.000Z',
    });
    await store.createTask({
      id: 'e1s1',
      title: 'Story 1',
      milestoneId: 'm1',
      parentId: 'e1',
      layer: 'story',
      createdAt: '2026-01-01T00:00:02.000Z',
    });
    await store.createTask({
      id: 'e1s2',
      title: 'Story 2',
      milestoneId: 'm1',
      parentId: 'e1',
      layer: 'story',
      createdAt: '2026-01-01T00:00:03.000Z',
    });
    // A flat downstream task blocked_by the EPIC container. The edge must
    // re-target onto e1's in-plan children (e1s1, e1s2), landing the downstream
    // in wave 2 behind both.
    await seedTask(store, 'down', 'm1', 9);
    await store.addDep('e1', 'down', 'blocks'); // e1 blocks down => down blocked_by e1

    const res = await withCapture(() => runCompilePlanCmd({ milestone: 'm1', workspaceRoot: workspace }));
    expect(res.exit).toBe(0);
    const { plan, scrum_map } = parsePlan(res.stdout);
    const byScrum = Object.fromEntries(Object.entries(scrum_map).map(([p, s]) => [s, p]));
    const byId = Object.fromEntries(plan.tasks.map((t) => [t.id, t]));
    // No epic id emitted.
    expect(Object.values(scrum_map)).not.toContain('e1');
    // The two stories are sources (wave 1); the downstream depends on both.
    expect(byId[byScrum.e1s1].wave).toBe(1);
    expect(byId[byScrum.e1s2].wave).toBe(1);
    expect(byId[byScrum.down].wave).toBe(2);
    expect(byId[byScrum.down].deps.sort()).toEqual([byScrum.e1s1, byScrum.e1s2].sort());
  });

  test('a child blocked_by its own excluded parent drops the self-edge', async () => {
    await store.createMilestone({ id: 'm1', title: 'M1' });
    await store.createTask({
      id: 'e1',
      title: 'Epic 1',
      milestoneId: 'm1',
      layer: 'epic',
      createdAt: '2026-01-01T00:00:01.000Z',
    });
    await store.createTask({
      id: 'e1s1',
      title: 'Story 1',
      milestoneId: 'm1',
      parentId: 'e1',
      layer: 'story',
      createdAt: '2026-01-01T00:00:02.000Z',
    });
    // e1s1 blocked_by its own parent e1. Re-targeting e1 -> {e1s1} would create a
    // self-edge; it must be dropped so e1s1 stays a wave-1 source.
    await store.addDep('e1', 'e1s1', 'blocks');

    const res = await withCapture(() => runCompilePlanCmd({ milestone: 'm1', workspaceRoot: workspace }));
    expect(res.exit).toBe(0);
    const { plan, scrum_map } = parsePlan(res.stdout);
    expect(Object.values(scrum_map)).toEqual(['e1s1']);
    expect(plan.tasks[0]?.wave).toBe(1);
    expect(plan.tasks[0]?.deps).toEqual([]);
  });

  test('nested epic->story->task tree compiles to task leaves; edge at epic re-targets to tasks', async () => {
    await store.createMilestone({ id: 'm1', title: 'M1' });
    await store.createTask({
      id: 'e1',
      title: 'Epic',
      milestoneId: 'm1',
      layer: 'epic',
      createdAt: '2026-01-01T00:00:01.000Z',
    });
    await store.createTask({
      id: 's1',
      title: 'Story',
      milestoneId: 'm1',
      parentId: 'e1',
      layer: 'story',
      createdAt: '2026-01-01T00:00:02.000Z',
    });
    await store.createTask({
      id: 't1',
      title: 'Task 1',
      milestoneId: 'm1',
      parentId: 's1',
      layer: 'task',
      createdAt: '2026-01-01T00:00:03.000Z',
    });
    await store.createTask({
      id: 't2',
      title: 'Task 2',
      milestoneId: 'm1',
      parentId: 's1',
      layer: 'task',
      createdAt: '2026-01-01T00:00:04.000Z',
    });
    await seedTask(store, 'down', 'm1', 9);
    await store.addDep('e1', 'down', 'blocks'); // down blocked_by the epic two levels up

    const res = await withCapture(() => runCompilePlanCmd({ milestone: 'm1', workspaceRoot: workspace }));
    expect(res.exit).toBe(0);
    const { plan, scrum_map } = parsePlan(res.stdout);
    const emitted = Object.values(scrum_map).sort();
    // Only the two task leaves + the flat downstream; epic AND story excluded.
    expect(emitted).toEqual(['down', 't1', 't2']);
    const byScrum = Object.fromEntries(Object.entries(scrum_map).map(([p, s]) => [s, p]));
    const byId = Object.fromEntries(plan.tasks.map((t) => [t.id, t]));
    // The edge at the epic re-targets to the task-layer leaves several levels down.
    expect(byId[byScrum.down].deps.sort()).toEqual([byScrum.t1, byScrum.t2].sort());
    expect(byId[byScrum.down].wave).toBe(2);
  });

  test('--out writes a team-map.json sibling alongside scrum-map.json', async () => {
    await store.createMilestone({ id: 'm1', title: 'M1' });
    store.createTeam({ slug: 'payments', teamType: 'stream_aligned' });
    await store.createTask({
      id: 'a',
      title: 'Task a',
      milestoneId: 'm1',
      teamSlug: 'payments',
      createdAt: '2026-01-01T00:00:01.000Z',
    });
    await seedTask(store, 'b', 'm1', 2);

    const outDir = join(workspace, '.prove', 'runs', 'feature', 'm1');
    const planPath = join(outDir, 'plan.json');
    const res = await withCapture(() =>
      runCompilePlanCmd({ milestone: 'm1', out: planPath, workspaceRoot: workspace }),
    );
    expect(res.exit).toBe(0);

    const teamMapPath = join(outDir, 'team-map.json');
    expect(existsSync(teamMapPath)).toBe(true);
    // Only the team-bound task contributes an entry; the team-less one does not.
    const writtenTeamMap = JSON.parse(readFileSync(teamMapPath, 'utf8'));
    expect(writtenTeamMap).toEqual({ '1.1': 'payments' });

    const { team_map_path } = parsePlan(res.stdout);
    expect(team_map_path).toBe(teamMapPath);
  });
});
