/**
 * `run-state report write <step_id> --status S [--commit SHA] [--json FILE] [--notes TEXT]`
 *
 * Mirrors Python `cmd_report` write branch. When `--json` supplies a full
 * report payload file, that takes precedence; otherwise build a minimal
 * report from flags + plan.json.
 *
 * The `show` branch depends on the render module (Task 4) and is
 * currently stubbed — it exits 2 with a pointer.
 */

import { readFileSync } from 'node:fs';
import { CURRENT_SCHEMA_VERSION, STEP_STATUSES } from '../schemas';
import { type PlanData, type ReportData, reportWrite, utcnowIso } from '../state';
import { validateData } from '../validate';
import { ResolveError, type RunSelection, resolvePaths } from './resolve';

export interface ReportWriteFlags extends RunSelection {
  status?: string;
  commit?: string;
  json?: string;
  notes?: string;
}

export function runReportWrite(stepId: string, flags: ReportWriteFlags): number {
  if (!stepId) {
    console.error('error: the following arguments are required: step_id');
    return 1;
  }
  if (!flags.status) {
    console.error('error: the following arguments are required: --status');
    return 1;
  }
  if (!(STEP_STATUSES as readonly string[]).includes(flags.status)) {
    const allowed = STEP_STATUSES.map((s) => `'${s}'`).join(', ');
    console.error(`error: invalid --status '${flags.status}' (expected one of: ${allowed})`);
    return 1;
  }
  const status = flags.status as ReportData['status'];
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

  let report: ReportData;
  if (flags.json) {
    try {
      report = JSON.parse(readFileSync(flags.json, 'utf8')) as ReportData;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`error: ${msg}`);
      return 1;
    }
  } else {
    let plan: PlanData;
    try {
      plan = JSON.parse(readFileSync(resolved.paths.plan, 'utf8')) as PlanData;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`error: ${msg}`);
      return 1;
    }
    const taskId = taskIdForStep(plan, stepId);
    if (taskId === null) {
      console.error(`error: step ${stepId} not found in plan`);
      return 1;
    }
    report = {
      schema_version: CURRENT_SCHEMA_VERSION,
      kind: 'report',
      step_id: stepId,
      task_id: taskId,
      status,
      commit_sha: flags.commit ?? '',
      // `started_at` is intentionally empty for synthetic reports: the CLI
      // only learns of the step at completion time, so there is no authoritative
      // start timestamp. Callers needing a start time must supply a full
      // payload via --json.
      started_at: '',
      ended_at: utcnowIso(),
      diff_stats: { files_changed: 0, insertions: 0, deletions: 0 },
      validators: [],
      artifacts: [],
      notes: flags.notes ?? '',
    };
  }

  const findings = validateData(report, 'report');
  if (!findings.ok) {
    for (const e of findings.errors) console.error(e);
    return 2;
  }

  const target = reportWrite(resolved.paths, report);
  console.log(`wrote: ${target}`);
  return 0;
}

function taskIdForStep(plan: PlanData, stepId: string): string | null {
  for (const task of plan.tasks ?? []) {
    for (const step of task.steps ?? []) {
      if (step.id === stepId) return task.id;
    }
  }
  return null;
}
