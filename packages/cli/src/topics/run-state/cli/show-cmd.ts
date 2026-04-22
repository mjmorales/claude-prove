/**
 * `run-state show` / `show-report` / `summary` / `current` — render-dependent
 * read-only views.
 *
 * Task 4 (render port) lands in parallel; this worktree exposes the
 * subcommand names but exits with a TODO pointer so orchestrator shell
 * wiring compiles and tests can at least hit the dispatch table. The
 * post-Wave-3-merge pass wires these to `../render.ts`.
 *
 * For `--format json` we CAN serve today — it just re-emits the raw
 * artifact — so we do, matching Python behavior byte-for-byte.
 */

import { existsSync, readFileSync } from 'node:fs';
import { loadState } from '../state';
import { type RunSelection, ResolveError, resolvePaths } from './resolve';

export interface ShowFlags extends RunSelection {
  kind?: 'state' | 'plan' | 'prd' | 'report';
  format?: 'md' | 'json';
}

export function runShow(flags: ShowFlags): number {
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
  const kind = flags.kind ?? 'state';
  if (kind === 'report') {
    console.error('error: use `report show <step_id>` for report output');
    return 1;
  }
  const target =
    kind === 'prd'
      ? resolved.paths.prd
      : kind === 'plan'
        ? resolved.paths.plan
        : resolved.paths.state;
  if (!existsSync(target)) {
    console.error(`error: artifact missing: ${target}`);
    return 1;
  }
  const data = JSON.parse(readFileSync(target, 'utf8'));
  const format = flags.format ?? 'md';
  if (format === 'json') {
    console.log(JSON.stringify(data, null, 2));
    return 0;
  }
  // TODO(task-4-merge): wire to `render.renderPrd/renderPlan/renderState`.
  console.error('error: `show --format md` wiring lands in the Task 4 render-port merge; use --format json for now');
  return 2;
}

export interface ShowReportFlags extends RunSelection {
  format?: 'md' | 'json';
}

export function runShowReport(stepId: string, flags: ShowReportFlags): number {
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
  const normalized = stepId.replace(/\./g, '_');
  const target = `${resolved.paths.reports_dir}/${normalized}.json`;
  if (!existsSync(target)) {
    console.error(`error: no report for step ${stepId}`);
    return 1;
  }
  const data = JSON.parse(readFileSync(target, 'utf8'));
  if ((flags.format ?? 'md') === 'json') {
    console.log(JSON.stringify(data, null, 2));
    return 0;
  }
  // TODO(task-4-merge): wire to `render.renderReport`.
  console.error('error: `show-report --format md` wiring lands in the Task 4 render-port merge; use --format json for now');
  return 2;
}

export interface CurrentFlags extends RunSelection {
  format?: 'json' | 'text';
}

export function runCurrent(flags: CurrentFlags): number {
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
  if (!existsSync(resolved.paths.state)) {
    console.error(`error: no state.json at ${resolved.paths.state}`);
    return 1;
  }
  const state = loadState(resolved.paths);
  if ((flags.format ?? 'text') === 'json') {
    console.log(JSON.stringify(state, null, 2));
    return 0;
  }
  // TODO(task-4-merge): wire to `render.renderSummary`.
  console.error('error: `current --format text` wiring lands in the Task 4 render-port merge; use --format json for now');
  return 2;
}

export interface SummaryFlags {
  runsRoot?: string;
}

export function runSummary(_flags: SummaryFlags): number {
  // TODO(task-4-merge): wire to `render.renderSummary` across all runs.
  console.error('error: `summary` wiring lands in the Task 4 render-port merge');
  return 2;
}
