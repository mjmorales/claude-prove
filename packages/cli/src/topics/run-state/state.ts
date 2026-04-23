/**
 * State mutations for `.prove/runs/<branch>/<slug>/state.json`.
 *
 * The run_state CLI is the sole blessed writer for `state.json`. All
 * mutations funnel through this module so invariants (status transitions,
 * monotonic timestamps, dispatch dedup) hold uniformly.
 *
 * Ported 1:1 from `tools/run_state/state.py`. On-disk JSON must stay
 * byte-equivalent with the Python source: object key order follows Python's
 * dict construction order, `JSON.stringify(..., null, 2)` matches Python's
 * `indent=2`, and files end with a trailing newline.
 *
 * Atomic write: temp-file (`<path>.tmp`) + rename to target. The lock file
 * (`state.json.lock`) is a presence-flag sidecar (Python uses fcntl.flock
 * for advisory locking; TS keeps the sidecar for on-disk parity). Single-
 * process orchestrator runs are typical — callers should funnel through
 * this module rather than writing state.json directly.
 */

import { closeSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { RunPaths } from './paths';
import {
  CURRENT_SCHEMA_VERSION,
  PLAN_SCHEMA,
  PRD_SCHEMA,
  VALIDATOR_PHASES,
  VALIDATOR_STATUSES,
} from './schemas';
import type { FieldSpec, Schema } from './validator-engine';

// ---------------------------------------------------------------------------
// Types — the on-disk JSON shape, exported for callers that want strict typing.
// ---------------------------------------------------------------------------

export type StepStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped' | 'halted';

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'halted';

export type RunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'halted';

export type ReviewVerdict = 'pending' | 'approved' | 'rejected' | 'n/a';

export type ValidatorPhase = 'build' | 'lint' | 'test' | 'custom' | 'llm';

export type ValidatorStatus = 'pending' | 'pass' | 'fail' | 'skipped';

export interface ValidatorSummary {
  build: ValidatorStatus;
  lint: ValidatorStatus;
  test: ValidatorStatus;
  custom: ValidatorStatus;
  llm: ValidatorStatus;
}

export interface StepData {
  id: string;
  status: StepStatus;
  started_at: string;
  ended_at: string;
  commit_sha: string;
  validator_summary: ValidatorSummary;
  halt_reason: string;
}

export interface ReviewData {
  verdict: ReviewVerdict;
  notes: string;
  reviewer: string;
  reviewed_at: string;
}

export interface TaskData {
  id: string;
  status: TaskStatus;
  started_at: string;
  ended_at: string;
  review: ReviewData;
  steps: StepData[];
}

export interface DispatchEntry {
  key: string;
  event: string;
  timestamp: string;
}

export interface DispatchLedger {
  dispatched: DispatchEntry[];
}

export interface StateData {
  schema_version: string;
  kind: string;
  run_status: RunStatus;
  slug: string;
  branch: string;
  current_task: string;
  current_step: string;
  started_at: string;
  updated_at: string;
  ended_at: string;
  tasks: TaskData[];
  dispatch: DispatchLedger;
}

export interface PlanTaskInput {
  id: string;
  title: string;
  wave?: number;
  deps?: string[];
  description?: string;
  acceptance_criteria?: string[];
  worktree?: { path: string; branch: string };
  steps: Array<{
    id: string;
    title: string;
    description?: string;
    acceptance_criteria?: string[];
  }>;
  [extra: string]: unknown;
}

export interface PlanData {
  schema_version: string;
  kind: string;
  mode: string;
  tasks: PlanTaskInput[];
  /** Optional scrum task id linking this run to a scrum backlog entry. */
  task_id?: string;
  [extra: string]: unknown;
}

export interface PrdData {
  schema_version: string;
  kind: string;
  title: string;
  [extra: string]: unknown;
}

export interface ReportData {
  schema_version: string;
  kind: string;
  step_id: string;
  task_id: string;
  status: StepStatus;
  [extra: string]: unknown;
}

export interface ReconcileChange {
  step_id: string;
  action: 'completed' | 'halted';
  detail: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Raised when a state mutation violates an invariant. Message strings match
 * the Python source verbatim — hooks pipe these to stderr for agents to read.
 */
export class StateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StateError';
  }
}

// ---------------------------------------------------------------------------
// Time utilities — centralized so tests can stub.
// ---------------------------------------------------------------------------

/**
 * Unified clock seam for state + migrate modules. Python tests monkeypatch
 * `tools.run_state.state.utcnow_iso`; the TS equivalent is swapping
 * `_clock.now`. Both `state.ts` and `migrate.ts` route through this single
 * indirection so a single override covers both modules.
 */
export const _clock: { now: () => string } = {
  now: defaultUtcnowIso,
};

function defaultUtcnowIso(): string {
  // Parity seam for capture.sh harnesses: PROVE_STATE_FROZEN_NOW lets Python
  // and TS sides emit identical timestamps. Not used in production.
  const frozen = process.env.PROVE_STATE_FROZEN_NOW;
  if (frozen) return frozen;
  // Match Python: datetime.now(UTC).strftime('%Y-%m-%dT%H:%M:%SZ')
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** ISO-8601 UTC timestamp with `Z` suffix, seconds precision. */
export function utcnowIso(): string {
  return _clock.now();
}

// ---------------------------------------------------------------------------
// Low-level JSON I/O: lock-file sidecar + atomic write.
// ---------------------------------------------------------------------------

/**
 * Ensure the lock sidecar exists so its presence mirrors the Python source.
 * Python uses fcntl.flock on this fd; TS keeps the sidecar for on-disk parity.
 */
function touchLock(lockPath: string): void {
  mkdirSync(dirname(lockPath), { recursive: true });
  const fd = openSync(lockPath, 'a');
  closeSync(fd);
}

function readJson(path: string): Record<string, unknown> {
  const raw = readFileSync(path, 'utf8');
  return JSON.parse(raw) as Record<string, unknown>;
}

/**
 * Atomic write via temp-file + rename. Python: `json.dump(indent=2) + '\n'`
 * then `os.replace`. We mirror exactly: 2-space indent, trailing newline,
 * no key sorting (construction order preserved).
 *
 * Exported so `migrate.ts` shares the exact same writer and stays byte-equal.
 */
export function writeJsonAtomic(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  const body = `${JSON.stringify(data, null, 2)}\n`;
  writeFileSync(tmp, body, 'utf8');
  renameSync(tmp, path);
}

// ---------------------------------------------------------------------------
// Defaults / factory helpers
// ---------------------------------------------------------------------------

/**
 * JSON-only deep clone used by factory helpers to avoid sharing nested
 * default arrays/dicts across fresh payloads. Exported so `migrate.ts`
 * shares the exact same routine.
 */
export function deepCloneJson<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => deepCloneJson(v)) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = deepCloneJson(v);
  }
  return out as unknown as T;
}

/** Back-compat alias for call sites that used the shorter name. */
const deepCopy = deepCloneJson;

/**
 * Render a minimal object populated with defaults for every field that has
 * one. Exported so `migrate.ts` shares the exact same routine.
 */
export function defaultsFromSchema(schema: Schema): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(schema.fields) as Array<[string, FieldSpec]>) {
    if ('default' in spec) {
      out[name] = deepCloneJson(spec.default);
    }
  }
  return out;
}

/** Factory for a fresh prd.json shell — matches Python `new_prd`. */
export function newPrd(title: string, extras: Record<string, unknown> = {}): PrdData {
  const prd = defaultsFromSchema(PRD_SCHEMA);
  prd.schema_version = CURRENT_SCHEMA_VERSION;
  prd.kind = 'prd';
  prd.title = title;
  for (const [k, v] of Object.entries(extras)) {
    prd[k] = v;
  }
  return prd as unknown as PrdData;
}

/** Factory for a fresh plan.json shell — matches Python `new_plan`. */
export function newPlan(tasks: PlanTaskInput[], mode = 'simple'): PlanData {
  const plan = defaultsFromSchema(PLAN_SCHEMA);
  plan.schema_version = CURRENT_SCHEMA_VERSION;
  plan.kind = 'plan';
  plan.mode = mode;
  plan.tasks = tasks;
  return plan as unknown as PlanData;
}

/**
 * Initialize a `state.json` shell mirroring the plan's task/step tree.
 *
 * Construction-order parity with Python is load-bearing: the JSON key order
 * on disk must match byte-for-byte. Do not reorder field assignments.
 */
export function newState(slug: string, branch: string, plan: PlanData): StateData {
  const now = utcnowIso();
  const tasksState: TaskData[] = [];
  for (const task of plan.tasks ?? []) {
    const stepsState: StepData[] = [];
    for (const step of task.steps ?? []) {
      stepsState.push({
        id: step.id,
        status: 'pending',
        started_at: '',
        ended_at: '',
        commit_sha: '',
        validator_summary: {
          build: 'pending',
          lint: 'pending',
          test: 'pending',
          custom: 'pending',
          llm: 'pending',
        },
        halt_reason: '',
      });
    }
    tasksState.push({
      id: task.id,
      status: 'pending',
      started_at: '',
      ended_at: '',
      review: {
        verdict: 'pending',
        notes: '',
        reviewer: '',
        reviewed_at: '',
      },
      steps: stepsState,
    });
  }

  return {
    schema_version: CURRENT_SCHEMA_VERSION,
    kind: 'state',
    run_status: 'pending',
    slug,
    branch,
    current_task: '',
    current_step: '',
    started_at: '',
    updated_at: now,
    ended_at: '',
    tasks: tasksState,
    dispatch: { dispatched: [] },
  };
}

// ---------------------------------------------------------------------------
// High-level operations
// ---------------------------------------------------------------------------

export interface InitRunOptions {
  prd?: PrdData;
  overwrite?: boolean;
}

/**
 * Create the run directory and write prd.json, plan.json, state.json.
 * Throws `StateError` if the run exists and `overwrite` is not set.
 */
export function initRun(
  runsRoot: string,
  branch: string,
  slug: string,
  plan: PlanData,
  options: InitRunOptions = {},
): RunPaths {
  const paths = RunPaths.forRun(runsRoot, branch, slug);
  mkdirSync(paths.root, { recursive: true });
  mkdirSync(paths.reports_dir, { recursive: true });

  if (stateExists(paths) && !options.overwrite) {
    throw new StateError(`run already initialized: ${paths.state} (use --overwrite to replace)`);
  }

  const prd = options.prd ?? newPrd(slug);

  touchLock(paths.state_lock);
  writeJsonAtomic(paths.prd, prd);
  writeJsonAtomic(paths.plan, plan);
  writeJsonAtomic(paths.state, newState(slug, branch, plan));
  return paths;
}

function stateExists(paths: RunPaths): boolean {
  try {
    readFileSync(paths.state);
    return true;
  } catch {
    return false;
  }
}

/** Read the current state.json under the file lock. */
export function loadState(paths: RunPaths): StateData {
  touchLock(paths.state_lock);
  return readJson(paths.state) as unknown as StateData;
}

/** Write state back. Bumps `updated_at` and goes through atomic write + lock. */
export function saveState(paths: RunPaths, state: StateData): void {
  state.updated_at = utcnowIso();
  touchLock(paths.state_lock);
  writeJsonAtomic(paths.state, state);
}

/**
 * Read-modify-write helper. Mirrors Python's `mutate_state` context manager:
 * load, apply mutator, bump `updated_at`, persist atomically.
 */
function mutateState<T>(paths: RunPaths, mutator: (state: StateData) => T): T {
  touchLock(paths.state_lock);
  const state = readJson(paths.state) as unknown as StateData;
  const result = mutator(state);
  state.updated_at = utcnowIso();
  writeJsonAtomic(paths.state, state);
  return result;
}

// ---------------------------------------------------------------------------
// State-tree helpers
// ---------------------------------------------------------------------------

function findTask(state: StateData, taskId: string): TaskData {
  for (const t of state.tasks ?? []) {
    if (t.id === taskId) return t;
  }
  throw new StateError(`task not found in state: '${taskId}'`);
}

function findStep(state: StateData, stepId: string): { task: TaskData; step: StepData } {
  for (const t of state.tasks ?? []) {
    for (const s of t.steps ?? []) {
      if (s.id === stepId) return { task: t, step: s };
    }
  }
  throw new StateError(`step not found in state: '${stepId}'`);
}

/**
 * Mirror Python's `sorted(iterable)` on a `set[str]` for use in error
 * messages: ascending, lexicographic, produced as a Python-style list repr
 * (single-quoted strings inside brackets).
 */
function pythonSortedRepr(values: readonly string[]): string {
  const sorted = [...values].sort();
  const parts = sorted.map((v) => `'${v}'`);
  return `[${parts.join(', ')}]`;
}

function assertTransition(
  current: string,
  target: string,
  allowed: Record<string, readonly string[]>,
): void {
  if (current === target) return; // idempotent no-op
  const valid = allowed[current] ?? [];
  if (!valid.includes(target)) {
    throw new StateError(
      `illegal transition: '${current}' -> '${target}' ` +
        `(allowed from '${current}': ${pythonSortedRepr(valid)})`,
    );
  }
}

const STEP_TRANSITIONS: Record<string, readonly string[]> = {
  pending: ['in_progress', 'skipped'],
  in_progress: ['completed', 'failed', 'halted'],
  completed: [],
  failed: ['in_progress'],
  halted: ['in_progress'],
  skipped: [],
};

const TASK_TRANSITIONS: Record<string, readonly string[]> = {
  pending: ['in_progress'],
  in_progress: ['completed', 'failed', 'halted'],
  completed: [],
  failed: ['in_progress'],
  halted: ['in_progress'],
};

// ---------------------------------------------------------------------------
// Step-level mutations
// ---------------------------------------------------------------------------

export function stepStart(paths: RunPaths, stepId: string): StateData {
  return mutateState(paths, (state) => {
    const { task, step } = findStep(state, stepId);
    assertTransition(step.status, 'in_progress', STEP_TRANSITIONS);

    const now = utcnowIso();
    step.status = 'in_progress';
    if (!step.started_at) step.started_at = now;
    step.ended_at = '';
    step.halt_reason = '';

    if (task.status === 'pending' || task.status === 'failed' || task.status === 'halted') {
      assertTransition(task.status, 'in_progress', TASK_TRANSITIONS);
      task.status = 'in_progress';
      if (!task.started_at) task.started_at = now;
    }

    if (state.run_status === 'pending') {
      state.run_status = 'running';
      if (!state.started_at) state.started_at = now;
    }

    state.current_task = task.id;
    state.current_step = step.id;
    return deepCopy(state);
  });
}

export interface StepCompleteOptions {
  commitSha?: string;
}

export function stepComplete(
  paths: RunPaths,
  stepId: string,
  options: StepCompleteOptions = {},
): StateData {
  return mutateState(paths, (state) => {
    const { task, step } = findStep(state, stepId);
    assertTransition(step.status, 'completed', STEP_TRANSITIONS);

    const now = utcnowIso();
    step.status = 'completed';
    step.ended_at = now;
    if (options.commitSha) step.commit_sha = options.commitSha;

    maybeFinalizeTask(task);
    maybeAdvanceCurrent(state, task, step);
    maybeFinalizeRun(state);
    return deepCopy(state);
  });
}

export interface StepFailOptions {
  reason?: string;
}

export function stepFail(
  paths: RunPaths,
  stepId: string,
  options: StepFailOptions = {},
): StateData {
  return terminateStep(paths, stepId, 'failed', options.reason ?? '');
}

export function stepHalt(
  paths: RunPaths,
  stepId: string,
  options: StepFailOptions = {},
): StateData {
  return terminateStep(paths, stepId, 'halted', options.reason ?? '');
}

function terminateStep(
  paths: RunPaths,
  stepId: string,
  target: 'failed' | 'halted',
  reason: string,
): StateData {
  return mutateState(paths, (state) => {
    const { task, step } = findStep(state, stepId);
    assertTransition(step.status, target, STEP_TRANSITIONS);

    const now = utcnowIso();
    step.status = target;
    step.ended_at = now;
    if (reason) step.halt_reason = reason;

    if (target === 'failed') {
      if (task.status !== 'failed') {
        assertTransition(task.status, 'failed', TASK_TRANSITIONS);
        task.status = 'failed';
        task.ended_at = now;
      }
    } else {
      if (task.status !== 'halted') {
        assertTransition(task.status, 'halted', TASK_TRANSITIONS);
        task.status = 'halted';
        task.ended_at = now;
      }
    }

    state.run_status = target === 'halted' ? 'halted' : 'failed';
    if (!state.ended_at) state.ended_at = now;
    state.current_step = '';
    return deepCopy(state);
  });
}

/**
 * Record a validator outcome in the per-phase summary. Mirrors Python's
 * `set_validator` — the phase slot is overwritten in place (no list append),
 * matching the `validator_summary` dict semantics.
 */
export function validatorSet(
  paths: RunPaths,
  stepId: string,
  phase: string,
  status: string,
): StateData {
  if (!(VALIDATOR_PHASES as readonly string[]).includes(phase)) {
    throw new StateError(`unknown validator phase: '${phase}'`);
  }
  if (!(VALIDATOR_STATUSES as readonly string[]).includes(status)) {
    throw new StateError(`unknown validator status: '${status}'`);
  }

  return mutateState(paths, (state) => {
    const { step } = findStep(state, stepId);
    if (!step.validator_summary) {
      step.validator_summary = {
        build: 'pending',
        lint: 'pending',
        test: 'pending',
        custom: 'pending',
        llm: 'pending',
      };
    }
    (step.validator_summary as unknown as Record<string, string>)[phase] = status;
    return deepCopy(state);
  });
}

// ---------------------------------------------------------------------------
// Task-level mutations
// ---------------------------------------------------------------------------

export interface TaskReviewOptions {
  verdict: string;
  notes?: string;
  reviewer?: string;
}

const REVIEW_VERDICT_VALUES: readonly string[] = ['approved', 'rejected', 'pending', 'n/a'];

export function taskReview(paths: RunPaths, taskId: string, options: TaskReviewOptions): StateData {
  const { verdict, notes = '', reviewer = '' } = options;
  if (!REVIEW_VERDICT_VALUES.includes(verdict)) {
    throw new StateError(`invalid review verdict: '${verdict}'`);
  }

  return mutateState(paths, (state) => {
    const task = findTask(state, taskId);
    if (!task.review) {
      task.review = { verdict: 'pending', notes: '', reviewer: '', reviewed_at: '' };
    }
    task.review.verdict = verdict as ReviewVerdict;
    task.review.notes = notes;
    task.review.reviewer = reviewer;
    task.review.reviewed_at = utcnowIso();
    return deepCopy(state);
  });
}

// ---------------------------------------------------------------------------
// Dispatch ledger (reporter dedup)
// ---------------------------------------------------------------------------

/**
 * Append a dispatch entry unless `key` is already present. Returns `true`
 * when newly recorded, `false` on a dedup hit.
 */
export function dispatchRecord(paths: RunPaths, key: string, event: string): boolean {
  return mutateState(paths, (state) => {
    if (!state.dispatch) state.dispatch = { dispatched: [] };
    for (const entry of state.dispatch.dispatched ?? []) {
      if (entry.key === key) return false;
    }
    state.dispatch.dispatched.push({ key, event, timestamp: utcnowIso() });
    return true;
  });
}

export function dispatchHas(paths: RunPaths, key: string): boolean {
  const state = loadState(paths);
  for (const entry of state.dispatch?.dispatched ?? []) {
    if (entry.key === key) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Auto-advance / finalize helpers
// ---------------------------------------------------------------------------

function maybeFinalizeTask(task: TaskData): void {
  const statuses = new Set(task.steps.map((s) => s.status));
  if (statuses.size === 0) return;
  const terminal = new Set(['completed', 'skipped']);
  const allTerminal = [...statuses].every((s) => terminal.has(s));
  if (allTerminal && task.status !== 'completed') {
    assertTransition(task.status, 'completed', TASK_TRANSITIONS);
    task.status = 'completed';
    task.ended_at = utcnowIso();
  }
}

function maybeAdvanceCurrent(state: StateData, task: TaskData, step: StepData): void {
  const steps = task.steps ?? [];
  const idx = steps.findIndex((s) => s.id === step.id);
  if (idx < 0) return;

  for (let i = idx + 1; i < steps.length; i++) {
    const next = steps[i];
    if (next && next.status === 'pending') {
      state.current_step = next.id;
      return;
    }
  }

  for (const t of state.tasks ?? []) {
    if (t.status === 'pending') {
      for (const s of t.steps ?? []) {
        if (s.status === 'pending') {
          state.current_task = t.id;
          state.current_step = s.id;
          return;
        }
      }
    }
  }

  state.current_step = '';
}

function maybeFinalizeRun(state: StateData): void {
  const statuses = new Set(state.tasks.map((t) => t.status));
  if (statuses.size === 0) return;
  const terminal = new Set(['completed', 'skipped']);
  const allTerminal = [...statuses].every((s) => terminal.has(s));
  if (allTerminal) {
    state.run_status = 'completed';
    if (!state.ended_at) state.ended_at = utcnowIso();
    state.current_task = '';
    state.current_step = '';
  }
}

// ---------------------------------------------------------------------------
// Report I/O
// ---------------------------------------------------------------------------

/**
 * Persist a per-step report under `reports/<step_id>.json`. Dots in step
 * ids are normalized to underscores for clarity. Write-once semantics:
 * existing reports are NOT overwritten — callers must delete before rewrite.
 *
 * Returns the target path.
 */
export function reportWrite(paths: RunPaths, report: ReportData): string {
  const stepId = report.step_id;
  if (!stepId) throw new StateError("report is missing 'step_id'");
  mkdirSync(paths.reports_dir, { recursive: true });
  const filename = `${stepId.replace(/\./g, '_')}.json`;
  const target = `${paths.reports_dir}/${filename}`;
  writeJsonAtomic(target, report);
  return target;
}

export function reportRead(paths: RunPaths, stepId: string): ReportData | null {
  const filename = `${stepId.replace(/\./g, '_')}.json`;
  const target = `${paths.reports_dir}/${filename}`;
  try {
    return readJson(target) as unknown as ReportData;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Reconciliation (hook-driven enforcement)
// ---------------------------------------------------------------------------

export function findInprogressSteps(state: StateData): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const task of state.tasks ?? []) {
    for (const step of task.steps ?? []) {
      if (step.status === 'in_progress') out.push([task.id, step.id]);
    }
  }
  return out;
}

export interface ReconcileOptions {
  worktreeLatestCommit?: string;
  scopeStepIds?: Set<string> | string[];
  reasonOnHalt?: string;
}

/**
 * Fix up lingering in_progress steps.
 *
 * For each in_progress step (optionally filtered by `scopeStepIds`):
 * - if `worktreeLatestCommit` is supplied, auto-complete the step with
 *   that SHA;
 * - otherwise, halt the step with `reasonOnHalt`.
 *
 * Returns a list of `{ step_id, action, detail }` records. Idempotent —
 * completed/failed/halted steps are ignored.
 */
export function reconcile(paths: RunPaths, options: ReconcileOptions = {}): ReconcileChange[] {
  const reasonOnHalt =
    options.reasonOnHalt ?? 'no completion recorded before session/subagent ended';
  const scope = options.scopeStepIds
    ? new Set(Array.isArray(options.scopeStepIds) ? options.scopeStepIds : options.scopeStepIds)
    : null;

  const changes: ReconcileChange[] = [];
  mutateState(paths, (state) => {
    const targets = findInprogressSteps(state);
    for (const [taskId, stepId] of targets) {
      if (scope !== null && !scope.has(stepId)) continue;
      const task = findTask(state, taskId);
      const { step } = findStep(state, stepId);
      const now = utcnowIso();

      if (options.worktreeLatestCommit) {
        step.status = 'completed';
        step.ended_at = now;
        step.commit_sha = options.worktreeLatestCommit;
        changes.push({
          step_id: stepId,
          action: 'completed',
          detail: `auto-completed from latest worktree commit ${options.worktreeLatestCommit.slice(0, 12)}`,
        });
        maybeFinalizeTask(task);
      } else {
        step.status = 'halted';
        step.ended_at = now;
        step.halt_reason = reasonOnHalt;
        if (task.status !== 'halted') {
          assertTransition(task.status, 'halted', TASK_TRANSITIONS);
          task.status = 'halted';
          task.ended_at = now;
        }
        state.run_status = 'halted';
        if (!state.ended_at) state.ended_at = now;
        changes.push({ step_id: stepId, action: 'halted', detail: reasonOnHalt });
      }
    }
    maybeFinalizeRun(state);
  });
  return changes;
}
