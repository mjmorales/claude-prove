/**
 * `claude-prove scrum alerts [--human] [--stalled-after-days N] [--workspace-root W]`
 *
 * Operator-facing signal aggregator. Emits two classes of alert:
 *
 *   - stalled_wip: tasks in `in_progress` or `review` whose
 *     `last_event_at` is older than the stalled-after threshold (default
 *     7 days).
 *   - orphan_runs: orchestrator run directories under
 *     `<workspaceRoot>/.prove/runs/<branch>/<slug>/` that have no row in
 *     `scrum_run_links`. Missing `.prove/runs/` directory is a clean
 *     no-op — orphans come back empty rather than erroring.
 *
 * Default emits JSON on stdout; `--human` renders a compact text table.
 * stderr always carries a one-line summary.
 *
 * Exit codes:
 *   0  success (even when alerts are present; this is a report, not a gate)
 *   1  workspace unresolvable or store open error
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { mainWorktreeRoot } from '@claude-prove/shared';
import { type ScrumStore, openScrumStore } from '../store';
import type { ScrumTask, TaskStatus } from '../types';

export interface AlertsCmdFlags {
  human?: boolean;
  stalledAfterDays?: number | string;
  workspaceRoot?: string;
}

const DEFAULT_STALLED_AFTER_DAYS = 7;
const STALLED_STATUSES: TaskStatus[] = ['in_progress', 'review'];

interface StalledEntry {
  id: string;
  title: string;
  status: TaskStatus;
  last_event_at: string | null;
  stalled_days: number;
}

interface OrphanRun {
  branch: string;
  slug: string;
  run_path: string;
}

interface AlertsReport {
  stalled_after_days: number;
  stalled_wip: StalledEntry[];
  orphan_runs: OrphanRun[];
}

export function runAlertsCmd(flags: AlertsCmdFlags): number {
  const workspaceRoot =
    flags.workspaceRoot && flags.workspaceRoot.length > 0
      ? flags.workspaceRoot
      : (mainWorktreeRoot() ?? process.cwd());
  const stalledAfterDays = resolveStalledAfterDays(flags.stalledAfterDays);

  const store = openScrumStore({ override: join(workspaceRoot, '.prove', 'prove.db') });
  try {
    const stalled = findStalledWip(store, stalledAfterDays);
    const orphans = findOrphanRuns(store, workspaceRoot);
    const report: AlertsReport = {
      stalled_after_days: stalledAfterDays,
      stalled_wip: stalled,
      orphan_runs: orphans,
    };
    if (flags.human === true) {
      process.stdout.write(renderHumanTable(report));
    } else {
      process.stdout.write(`${JSON.stringify(report)}\n`);
    }
    process.stderr.write(
      `scrum alerts: ${stalled.length} stalled WIP, ${orphans.length} orphan runs\n`,
    );
    return 0;
  } finally {
    store.close();
  }
}

function resolveStalledAfterDays(raw: number | string | undefined): number {
  if (raw === undefined) return DEFAULT_STALLED_AFTER_DAYS;
  const n = typeof raw === 'number' ? raw : Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_STALLED_AFTER_DAYS;
}

function findStalledWip(store: ScrumStore, stalledAfterDays: number): StalledEntry[] {
  const now = Date.now();
  const thresholdMs = stalledAfterDays * 24 * 60 * 60 * 1000;
  const stalled: StalledEntry[] = [];
  for (const status of STALLED_STATUSES) {
    for (const task of store.listTasks({ status })) {
      const lastEvent = pickLastEventTs(task);
      if (lastEvent === null) continue;
      const ageMs = now - lastEvent.getTime();
      if (ageMs < thresholdMs) continue;
      stalled.push({
        id: task.id,
        title: task.title,
        status: task.status,
        last_event_at: task.last_event_at ?? null,
        stalled_days: Math.floor(ageMs / (24 * 60 * 60 * 1000)),
      });
    }
  }
  stalled.sort((a, b) => b.stalled_days - a.stalled_days);
  return stalled;
}

function pickLastEventTs(task: ScrumTask): Date | null {
  const raw = task.last_event_at ?? task.created_at;
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function findOrphanRuns(store: ScrumStore, workspaceRoot: string): OrphanRun[] {
  const runsDir = join(workspaceRoot, '.prove', 'runs');
  if (!existsSync(runsDir) || !safeIsDir(runsDir)) return [];

  const orphans: OrphanRun[] = [];
  for (const branch of readdirSync(runsDir)) {
    const branchDir = join(runsDir, branch);
    if (!safeIsDir(branchDir)) continue;
    for (const slug of readdirSync(branchDir)) {
      const runDir = join(branchDir, slug);
      if (!safeIsDir(runDir)) continue;
      const runPath = join('.prove', 'runs', branch, slug);
      if (store.getTaskForRun(runPath) !== null) continue;
      orphans.push({ branch, slug, run_path: runPath });
    }
  }
  return orphans;
}

function safeIsDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function renderHumanTable(report: AlertsReport): string {
  const lines: string[] = [];
  lines.push(
    `Stalled WIP (${report.stalled_wip.length}, threshold ${report.stalled_after_days}d):`,
  );
  if (report.stalled_wip.length === 0) {
    lines.push('  (none)');
  } else {
    for (const entry of report.stalled_wip) {
      lines.push(`  [${entry.status}] ${entry.id}  ${entry.stalled_days}d  ${entry.title}`);
    }
  }
  lines.push('');
  lines.push(`Orphan runs (${report.orphan_runs.length}):`);
  if (report.orphan_runs.length === 0) {
    lines.push('  (none)');
  } else {
    for (const orphan of report.orphan_runs) {
      lines.push(`  ${orphan.branch}/${orphan.slug}  (${orphan.run_path})`);
    }
  }
  return `${lines.join('\n')}\n`;
}
