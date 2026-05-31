/**
 * `claude-prove scrum compile-plan --milestone <id> [--out <plan-path>]
 *                          [--workspace-root W]`
 *
 * Compile a scrum milestone's actionable tasks + `blocked_by` edges into a
 * run-state `plan.json` (the schema the orchestrator runs) plus a
 * `scrum-map.json` sidecar mapping each generated plan-task id back to its
 * scrum task id. Used by `/prove:workflow` to fan a whole milestone out
 * through orchestrator full-mode while keeping `prove.db` the source of truth.
 *
 * Compilation rules:
 *   - Actionable tasks = milestone tasks whose status is not `done`/`cancelled`.
 *   - Edges: a task's `deps[]` are its `blocked_by` predecessors that are
 *     themselves actionable (deps on done/out-of-scope tasks are dropped as
 *     already satisfied).
 *   - `wave` = longest-path depth + 1 (sources land in wave 1). Cycles error.
 *   - Plan task id = `<wave>.<seq-within-wave>`; the single step is `<id>.1`.
 *   - `mode` = `full` when >= 4 tasks, else `simple` (mirrors orchestrator
 *     auto-scale on step count, one step per task here).
 *
 * Stdout (JSON): `{ plan, scrum_map, plan_path?, map_path? }`.
 * Stderr: one-line human summary.
 *
 * Exit codes:
 *   0  success
 *   1  missing --milestone, unknown milestone, no actionable tasks,
 *      dependency cycle, or store/write error
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { mainWorktreeRoot } from '@claude-prove/shared';
import { openScrumStore } from '../store';
import type { ScrumStore } from '../store';
import type { ScrumTask } from '../types';

export interface CompilePlanCmdFlags {
  milestone?: string;
  out?: string;
  workspaceRoot?: string;
}

const PLAN_SCHEMA_VERSION = '1';
const FULL_MODE_THRESHOLD = 4;

interface PlanStep {
  id: string;
  title: string;
  description: string;
  acceptance_criteria: string[];
}

interface PlanTask {
  id: string;
  title: string;
  wave: number;
  deps: string[];
  description: string;
  acceptance_criteria: string[];
  worktree: { path: string; branch: string };
  steps: PlanStep[];
}

interface Plan {
  schema_version: string;
  kind: 'plan';
  mode: 'simple' | 'full';
  task_id: string;
  tasks: PlanTask[];
}

export function runCompilePlanCmd(flags: CompilePlanCmdFlags): number {
  const milestoneId =
    flags.milestone !== undefined && flags.milestone.length > 0 ? flags.milestone : undefined;
  if (milestoneId === undefined) {
    process.stderr.write('scrum compile-plan: --milestone <id> is required\n');
    return 1;
  }

  const workspaceRoot =
    flags.workspaceRoot && flags.workspaceRoot.length > 0
      ? flags.workspaceRoot
      : (mainWorktreeRoot() ?? process.cwd());
  const store = openScrumStore({ override: join(workspaceRoot, '.prove', 'prove.db') });
  try {
    if (store.getMilestone(milestoneId) === null) {
      process.stderr.write(`scrum compile-plan: unknown milestone '${milestoneId}'\n`);
      return 1;
    }

    const actionable = store
      .listTasks({ milestoneId })
      .filter((t) => t.status !== 'done' && t.status !== 'cancelled');
    if (actionable.length === 0) {
      process.stderr.write(
        `scrum compile-plan: milestone '${milestoneId}' has no actionable tasks (all done/cancelled or none assigned)\n`,
      );
      return 1;
    }

    const { plan, scrumMap } = compile(store, milestoneId, actionable);
    const payload: Record<string, unknown> = { plan, scrum_map: scrumMap };

    if (flags.out !== undefined && flags.out.length > 0) {
      const planPath = flags.out;
      const mapPath = join(dirname(planPath), 'scrum-map.json');
      mkdirSync(dirname(planPath), { recursive: true });
      writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
      writeFileSync(mapPath, `${JSON.stringify(scrumMap, null, 2)}\n`, 'utf8');
      payload.plan_path = planPath;
      payload.map_path = mapPath;
    }

    const waveCount = plan.tasks.reduce((max, t) => Math.max(max, t.wave), 0);
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    process.stderr.write(
      `scrum compile-plan: ${plan.tasks.length} tasks, ${waveCount} waves, mode=${plan.mode}${
        flags.out ? ` -> ${flags.out}` : ''
      }\n`,
    );
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`scrum compile-plan: ${msg}\n`);
    return 1;
  } finally {
    store.close();
  }
}

/**
 * Build the plan + sidecar map from the actionable task set. `tasks` arrives
 * in `created_at ASC` order (listTasks default), which yields a stable
 * seq-within-wave assignment.
 */
function compile(
  store: ScrumStore,
  milestoneId: string,
  tasks: ScrumTask[],
): { plan: Plan; scrumMap: Record<string, string> } {
  const inScope = new Set(tasks.map((t) => t.id));

  // deps[scrumId] = actionable predecessors (blocked_by edges, intersected with scope).
  const deps = new Map<string, string[]>();
  for (const task of tasks) {
    const predecessors = store
      .getBlockedBy(task.id)
      .map((d) => d.from_task_id)
      .filter((id) => inScope.has(id));
    deps.set(task.id, predecessors);
  }

  const level = computeLevels(tasks, deps);

  // Assign plan ids: order by (wave, original created_at order), seq within wave.
  const seqByWave = new Map<number, number>();
  const scrumToPlan = new Map<string, string>();
  const ordered = [...tasks].sort((a, b) => (level.get(a.id) ?? 0) - (level.get(b.id) ?? 0));
  for (const task of ordered) {
    const wave = (level.get(task.id) ?? 0) + 1;
    const seq = (seqByWave.get(wave) ?? 0) + 1;
    seqByWave.set(wave, seq);
    scrumToPlan.set(task.id, `${wave}.${seq}`);
  }

  const planTasks: PlanTask[] = ordered.map((task) => {
    const planId = scrumToPlan.get(task.id) as string;
    const wave = (level.get(task.id) ?? 0) + 1;
    const description = task.description ?? '';
    // Forward each active acceptance criterion's `text` into the plan task.
    // TODO(plan-ac-shape): run-state TASK_PLAN_SPEC.acceptance_criteria is a
    // list<str>, so only the criterion text survives — the structured shape
    // (verifies_by/check/idempotent/policy) is dropped here. Carrying it
    // requires a run-state schema bump (a second cross-domain migration, out
    // of scope for this task). Superseded criteria are excluded.
    const acceptanceCriteria = (task.acceptance?.criteria ?? [])
      .filter((c) => c.status === 'active')
      .map((c) => c.text);
    return {
      id: planId,
      title: task.title,
      wave,
      deps: (deps.get(task.id) ?? []).map((id) => scrumToPlan.get(id) as string),
      description,
      acceptance_criteria: acceptanceCriteria,
      worktree: { path: '', branch: '' },
      steps: [
        {
          id: `${planId}.1`,
          title: task.title,
          description,
          acceptance_criteria: acceptanceCriteria,
        },
      ],
    };
  });

  const scrumMap: Record<string, string> = {};
  for (const [scrumId, planId] of scrumToPlan) scrumMap[planId] = scrumId;

  const plan: Plan = {
    schema_version: PLAN_SCHEMA_VERSION,
    kind: 'plan',
    mode: tasks.length >= FULL_MODE_THRESHOLD ? 'full' : 'simple',
    task_id: milestoneId,
    tasks: planTasks,
  };
  return { plan, scrumMap };
}

/**
 * Longest-path depth per task via memoized DFS over `deps`. Sources have
 * depth 0. Throws on a dependency cycle, naming the task where it closes.
 */
function computeLevels(tasks: ScrumTask[], deps: Map<string, string[]>): Map<string, number> {
  const memo = new Map<string, number>();
  const visiting = new Set<string>();

  const depth = (id: string): number => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) {
      throw new Error(`dependency cycle detected at task '${id}'`);
    }
    visiting.add(id);
    const predecessors = deps.get(id) ?? [];
    const d = predecessors.length === 0 ? 0 : Math.max(...predecessors.map((p) => depth(p))) + 1;
    visiting.delete(id);
    memo.set(id, d);
    return d;
  };

  for (const task of tasks) depth(task.id);
  return memo;
}
