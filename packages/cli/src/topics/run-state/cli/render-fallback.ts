/**
 * Minimal render fallback used by mutator commands when `--format md` is
 * requested but the real render port (Task 4) hasn't landed in this
 * worktree. Emits a terse one-screen status block so the CLI stays
 * usable end-to-end. Post-merge pass replaces callers with the real
 * `renderSummary` from `../render.ts`.
 *
 * TODO(task-4-merge): swap callers to `renderSummary` / `renderReport` /
 * `renderPrd` / `renderPlan` / `renderState` once the render module lands.
 */

import type { StateData } from '../state';

export function renderStateJson(state: StateData): string {
  const lines: string[] = [];
  lines.push(`run: ${state.slug}@${state.branch} [${state.run_status}]`);
  if (state.current_step) {
    lines.push(`current: ${state.current_task}/${state.current_step}`);
  }
  for (const task of state.tasks ?? []) {
    lines.push(`task ${task.id} [${task.status}] review=${task.review?.verdict ?? 'pending'}`);
    for (const step of task.steps ?? []) {
      lines.push(`  step ${step.id} [${step.status}]`);
    }
  }
  return `${lines.join('\n')}\n`;
}
