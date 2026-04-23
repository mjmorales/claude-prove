/**
 * Scrum reconciler — maps orchestrator run state into the scrum domain.
 *
 * Exported entry points:
 *   - `reconcileRunCompleted(runStatePath, store)` — ingest a single run's
 *     terminal state.json/plan.json, append events, rebuild the task's
 *     context bundle.
 *   - `buildContextBundle(taskId, store)` — aggregate files touched,
 *     decisions cited, prior run summaries for one task.
 *   - `sweepUnreconciled(store, sinceTs)` — walk `.prove/runs/**` and
 *     invoke reconcileRunCompleted for each state.json newer than `sinceTs`.
 *
 * Orphan-run policy (design choice):
 *   When a run's plan.json has no `task_id`, we emit a single
 *   `unlinked_run_detected` event under a reserved sentinel task
 *   `__orphan__`. The sentinel is lazily created as a `backlog` task with
 *   a fixed title so the UI feed surfaces it. We picked the sentinel
 *   approach over a standalone alert table because (a) it reuses the
 *   append-only events log, (b) it keeps `listRecentEvents` as the single
 *   source for orchestration telemetry, and (c) it avoids a new schema
 *   migration. Downstream consumers filter on task_id === ORPHAN_TASK_ID
 *   to render orphans in their own pane.
 */

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import type { ScrumStore } from './store';
import type { ScrumEvent, ScrumTask } from './types';

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

/** Reserved sentinel task id that owns every `unlinked_run_detected` event. */
export const ORPHAN_TASK_ID = '__orphan__';

/** Fixed title for the lazily-created orphan sentinel task. */
export const ORPHAN_TASK_TITLE = 'Unlinked run detections';

// ---------------------------------------------------------------------------
// Return types
// ---------------------------------------------------------------------------

export interface ContextBundle {
  files: string[];
  decisions: Array<{ path: string; title: string }>;
  runs: Array<{
    slug: string;
    branch: string;
    completed_at: string;
    status: string;
  }>;
  summary_text: string;
}

export interface ReconcileRunResult {
  /** 'reconciled' = event(s) appended for a tracked task. */
  /** 'orphan'     = no task_id in plan.json; emitted unlinked_run_detected. */
  /** 'skipped'    = state.json malformed or missing. */
  kind: 'reconciled' | 'orphan' | 'skipped';
  taskId: string | null;
  runPath: string;
  reason?: string;
}

export interface SweepResult {
  scanned: number;
  reconciled: number;
  errors: Error[];
}

// ---------------------------------------------------------------------------
// Internal narrow types — stripped-down shapes of the fields we actually read
// ---------------------------------------------------------------------------

interface StateJsonLite {
  kind?: string;
  run_status?: string;
  slug?: string;
  branch?: string;
  ended_at?: string;
  started_at?: string;
  updated_at?: string;
  tasks?: Array<{
    steps?: Array<{ commit_sha?: string; status?: string }>;
  }>;
  review_verdict?: string;
  steward_verdict?: string;
}

interface PlanJsonLite {
  kind?: string;
  task_id?: string;
  tasks?: Array<unknown>;
}

// ---------------------------------------------------------------------------
// reconcileRunCompleted
// ---------------------------------------------------------------------------

/**
 * Read `runStatePath` + sibling `plan.json`, emit scrum events, and rebuild
 * the linked task's context bundle. Does not throw on orphan runs — returns
 * a `kind: 'orphan'` result instead. Malformed JSON returns `kind: 'skipped'`
 * with `reason` populated so callers can surface the failure.
 */
export function reconcileRunCompleted(runStatePath: string, store: ScrumStore): ReconcileRunResult {
  const runDir = dirname(runStatePath);
  const planPath = join(runDir, 'plan.json');

  const state = readJsonOrNull<StateJsonLite>(runStatePath);
  if (!state || state.kind !== 'state') {
    return {
      kind: 'skipped',
      taskId: null,
      runPath: runDir,
      reason: 'state.json missing or malformed',
    };
  }

  const plan = readJsonOrNull<PlanJsonLite>(planPath);
  const taskId = plan && typeof plan.task_id === 'string' ? plan.task_id : null;

  if (taskId === null) {
    emitOrphanEvent(store, runDir, state);
    return { kind: 'orphan', taskId: null, runPath: runDir };
  }

  // Tracked run — guard missing task via a null check before mutating.
  const task = store.getTask(taskId);
  if (!task) {
    emitOrphanEvent(store, runDir, state, `task '${taskId}' not found in scrum store`);
    return {
      kind: 'orphan',
      taskId,
      runPath: runDir,
      reason: `task '${taskId}' not found`,
    };
  }

  linkRunForTask(store, taskId, runDir, state);
  appendRunCompletedEvent(store, taskId, runDir, state);
  appendStewardVerdictIfPresent(store, taskId, state);
  transitionTaskIfTerminal(store, task, state);
  rebuildContextBundle(store, taskId);

  return { kind: 'reconciled', taskId, runPath: runDir };
}

// ---------------------------------------------------------------------------
// buildContextBundle
// ---------------------------------------------------------------------------

/**
 * Aggregate the task's context for downstream agents. Pulls files touched
 * (from linked runs' state.json commit diff — cheap heuristic: run-level
 * commit_sha fanout via git is handled by Task 5's CLI; here we just read
 * what state.json already records), decisions cited (events kind
 * `decision_linked`), last 5 run summaries, and a concatenated summary of
 * recent event titles.
 */
export function buildContextBundle(taskId: string, store: ScrumStore): ContextBundle {
  const runs = store.listRunsForTask(taskId);
  const events = store.listEventsForTask(taskId, 200);

  const files = collectFilesTouched(runs);
  const decisions = collectDecisions(events);
  const runSummaries = summarizeRuns(runs).slice(-5);
  const summary_text = buildSummaryText(events);

  return {
    files,
    decisions,
    runs: runSummaries,
    summary_text,
  };
}

// ---------------------------------------------------------------------------
// sweepUnreconciled
// ---------------------------------------------------------------------------

/**
 * Walk `.prove/runs/<branch>/<slug>/state.json` entries, reconcile every
 * file whose mtime exceeds `sinceTs`. Errors during individual reconcile
 * calls are collected rather than thrown — callers decide whether a
 * partial sweep is acceptable.
 *
 * Runs root defaults to `<process.cwd()>/.prove/runs`. Pass `projectDir`
 * when the caller knows the project root (e.g., the Stop hook reads it
 * from the Claude Code payload's `cwd`); this keeps the walker correct
 * even when the sweep is invoked from a subdirectory.
 */
export function sweepUnreconciled(
  store: ScrumStore,
  sinceTs: number,
  projectDir?: string,
): SweepResult {
  const root = projectDir ?? process.cwd();
  const runsRoot = join(root, '.prove', 'runs');
  const result: SweepResult = { scanned: 0, reconciled: 0, errors: [] };
  if (!existsSync(runsRoot) || !isDir(runsRoot)) return result;

  for (const statePath of walkStateFiles(runsRoot)) {
    result.scanned++;
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(statePath).mtime.getTime();
    } catch {
      continue;
    }
    if (mtimeMs <= sinceTs) continue;

    try {
      const outcome = reconcileRunCompleted(statePath, store);
      if (outcome.kind === 'reconciled' || outcome.kind === 'orphan') {
        result.reconciled++;
      }
    } catch (err) {
      result.errors.push(err instanceof Error ? err : new Error(String(err)));
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Internals — tracked-run helpers
// ---------------------------------------------------------------------------

function linkRunForTask(
  store: ScrumStore,
  taskId: string,
  runDir: string,
  state: StateJsonLite,
): void {
  const runPath = toRunPath(runDir);
  store.linkRun({
    taskId,
    runPath,
    branch: typeof state.branch === 'string' ? state.branch : null,
    slug: typeof state.slug === 'string' ? state.slug : null,
  });
}

function appendRunCompletedEvent(
  store: ScrumStore,
  taskId: string,
  runDir: string,
  state: StateJsonLite,
): void {
  store.appendEvent({
    taskId,
    kind: 'run_completed',
    payload: {
      run_path: toRunPath(runDir),
      run_status: state.run_status ?? 'unknown',
      branch: state.branch ?? null,
      slug: state.slug ?? null,
      ended_at: state.ended_at ?? state.updated_at ?? '',
    },
  });
}

function appendStewardVerdictIfPresent(
  store: ScrumStore,
  taskId: string,
  state: StateJsonLite,
): void {
  const verdict = state.steward_verdict ?? state.review_verdict;
  if (!verdict) return;
  store.appendEvent({
    taskId,
    kind: 'steward_verdict',
    payload: { verdict },
  });
}

/**
 * Only `completed` runs drive the task to `done`. Halted/failed runs leave
 * status alone — the orchestrator may retry, and a human review may still
 * push the task forward. Transition errors (e.g., illegal edge from a
 * terminal status) are swallowed because the event log already records
 * the run outcome.
 */
function transitionTaskIfTerminal(store: ScrumStore, task: ScrumTask, state: StateJsonLite): void {
  if (state.run_status !== 'completed') return;
  if (task.status === 'done' || task.status === 'cancelled') return;

  try {
    store.updateTaskStatus(task.id, 'done');
  } catch {
    // Invalid transition — event log already captured the run_completed signal.
  }
}

function rebuildContextBundle(store: ScrumStore, taskId: string): void {
  const bundle = buildContextBundle(taskId, store);
  store.saveContextBundle(taskId, bundle);
}

// ---------------------------------------------------------------------------
// Internals — orphan path
// ---------------------------------------------------------------------------

function emitOrphanEvent(
  store: ScrumStore,
  runDir: string,
  state: StateJsonLite,
  extraReason?: string,
): void {
  ensureOrphanTask(store);
  store.appendEvent({
    taskId: ORPHAN_TASK_ID,
    kind: 'unlinked_run_detected',
    payload: {
      run_path: toRunPath(runDir),
      run_status: state.run_status ?? 'unknown',
      branch: state.branch ?? null,
      slug: state.slug ?? null,
      reason: extraReason ?? 'plan.json missing task_id',
    },
  });
}

function ensureOrphanTask(store: ScrumStore): void {
  if (store.getTask(ORPHAN_TASK_ID)) return;
  store.createTask({
    id: ORPHAN_TASK_ID,
    title: ORPHAN_TASK_TITLE,
    description: 'Sentinel task collecting unlinked_run_detected events.',
    status: 'backlog',
  });
}

// ---------------------------------------------------------------------------
// Internals — context bundle aggregation
// ---------------------------------------------------------------------------

function collectFilesTouched(runs: ReturnType<ScrumStore['listRunsForTask']>): string[] {
  const seen = new Set<string>();
  for (const run of runs) {
    const statePath = resolveRunStatePath(run.run_path);
    const state = readJsonOrNull<StateJsonLite>(statePath);
    if (!state || !Array.isArray(state.tasks)) continue;
    // state.json doesn't carry per-file diffs in v1 — collect any `files`
    // array if a future version adds it. For now, fall back to commit shas
    // so the bundle still records *something* provenance-worthy.
    for (const task of state.tasks) {
      if (!Array.isArray(task.steps)) continue;
      for (const step of task.steps) {
        if (typeof step.commit_sha === 'string' && step.commit_sha) {
          seen.add(`commit:${step.commit_sha}`);
        }
      }
    }
  }
  return Array.from(seen).sort();
}

function collectDecisions(events: ScrumEvent[]): Array<{ path: string; title: string }> {
  const out: Array<{ path: string; title: string }> = [];
  for (const event of events) {
    if (event.kind !== 'decision_linked') continue;
    const payload = event.payload as Record<string, unknown> | null;
    if (!payload) continue;
    const path = typeof payload.path === 'string' ? payload.path : '';
    const title = typeof payload.title === 'string' ? payload.title : '';
    if (path) out.push({ path, title });
  }
  return out;
}

function summarizeRuns(runs: ReturnType<ScrumStore['listRunsForTask']>): ContextBundle['runs'] {
  return runs.map((run) => {
    const statePath = resolveRunStatePath(run.run_path);
    const state = readJsonOrNull<StateJsonLite>(statePath);
    return {
      slug: run.slug ?? '',
      branch: run.branch ?? '',
      completed_at: state?.ended_at ?? state?.updated_at ?? run.linked_at,
      status: state?.run_status ?? 'unknown',
    };
  });
}

function buildSummaryText(events: ScrumEvent[]): string {
  // Newest-first already (listEventsForTask order); cap at 10 for bundle size.
  const lines: string[] = [];
  for (const event of events.slice(0, 10)) {
    lines.push(`[${event.ts}] ${event.kind}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Internals — filesystem + JSON helpers
// ---------------------------------------------------------------------------

/** Walk `<runsRoot>/<branch>/<slug>/state.json` — matches run-state layout. */
function* walkStateFiles(runsRoot: string): Iterable<string> {
  let branches: string[];
  try {
    branches = readdirSync(runsRoot);
  } catch {
    return;
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
      const statePath = join(branchDir, slug, 'state.json');
      if (existsSync(statePath)) yield statePath;
    }
  }
}

function readJsonOrNull<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Normalize `runDir` into a repo-relative path (matches Task 1's
 * `linkRun(runPath: '.prove/runs/...')` convention). Falls back to the
 * absolute path when `runDir` lives outside `process.cwd()`. Uses
 * realpath on both sides so macOS tmpdir symlinks (/var vs /private/var)
 * don't produce spurious `../../..` traversals.
 */
function toRunPath(runDir: string): string {
  const cwdReal = safeRealpath(process.cwd());
  const dirReal = safeRealpath(runDir);
  const rel = relative(cwdReal, dirReal);
  if (rel && !rel.startsWith('..')) return rel;
  return runDir;
}

/**
 * Resolve `join(cwdOrProject, runPath)` with an absolute-path shortcut so
 * bundle aggregation handles both stored forms (repo-relative + absolute).
 */
function resolveRunStatePath(runPath: string): string {
  if (isAbsolute(runPath)) return join(runPath, 'state.json');
  return join(process.cwd(), runPath, 'state.json');
}

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}
