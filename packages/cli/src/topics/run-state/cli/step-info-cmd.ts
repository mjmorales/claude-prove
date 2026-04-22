/**
 * `run-state step-info <step_id>` — emit {task, step, task_state, step_state} as JSON.
 *
 * Mirrors `tools/run_state/__main__.py::cmd_step_info` exactly. Consumed by
 * `skills/plan-step` to surface plan + state context for a single step
 * before the orchestrator kicks off implementation. JSON-only output (the
 * Python version ignored --format); task_state / step_state are `null` when
 * state.json is absent or the step hasn't been touched yet.
 *
 * Exit codes:
 *   0  found and emitted
 *   1  plan.json missing or step_id not in plan
 */
import { existsSync, readFileSync } from 'node:fs';
import { loadState } from '../state';
import type { PlanData, StateData, TaskData, StepData } from '../state';
import { ResolveError, type RunSelection, resolvePaths } from './resolve';

export interface StepInfoFlags extends RunSelection {}

export function runStepInfo(stepId: string, flags: StepInfoFlags): number {
  if (!stepId) {
    console.error('error: the following arguments are required: step_id');
    return 1;
  }
  let resolved;
  try {
    resolved = resolvePaths(flags);
  } catch (err) {
    if (err instanceof ResolveError) {
      console.error(`error: ${err.message}`);
      return err.exitCode;
    }
    throw err;
  }

  if (!existsSync(resolved.paths.plan)) {
    console.error(`error: no plan.json at ${resolved.paths.plan}`);
    return 1;
  }
  const plan = JSON.parse(readFileSync(resolved.paths.plan, 'utf8')) as PlanData;
  const state: StateData | null = existsSync(resolved.paths.state)
    ? loadState(resolved.paths)
    : null;

  for (const task of plan.tasks ?? []) {
    for (const step of task.steps ?? []) {
      if (step.id !== stepId) continue;
      const { taskState, stepState } = lookupState(state, task.id, stepId);
      const payload = {
        task,
        step,
        task_state: taskState,
        step_state: stepState,
      };
      console.log(JSON.stringify(payload, null, 2));
      return 0;
    }
  }
  console.error(`error: step not found in plan: ${stepId}`);
  return 1;
}

function lookupState(
  state: StateData | null,
  taskId: string,
  stepId: string,
): { taskState: TaskData | null; stepState: StepData | null } {
  if (state === null) return { taskState: null, stepState: null };
  for (const ts of state.tasks ?? []) {
    if (ts.id !== taskId) continue;
    for (const ss of ts.steps ?? []) {
      if (ss.id === stepId) return { taskState: ts, stepState: ss };
    }
    return { taskState: ts, stepState: null };
  }
  return { taskState: null, stepState: null };
}
