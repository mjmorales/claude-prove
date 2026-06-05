/**
 * Stop hook — reconcile lingering in_progress steps at session end.
 *
 * Any step left in `in_progress` when the top-level session terminates is
 * halted with a diagnostic reason. Prevents ghost steps: a fresh session
 * always sees either an accurate in-flight run or a clean halt.
 *
 * Walks every active run under `$CLAUDE_PROJECT_DIR/.prove/runs/` and
 * invokes `reconcile()` on each. Emits a `systemMessage` when any step
 * actually changed (Stop does not support `hookSpecificOutput`).
 *
 * Stop fires at the end of every driver turn, not only at true session
 * termination. A run whose work was dispatched to background agents in
 * sub-task worktrees (`.claude/worktrees/<slug>-task-*`) is legitimately
 * in_progress while the driver yields, so any run with a live task
 * worktree is skipped — its steps complete later via SubagentStop or an
 * explicit `run-state step`, and the worktrees are removed on merge.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { RunPaths } from '../paths';
import { type ReconcileChange, reconcile } from '../state';
import { isDir, readStateJson } from './fs-utils';
import { pyJsonDump } from './json-compat';
import { EMPTY_HOOK_RESULT, type HookResult, readCwd } from './types';

const HALT_REASON = 'session ended with step still in_progress — no completion recorded';

interface RunLocator {
  branch: string;
  slug: string;
  paths: RunPaths;
}

/** `ReconcileChange` annotated with run identity so Stop can render a single
 *  multi-run summary line across every reconciled step. */
interface TaggedChange extends ReconcileChange {
  branch: string;
  slug: string;
}

/** Enumerate `<runs_root>/<branch>/<slug>/state.json` and yield each run
 *  whose `run_status` is not `completed`. */
function iterActiveRuns(runsRoot: string): RunLocator[] {
  const out: RunLocator[] = [];
  if (!existsSync(runsRoot) || !isDir(runsRoot)) return out;

  let branches: string[];
  try {
    branches = readdirSync(runsRoot);
  } catch {
    return out;
  }

  for (const branch of branches) {
    const branchDir = join(runsRoot, branch);
    if (!isDir(branchDir)) continue;

    let slugs: string[];
    try {
      slugs = readdirSync(branchDir);
    } catch {
      continue;
    }

    for (const slug of slugs) {
      const runDir = join(branchDir, slug);
      const statePath = join(runDir, 'state.json');
      const data = readStateJson(statePath);
      if (!data) continue;
      if (data.kind !== 'state') continue;
      if (data.run_status === 'completed') continue;

      out.push({
        branch,
        slug,
        paths: RunPaths.forRun(runsRoot, branch, slug),
      });
    }
  }
  return out;
}

/** True when the run has at least one live sub-task worktree
 *  (`.claude/worktrees/<slug>-task-*`) — background agents in flight. */
function hasLiveTaskWorktrees(project: string, slug: string): boolean {
  const worktreeDir = join(project, '.claude', 'worktrees');
  const prefix = `${slug}-task-`;
  try {
    return readdirSync(worktreeDir, { withFileTypes: true }).some(
      (e) => e.isDirectory() && e.name.startsWith(prefix),
    );
  } catch {
    return false;
  }
}

export function runStop(payload: Record<string, unknown> | null): HookResult {
  const effective = payload ?? {};
  const project = readCwd(effective) || process.env.CLAUDE_PROJECT_DIR || process.cwd();

  const runsRoot = join(project, '.prove', 'runs');
  if (!isDir(runsRoot)) return EMPTY_HOOK_RESULT;

  const allChanges: TaggedChange[] = [];

  for (const run of iterActiveRuns(runsRoot)) {
    // Background agents in flight: the run's steps are legitimately
    // in_progress while the driver yields its turn — halting them here
    // would spuriously kill dispatched work seconds after dispatch.
    if (hasLiveTaskWorktrees(project, run.slug)) continue;

    // Isolate each run: a malformed state.json, an I/O error, or an illegal
    // task transition in one run must not abort reconciliation of the others —
    // an unguarded throw here would leave every later active run with ghost
    // in_progress steps until some future firing happens to get past it.
    try {
      const changes = reconcile(run.paths, { reasonOnHalt: HALT_REASON });
      for (const c of changes) {
        allChanges.push({ branch: run.branch, slug: run.slug, ...c });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`run_state: reconcile failed for ${run.branch}/${run.slug}: ${msg}\n`);
    }
  }

  if (allChanges.length === 0) return EMPTY_HOOK_RESULT;

  const lines: string[] = ['run_state: reconciled in_progress steps at session end:'];
  for (const c of allChanges) {
    lines.push(`- ${c.branch}/${c.slug} ${c.step_id} → ${c.action}: ${c.detail}`);
  }

  const body = pyJsonDump({ systemMessage: lines.join('\n') });
  return { exitCode: 0, stdout: body, stderr: '' };
}
