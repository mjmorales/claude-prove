/**
 * SubagentStop hook — reconcile in_progress steps in the subagent's worktree.
 *
 * When a worktree subagent finishes, check whether the step it was working
 * on is still `in_progress`. If the subagent produced a new commit on the
 * branch, auto-complete the step with HEAD's SHA. Otherwise, halt with a
 * diagnostic reason.
 *
 * Scope is narrow on purpose: only the run tied to the subagent's CWD
 * (resolved via `.prove-wt-slug.txt`) is touched. Runs not tied to this
 * worktree are left alone so the hook never interferes with unrelated work.
 *
 * Port of `tools/run_state/hook_subagent_stop.py`.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { headSha } from '@claude-prove/shared';
import { RunPaths } from '../paths';
import {
  type ReconcileChange,
  type StateData,
  findInprogressSteps,
  loadState,
  reconcile,
} from '../state';
import { pyJsonDump } from './json-compat';
import { EMPTY_HOOK_RESULT, type HookResult, readCwd } from './types';

const HALT_REASON = 'subagent exited without recording completion; no new commits found';

/** Cap the ancestor walk when invoked outside any git repo, matching Python. */
const MAX_ANCESTOR_DEPTH = 16;

function readMarker(path: string): string | null {
  try {
    const text = readFileSync(path, 'utf8').trim();
    return text || null;
  } catch {
    return null;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Walk `cwd` upward looking for `.prove-wt-slug.txt`. Stop at repo root
 *  (any ancestor with a `.git` entry — dir OR file for worktree support).
 *  Matches Python's `_resolve_slug`. */
function resolveSlug(cwd: string): string | null {
  let cur = resolve(cwd);
  for (let depth = 0; depth <= MAX_ANCESTOR_DEPTH; depth++) {
    const marker = join(cur, '.prove-wt-slug.txt');
    if (isFile(marker)) {
      const slug = readMarker(marker);
      if (slug) return slug;
    }
    if (existsSync(join(cur, '.git'))) break;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

/** Resolve the main worktree (the one backed by `.git/` rather than a
 *  `.git` file). `.prove/runs/` always lives off the main worktree even
 *  when the subagent runs from a linked worktree. Matches Python's
 *  `_main_worktree` — first "worktree <path>" line from `git worktree list`. */
function mainWorktree(cwd: string): string {
  const proc = Bun.spawnSync({
    cmd: ['git', 'worktree', 'list', '--porcelain'],
    cwd,
    stdout: 'pipe',
    stderr: 'ignore',
  });
  if (proc.exitCode !== 0) return cwd;
  const out = proc.stdout.toString();
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      return line.slice('worktree '.length).trim();
    }
  }
  return cwd;
}

/** `true` iff HEAD's commit timestamp is >= the step's `started_at`.
 *  Parity with Python: compares via unix epoch seconds to avoid ISO-8601
 *  timezone-offset parsing quirks (git's %cI vs our `Z` suffix). */
function newCommitsSince(cwd: string, isoTs: string): boolean {
  if (!isoTs) return false;
  const proc = Bun.spawnSync({
    cmd: ['git', 'log', '-1', '--format=%ct', 'HEAD'],
    cwd,
    stdout: 'pipe',
    stderr: 'ignore',
  });
  if (proc.exitCode !== 0) return false;
  const raw = proc.stdout.toString().trim();
  const headUnix = Number.parseInt(raw, 10);
  if (!Number.isFinite(headUnix)) return false;

  const normalized = isoTs.replace('Z', '+00:00');
  const parsed = Date.parse(normalized);
  if (Number.isNaN(parsed)) return false;
  const startedUnix = Math.floor(parsed / 1000);
  return headUnix >= startedUnix;
}

/** Mirror Python's single-level glob `<runs_root>/<any>/<slug>/state.json` —
 *  enumerate immediate branch dirs, probe for the slug. Returns first match. */
function findPaths(mainRoot: string, slug: string): { branch: string; paths: RunPaths } | null {
  const runsRoot = join(mainRoot, '.prove', 'runs');
  if (!existsSync(runsRoot)) return null;

  let branches: string[];
  try {
    branches = readdirSync(runsRoot);
  } catch {
    return null;
  }

  for (const branch of branches) {
    const runDir = join(runsRoot, branch, slug);
    const statePath = join(runDir, 'state.json');
    if (!existsSync(statePath)) continue;
    const paths = new RunPaths({
      root: runDir,
      prd: join(runDir, 'prd.json'),
      plan: join(runDir, 'plan.json'),
      state: statePath,
      state_lock: join(runDir, 'state.json.lock'),
      reports_dir: join(runDir, 'reports'),
    });
    return { branch, paths };
  }
  return null;
}

function findStepById(state: StateData, stepId: string) {
  for (const task of state.tasks ?? []) {
    for (const step of task.steps ?? []) {
      if (step.id === stepId) return step;
    }
  }
  return null;
}

export function runSubagentStop(payload: Record<string, unknown> | null): HookResult {
  if (!payload) return EMPTY_HOOK_RESULT;

  const cwd = readCwd(payload) || process.cwd();
  const slug = resolveSlug(cwd);
  if (!slug) return EMPTY_HOOK_RESULT;

  const mainRoot = mainWorktree(cwd);
  const found = findPaths(mainRoot, slug);
  if (!found) return EMPTY_HOOK_RESULT;
  const { branch, paths } = found;

  let state: StateData;
  try {
    state = loadState(paths);
  } catch {
    return EMPTY_HOOK_RESULT;
  }

  const inprogress = findInprogressSteps(state);
  if (inprogress.length === 0) return EMPTY_HOOK_RESULT;

  const scopeIds = new Set(inprogress.map(([, sid]) => sid));
  const latestSha = headSha(cwd);

  let anyNewCommit = false;
  for (const [, sid] of inprogress) {
    const step = findStepById(state, sid);
    if (step && newCommitsSince(cwd, step.started_at ?? '')) {
      anyNewCommit = true;
      break;
    }
  }

  const changes: ReconcileChange[] = reconcile(paths, {
    worktreeLatestCommit: anyNewCommit && latestSha ? latestSha : undefined,
    scopeStepIds: scopeIds,
    reasonOnHalt: HALT_REASON,
  });

  if (changes.length === 0) return EMPTY_HOOK_RESULT;

  const lines: string[] = [`run_state: reconciled ${branch}/${slug} after subagent stop:`];
  for (const c of changes) {
    lines.push(`- ${c.step_id} → ${c.action}: ${c.detail}`);
  }

  const body = pyJsonDump({ systemMessage: lines.join('\n') });
  return { exitCode: 0, stdout: body, stderr: '' };
}
