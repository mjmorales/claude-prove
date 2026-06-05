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
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { headSha, mainWorktreeRoot } from '@claude-prove/shared';
import { RunPaths, decodeBranchDir } from '../paths';
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
 *  (any ancestor with a `.git` entry — dir OR file for worktree support). */
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

/** `.prove/runs/` always lives off the main worktree even when the subagent
 *  runs from a linked worktree. `mainWorktreeRoot` does this with a single
 *  `git rev-parse --git-common-dir`; fall back to `cwd` when it returns null
 *  (non-repo cwd, bare repo, missing git) so reconciliation still has a root
 *  to scan. */
function resolveMainRoot(cwd: string): string {
  return mainWorktreeRoot(cwd) ?? cwd;
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
  // Same-second edge case: if a step's `started_at` and HEAD's commit timestamp
  // fall in the same unix second, `>=` treats them as "commit happened after
  // step start" and the step auto-completes. Acceptable because step start
  // always precedes the subagent's commit chronologically; only the
  // second-level granularity of `git log %ct` blurs the ordering.
  return headUnix >= startedUnix;
}

/** Single-level scan `<runs_root>/<any>/<slug>/state.json` — enumerate
 *  immediate branch dirs, probe for the slug. Returns first match. */
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
    const statePath = join(runsRoot, branch, slug, 'state.json');
    if (!existsSync(statePath)) continue;
    // `branch` is the on-disk dir name; decode so forRun (which re-encodes)
    // resolves the same dir and callers see the logical branch.
    const logicalBranch = decodeBranchDir(branch);
    return { branch: logicalBranch, paths: RunPaths.forRun(runsRoot, logicalBranch, slug) };
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

  // Locating the run dir requires the main worktree root (one rev-parse).
  // Everything heavier — headSha and the per-step newCommitsSince git calls —
  // is gated behind the in_progress check below so the common no-reconcile
  // case pays no extra git subprocesses.
  const mainRoot = resolveMainRoot(cwd);
  const found = findPaths(mainRoot, slug);
  if (!found) return EMPTY_HOOK_RESULT;
  const { branch, paths } = found;

  let state: StateData;
  try {
    state = loadState(paths);
  } catch (err) {
    // A corrupt/truncated state.json must not be indistinguishable from a
    // clean no-op: emit a diagnostic so a stuck run that never reconciles is
    // visible to the operator. Keeps the non-throwing hook contract.
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`run_state: subagent-stop could not load state for ${slug}: ${msg}\n`);
    return EMPTY_HOOK_RESULT;
  }

  const inprogress = findInprogressSteps(state);
  if (inprogress.length === 0) return EMPTY_HOOK_RESULT;

  // Reconcile-needed path only: the git subprocesses below run solely when an
  // in_progress step actually exists.
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
