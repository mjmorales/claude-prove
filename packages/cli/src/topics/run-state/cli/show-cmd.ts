/**
 * `run-state show` / `show-report` / `summary` / `current` — read-only views.
 *
 * Mirrors the Python `cmd_show`, `cmd_current`, and the `summary` CLI path:
 * JSON format emits the raw artifact; md format delegates to `render.ts`
 * (byte-equal to Python for every view).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RunPaths } from '../paths';
import { loadState } from '../state';
import { renderPlan, renderPrd, renderReport, renderState, renderSummary } from '../render';
import type { PlanData, PrdData, ReportData, StateData } from '../state';
import { sortedChildren } from './fs-helpers';
import { type RunSelection, ResolveError, resolvePaths, defaultRunsRoot } from './resolve';

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
  if (kind === 'prd') {
    process.stdout.write(renderPrd(data as PrdData));
    return 0;
  }
  if (kind === 'plan') {
    process.stdout.write(renderPlan(data as PlanData));
    return 0;
  }
  // state — load plan if present so step/task titles render.
  let plan: PlanData | null = null;
  if (existsSync(resolved.paths.plan)) {
    plan = JSON.parse(readFileSync(resolved.paths.plan, 'utf8')) as PlanData;
  }
  process.stdout.write(renderState(data as StateData, { plan }));
  return 0;
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
  const data = JSON.parse(readFileSync(target, 'utf8')) as ReportData;
  if ((flags.format ?? 'md') === 'json') {
    console.log(JSON.stringify(data, null, 2));
    return 0;
  }
  process.stdout.write(renderReport(data));
  return 0;
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
  const format = flags.format ?? 'text';
  if (format === 'json') {
    console.log(JSON.stringify(state, null, 2));
    return 0;
  }
  let plan: PlanData | null = null;
  if (existsSync(resolved.paths.plan)) {
    plan = JSON.parse(readFileSync(resolved.paths.plan, 'utf8')) as PlanData;
  }
  process.stdout.write(renderSummary(state, { plan }));
  return 0;
}

export interface SummaryFlags {
  runsRoot?: string;
}

export function runSummary(flags: SummaryFlags): number {
  // Aggregate summaries across every active run under runs-root. Mirrors the
  // `scripts/prove-run ls`-style sweep; per-run output uses renderSummary.
  const runsRoot = flags.runsRoot ?? defaultRunsRoot();
  if (!existsSync(runsRoot)) {
    console.error(`error: no runs root at ${runsRoot}`);
    return 1;
  }
  let emitted = 0;
  for (const branch of sortedChildren(runsRoot)) {
    const branchDir = join(runsRoot, branch);
    for (const slug of sortedChildren(branchDir)) {
      // Route reads through RunPaths + loadState so the lock-file sidecar is
      // touched consistently with every other state.json reader in this module.
      const paths = RunPaths.forRun(runsRoot, branch, slug);
      if (!existsSync(paths.state)) continue;
      const state = loadState(paths);
      const plan = existsSync(paths.plan)
        ? (JSON.parse(readFileSync(paths.plan, 'utf8')) as PlanData)
        : null;
      process.stdout.write(renderSummary(state, { plan }));
      emitted += 1;
    }
  }
  if (emitted === 0) {
    console.error('error: no active runs found');
    return 1;
  }
  return 0;
}
