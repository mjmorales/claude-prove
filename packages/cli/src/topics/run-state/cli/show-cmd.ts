/**
 * `run-state show` / `show-report` / `summary` / `current` — read-only views.
 *
 * JSON format emits the raw artifact; md format delegates to `render.ts`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RunPaths } from '../paths';
import { renderPlan, renderPrd, renderReport, renderState, renderSummary } from '../render';
import { loadState } from '../state';
import type { PlanData, PrdData, ReportData, StateData } from '../state';
import { sortedChildren } from './fs-helpers';
import { ResolveError, type RunSelection, defaultRunsRoot, resolvePaths } from './resolve';

/**
 * A malformed artifact must not crash the CLI with a raw SyntaxError. Read
 * + parse and surface failures as a `LoadError` carrying a clean message so
 * each command can map it to the documented exit code (1, the I/O code).
 */
class LoadError extends Error {}

function readJsonOrThrow<T>(path: string): T {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new LoadError(`cannot read ${path}: ${msg}`);
  }
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new LoadError(`invalid JSON in ${path}: ${msg}`);
  }
}

export interface ShowFlags extends RunSelection {
  kind?: 'state' | 'plan' | 'prd' | 'report';
  format?: 'md' | 'json';
}

export function runShow(flags: ShowFlags): number {
  let resolved: ReturnType<typeof resolvePaths>;
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
  try {
    const data = readJsonOrThrow<unknown>(target);
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
      plan = readJsonOrThrow<PlanData>(resolved.paths.plan);
    }
    process.stdout.write(renderState(data as StateData, { plan }));
    return 0;
  } catch (err) {
    if (err instanceof LoadError) {
      console.error(`error: ${err.message}`);
      return 1;
    }
    throw err;
  }
}

export interface ShowReportFlags extends RunSelection {
  format?: 'md' | 'json';
}

export function runShowReport(stepId: string, flags: ShowReportFlags): number {
  if (!stepId) {
    console.error('error: the following arguments are required: step_id');
    return 1;
  }
  let resolved: ReturnType<typeof resolvePaths>;
  try {
    resolved = resolvePaths(flags);
  } catch (err) {
    if (err instanceof ResolveError) {
      console.error(`error: ${err.message}`);
      return err.exitCode;
    }
    throw err;
  }
  const target = resolved.paths.reportFile(stepId);
  if (!existsSync(target)) {
    console.error(`error: no report for step ${stepId}`);
    return 1;
  }
  let data: ReportData;
  try {
    data = readJsonOrThrow<ReportData>(target);
  } catch (err) {
    if (err instanceof LoadError) {
      console.error(`error: ${err.message}`);
      return 1;
    }
    throw err;
  }
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
  let resolved: ReturnType<typeof resolvePaths>;
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
  try {
    // loadState parses state.json internally; a malformed file throws a raw
    // SyntaxError here. Guard it so the CLI exits 1 with a clean message.
    const state = loadState(resolved.paths);
    const format = flags.format ?? 'text';
    if (format === 'json') {
      console.log(JSON.stringify(state, null, 2));
      return 0;
    }
    let plan: PlanData | null = null;
    if (existsSync(resolved.paths.plan)) {
      plan = readJsonOrThrow<PlanData>(resolved.paths.plan);
    }
    process.stdout.write(renderSummary(state, { plan }));
    return 0;
  } catch (err) {
    if (err instanceof LoadError) {
      console.error(`error: ${err.message}`);
      return 1;
    }
    if (err instanceof SyntaxError) {
      console.error(`error: invalid JSON in ${resolved.paths.state}: ${err.message}`);
      return 1;
    }
    // Plain Node errors (EACCES, EISDIR, ENOSPC) from loadState's lock-touch
    // (touchLock -> mkdirSync/openSync) are not SyntaxError or LoadError.
    // Catch them here so I/O failures on the run directory exit 1 with a clean
    // message rather than crashing with a raw stack trace.
    if (err instanceof Error) {
      console.error(`error: cannot read ${resolved.paths.state}: ${err.message}`);
      return 1;
    }
    throw err;
  }
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
      // Skip-and-continue: a single corrupt artifact must not abort the
      // whole sweep and hide every later healthy run. Warn to stderr and
      // move on so the summary still renders for the rest.
      try {
        const state = loadState(paths);
        const plan = existsSync(paths.plan) ? readJsonOrThrow<PlanData>(paths.plan) : null;
        process.stdout.write(renderSummary(state, { plan }));
        emitted += 1;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`warning: skipping ${branch}/${slug}: ${msg}`);
      }
    }
  }
  if (emitted === 0) {
    console.error('error: no active runs found');
    return 1;
  }
  return 0;
}
