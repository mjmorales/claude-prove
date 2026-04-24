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
 * Port of `tools/run_state/hook_stop.py`.
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
        paths: new RunPaths({
          root: runDir,
          prd: join(runDir, 'prd.json'),
          plan: join(runDir, 'plan.json'),
          state: statePath,
          state_lock: join(runDir, 'state.json.lock'),
          reports_dir: join(runDir, 'reports'),
        }),
      });
    }
  }
  return out;
}

export function runStop(payload: Record<string, unknown> | null): HookResult {
  const effective = payload ?? {};
  const project = readCwd(effective) || process.env.CLAUDE_PROJECT_DIR || process.cwd();

  const runsRoot = join(project, '.prove', 'runs');
  if (!isDir(runsRoot)) return EMPTY_HOOK_RESULT;

  const allChanges: TaggedChange[] = [];

  for (const run of iterActiveRuns(runsRoot)) {
    const changes = reconcile(run.paths, { reasonOnHalt: HALT_REASON });
    for (const c of changes) {
      allChanges.push({ branch: run.branch, slug: run.slug, ...c });
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
