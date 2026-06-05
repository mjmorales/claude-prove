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
 *   - Containment parents are excluded from the executable task set: a task is a
 *     container (not a work unit) iff at least one of its `parent_id` children is
 *     itself in the actionable set. Such a container would otherwise emit as a
 *     wave-1 plan task duplicating the work its children already cover — running
 *     it would re-implement the children monolithically. A task whose children
 *     are ALL done/cancelled/out-of-milestone (none in the actionable set), and a
 *     task with no children at all, are leaf-equivalent work units and STAY in —
 *     so residual parent-level work never silently vanishes from the plan. The
 *     filter is by this child-presence predicate, never by `layer` alone.
 *   - Edges: a task's `deps[]` are its `blocked_by` predecessors that are
 *     themselves IN-PLAN (actionable and not an excluded container). A dep on a
 *     done/out-of-scope task is dropped as already satisfied. A dep pointing AT an
 *     excluded container is re-targeted to that container's in-plan children
 *     (the work the container stood for), so waves stay correct; a re-target that
 *     would create a self-edge is dropped.
 *   - `wave` = longest-path depth + 1 (sources land in wave 1). Cycles error.
 *   - Plan task id = `<wave>.<seq-within-wave>`; the single step is `<id>.1`.
 *   - `mode` = `full` when >= 4 emitted (leaf) tasks, else `simple` (mirrors
 *     orchestrator auto-scale on step count, one step per task here).
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
import type { ScrumStore } from '../store';
import type { ScrumTask } from '../types';
import { openCliStore } from './cli-store';

export interface CompilePlanCmdFlags {
  milestone?: string;
  out?: string;
  workspaceRoot?: string;
}

// run-state plan.json schema version this command emits. Bumped to '3' when
// plan-task acceptance_criteria became structured criterion dicts (was '1').
const PLAN_SCHEMA_VERSION = '3';
const FULL_MODE_THRESHOLD = 4;

/**
 * Structured acceptance criterion forwarded into a plan task/step. Mirrors the
 * run-state v3 `ACCEPTANCE_CRITERION_SPEC` (text required; the rest optional)
 * and is sourced from the scrum task's `AcceptanceCriterion`. `verifies_by`/
 * `check`/`idempotent` let the orchestrator dispatch the criterion by kind
 * instead of seeing only its text.
 */
interface PlanCriterion {
  id: string;
  text: string;
  verifies_by: string;
  check: string;
  status: string;
  idempotent: boolean;
}

interface PlanStep {
  id: string;
  title: string;
  description: string;
  acceptance_criteria: PlanCriterion[];
}

/**
 * Declared bounds forwarded into a plan task. Mirrors the run-state v3
 * `TASK_PLAN_SPEC.bounds` shape and is sourced verbatim from the scrum task's
 * `TaskBounds`. Forwarded only when the scrum task has authored bounds; absent
 * = unbounded (current behavior). prep-permissions reads this downstream.
 */
interface PlanBounds {
  read?: string[];
  write?: string[];
  tools?: { allow?: string[]; deny?: string[] };
  budgets?: { tokens?: number; tool_calls?: number; wall_clock_s?: number };
}

interface PlanTask {
  id: string;
  title: string;
  wave: number;
  deps: string[];
  description: string;
  acceptance_criteria: PlanCriterion[];
  worktree: { path: string; branch: string };
  /** Forwarded from the scrum task's `bounds`; omitted when null (unbounded). */
  bounds?: PlanBounds;
  /**
   * Forwarded from the scrum task's `team_slug`; omitted when absent (team-less
   * task). Carries the owning team into the plan so the render surfaces can
   * derive the task's role-bound agent names without a store lookup.
   */
  team_slug?: string;
  steps: PlanStep[];
}

interface Plan {
  schema_version: string;
  kind: 'plan';
  mode: 'simple' | 'full';
  /**
   * Run-state's PLAN_SCHEMA reserves `task_id` for a single scrum TASK id (the
   * reconciler calls `store.getTask(plan.task_id)`). A compiled milestone plan
   * fans out to MANY scrum tasks, so there is no single task_id to set — a
   * milestone id here mis-classifies every run as orphan. Omitted entirely;
   * milestone→plan linkage lives in the `scrum-map.json` sidecar, and per-task
   * run linkage is established at reconcile time from each task's plan.json.
   */
  task_id?: string;
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
  const store = openCliStore(workspaceRoot);
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

    const { plan, scrumMap, teamMap } = compile(store, actionable);
    // The leaf-filter inside compile() preserves the deepest work units of any
    // containment tree (a node with no in-plan child always survives), so a
    // non-empty actionable set normally yields a non-empty plan. An empty plan
    // here means every actionable task excluded the next via a malformed
    // `parent_id` cycle (A parents B, B parents A) — surface it rather than
    // emitting a zero-task plan run-state would reject.
    if (plan.tasks.length === 0) {
      process.stderr.write(
        `scrum compile-plan: milestone '${milestoneId}' has actionable tasks but no executable leaves (every task is a containment parent — check for a parent_id cycle)\n`,
      );
      return 1;
    }
    const payload: Record<string, unknown> = { plan, scrum_map: scrumMap, team_map: teamMap };

    if (flags.out !== undefined && flags.out.length > 0) {
      const planPath = flags.out;
      const mapPath = join(dirname(planPath), 'scrum-map.json');
      const teamMapPath = join(dirname(planPath), 'team-map.json');
      mkdirSync(dirname(planPath), { recursive: true });
      writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
      writeFileSync(mapPath, `${JSON.stringify(scrumMap, null, 2)}\n`, 'utf8');
      writeFileSync(teamMapPath, `${JSON.stringify(teamMap, null, 2)}\n`, 'utf8');
      payload.plan_path = planPath;
      payload.map_path = mapPath;
      payload.team_map_path = teamMapPath;
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
 * Build the plan + sidecar map from the actionable task set. `actionable`
 * arrives in `created_at ASC` order (listTasks default), which yields a stable
 * seq-within-wave assignment.
 *
 * Containment parents are dropped before compilation: a task with at least one
 * in-plan child is a container, not a work unit (see `containerIds`). The
 * remaining `tasks` are the executable LEAF set — the plan, scrum-map, team-map,
 * and wave arithmetic all run over leaves only.
 */
function compile(
  store: ScrumStore,
  actionable: ScrumTask[],
): { plan: Plan; scrumMap: Record<string, string>; teamMap: Record<string, string> } {
  const actionableIds = new Set(actionable.map((t) => t.id));

  // A parent_id referenced by some actionable task = a container WITH an in-plan
  // child. Exactly those ids are excluded as containers. A parent whose children
  // are all done/cancelled/out-of-milestone contributes no entry here (none of
  // its children are actionable), so it survives as a leaf-equivalent work unit.
  const containerIds = new Set<string>();
  for (const task of actionable) {
    if (task.parent_id !== null && actionableIds.has(task.parent_id)) {
      containerIds.add(task.parent_id);
    }
  }

  // The executable leaf set: actionable tasks that are not excluded containers.
  // Plan ids, scrum-map, and waves are computed over THIS set.
  const tasks = actionable.filter((t) => !containerIds.has(t.id));
  const inScope = new Set(tasks.map((t) => t.id));

  // direct children (any layer) of each actionable task, for the transitive
  // descendant walk that re-targets an edge pointing AT an excluded container.
  const directChildren = new Map<string, ScrumTask[]>();
  for (const task of actionable) {
    if (task.parent_id !== null && actionableIds.has(task.parent_id)) {
      const siblings = directChildren.get(task.parent_id) ?? [];
      siblings.push(task);
      directChildren.set(task.parent_id, siblings);
    }
  }

  // The in-plan (leaf) descendants of an excluded container — the work the
  // container stood for. A nested epic→story→task tree excludes BOTH the epic
  // and the story, so an edge pointing at the epic must re-target to the
  // task-layer leaves several levels down, not just its direct children.
  // Memoized; a `visited` set guards a malformed `parent_id` cycle.
  const leafDescendantsMemo = new Map<string, string[]>();
  const leafDescendantsOf = (containerId: string): string[] => {
    const cached = leafDescendantsMemo.get(containerId);
    if (cached !== undefined) return cached;
    const out = new Set<string>();
    const visited = new Set<string>();
    const walk = (id: string): void => {
      if (visited.has(id)) return;
      visited.add(id);
      for (const child of directChildren.get(id) ?? []) {
        if (containerIds.has(child.id)) walk(child.id);
        else if (inScope.has(child.id)) out.add(child.id);
      }
    };
    walk(containerId);
    const list = [...out];
    leafDescendantsMemo.set(containerId, list);
    return list;
  };

  // deps[scrumId] = in-plan predecessors (blocked_by edges). A predecessor that
  // is an excluded container is replaced by its in-plan leaf descendants; a
  // predecessor outside scope (done/out-of-milestone) is dropped as satisfied. A
  // re-target that lands back on the task itself (a child blocked_by its own
  // ancestor) is dropped to avoid a self-edge.
  const deps = new Map<string, string[]>();
  for (const task of tasks) {
    const resolved = new Set<string>();
    for (const dep of store.getBlockedBy(task.id)) {
      const from = dep.from_task_id;
      if (inScope.has(from)) {
        resolved.add(from);
      } else if (containerIds.has(from)) {
        for (const leaf of leafDescendantsOf(from)) {
          if (leaf !== task.id) resolved.add(leaf);
        }
      }
    }
    deps.set(task.id, [...resolved]);
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
    // Every task in `ordered` was inserted into scrumToPlan above; a miss here
    // means the population loop and the ordered array are out of sync — enforce
    // the invariant explicitly so corrupt plan ids never reach run-state.
    const planId = scrumToPlan.get(task.id);
    if (planId === undefined) {
      throw new Error(`compile bug: no plan id for scrum task '${task.id}'`);
    }
    const wave = (level.get(task.id) ?? 0) + 1;
    const description = task.description ?? '';
    // Forward the FULL structured criterion (run-state v3 shape) so the
    // orchestrator can dispatch acceptance by kind. Superseded criteria are
    // excluded; the policy (eval_order/rerun_policy) is task-level scrum state
    // with no plan-task home and is intentionally not forwarded.
    const acceptanceCriteria: PlanCriterion[] = (task.acceptance?.criteria ?? [])
      .filter((c) => c.status !== 'superseded')
      .map((c) => ({
        id: c.id,
        text: c.text,
        verifies_by: c.verifies_by,
        check: c.check,
        status: c.status,
        idempotent: c.idempotent,
      }));
    const planTask: PlanTask = {
      id: planId,
      title: task.title,
      wave,
      deps: (deps.get(task.id) ?? []).map((id) => {
        // Every dep was intersected with `inScope` (lines above), so it must
        // have a plan id; a miss signals a scope-filter inconsistency.
        const depPlanId = scrumToPlan.get(id);
        if (depPlanId === undefined) {
          throw new Error(`compile bug: dep '${id}' of '${task.id}' has no plan id`);
        }
        return depPlanId;
      }),
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
    // Forward milestone-authored declared bounds verbatim into the plan task
    // (run-state v3 supports tasks[].bounds). Absent scrum bounds emit no
    // bounds key — absent = unbounded; never crash on a null-bounds task.
    if (task.bounds !== null) {
      planTask.bounds = task.bounds;
    }
    // Forward the owning team verbatim into the plan task. Read through an
    // optional accessor so this lands cleanly whether or not the ScrumTask
    // row carries `team_slug`; a vacant/absent slug forwards no key — absent =
    // team-less.
    const teamSlug = (task as { team_slug?: string | null }).team_slug;
    if (teamSlug !== undefined && teamSlug !== null && teamSlug.length > 0) {
      planTask.team_slug = teamSlug;
    }
    return planTask;
  });

  const scrumMap: Record<string, string> = {};
  for (const [scrumId, planId] of scrumToPlan) scrumMap[planId] = scrumId;

  // Parallel planId -> team_slug map: the milestone->team linkage the render
  // surfaces consume, kept beside the planId->scrumId map rather than mixed
  // into it so the flat scrum-map contract stays intact. Team-less tasks
  // contribute no entry.
  const teamMap: Record<string, string> = {};
  for (const planTask of planTasks) {
    if (planTask.team_slug !== undefined) teamMap[planTask.id] = planTask.team_slug;
  }

  const plan: Plan = {
    schema_version: PLAN_SCHEMA_VERSION,
    kind: 'plan',
    mode: tasks.length >= FULL_MODE_THRESHOLD ? 'full' : 'simple',
    // task_id intentionally omitted — see the Plan interface. A milestone id
    // here would mis-classify every reconciled run as orphan.
    tasks: planTasks,
  };
  return { plan, scrumMap, teamMap };
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
