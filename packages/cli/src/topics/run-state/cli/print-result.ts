/**
 * Shared helper: serialize a state mutation result for stdout. Mirrors the
 * Python `_print_result` in `tools/run_state/__main__.py` — JSON format emits
 * pretty-printed state; md format emits `renderSummary(state, plan)` where the
 * plan is loaded from disk when available.
 */

import { existsSync, readFileSync } from 'node:fs';
import type { RunPaths } from '../paths';
import { renderSummary } from '../render';
import type { PlanData, StateData } from '../state';

export function loadPlanOrNull(paths: RunPaths): PlanData | null {
  if (!existsSync(paths.plan)) return null;
  return JSON.parse(readFileSync(paths.plan, 'utf8')) as PlanData;
}

export function printMutationResult(
  state: StateData,
  paths: RunPaths,
  format: 'md' | 'json',
): void {
  if (format === 'json') {
    console.log(JSON.stringify(state, null, 2));
    return;
  }
  const plan = loadPlanOrNull(paths);
  process.stdout.write(renderSummary(state, { plan }));
}
