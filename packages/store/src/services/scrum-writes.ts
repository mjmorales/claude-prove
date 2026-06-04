/**
 * Scrum transition write-service — the single owner of the task
 * status-transition write in the `@claude-prove/store` package.
 *
 * `updateTaskStatus(store, id, next, agent?)` validates the transition against
 * the closed `ALLOWED_TRANSITIONS` table, enforces the two story-layer
 * mechanical floors (acceptance-criteria presence/satisfaction and
 * synthesis-entry presence), then performs the single in-transaction
 * `UPDATE scrum_tasks` + `INSERT INTO scrum_events` (kind `status_changed`,
 * payload `{from,to}`) — bumping `last_event_at` and stamping the row's
 * last-touch + executing-worker/run provenance.
 *
 * Event-log emission for a status transition lives EXACTLY ONCE — here. The
 * service operates on a raw `Store` handle and assumes the scrum domain tables
 * already exist (the caller migrates the store); it never registers schema and
 * never opens a store of its own.
 *
 * The scrum domain types (status enum, task row shape, acceptance criteria)
 * are declared here as the canonical store-package copy rather than imported
 * from `@claude-prove/cli` — the dependency runs store ← cli, never the
 * inverse.
 */

import type { Database } from 'bun:sqlite';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import type { Store } from '../connection';

// ---------------------------------------------------------------------------
// Closed scrum status enum + task / acceptance domain types (canonical copy)
// ---------------------------------------------------------------------------

/** Task lifecycle status. Matches `scrum_tasks.status` column values. */
export type TaskStatus =
  | 'backlog'
  | 'proposed'
  | 'accepted'
  | 'ready'
  | 'in_progress'
  | 'review'
  | 'blocked'
  | 'done'
  | 'cancelled';

/** Containment tier for a task. NULL on the column = flat/untiered. */
export type TaskLayer = 'epic' | 'story' | 'task';

/** Copy-down/applicability scope of an acceptance criterion. */
export type AcceptanceScope = 'descendants' | 'self' | 'both';

/** Verification channel a criterion is decided through. */
export type AcceptanceVerifiesBy = 'bash' | 'assert' | 'gate' | 'agent';

/** Criterion lifecycle: `superseded` retires it (append-only). */
export type AcceptanceCriterionStatus = 'active' | 'superseded';

/** Persisted human verdict of a `gate`-kind criterion. */
export type GateVerdict = 'gate_pending' | 'approved' | 'rejected';

/** Recorded verdict of a heavy (`bash`/`assert`/`agent`) criterion. */
export type VerificationVerdict = 'pending' | 'verified' | 'failed';

/** Persisted decision state carried inside a `gate`-kind criterion. */
export interface GateState {
  verdict: GateVerdict;
  responder?: string | null;
  comment?: string | null;
  responded_at?: string | null;
}

/** Recorded verification state stamped by the orchestrator validation gate. */
export interface VerificationRecord {
  verdict: VerificationVerdict;
  reason?: string | null;
  verified_by?: string | null;
  verified_at?: string | null;
}

/** One acceptance criterion on a task. Append-only (supersede, never remove). */
export interface AcceptanceCriterion {
  id: string;
  text: string;
  verifies_by: AcceptanceVerifiesBy;
  check: string;
  status: AcceptanceCriterionStatus;
  idempotent: boolean;
  scope?: AcceptanceScope;
  timeout?: string;
  gate?: GateState;
  verification?: VerificationRecord;
  superseded_by?: string | null;
  reason?: string | null;
  inherited_from?: string | null;
}

/** Evaluation policy for a task's criteria. */
export interface AcceptancePolicy {
  eval_order: 'fifo' | 'parallel';
  rerun_policy: 'all' | 'failed_only';
}

/** Decoded `scrum_tasks.acceptance_json`. */
export interface Acceptance {
  criteria: AcceptanceCriterion[];
  policy?: AcceptancePolicy;
}

/**
 * The decoded task shape the transition write reads and returns. Mirrors the
 * `scrum_tasks` columns this service touches plus the JSON-decoded
 * `acceptance`. Columns the transition never reads (bounds, terminal_*, the
 * derived provenance block) are intentionally omitted — the service is the
 * narrow transition surface, not the full task CRUD.
 */
export interface TransitionTask {
  id: string;
  status: TaskStatus;
  layer: TaskLayer | null;
  acceptance: Acceptance | null;
}

// ---------------------------------------------------------------------------
// Allowed status transitions — rejected at runtime by updateTaskStatus
// ---------------------------------------------------------------------------

/**
 * Allowed forward transitions. Terminal statuses (`done`, `cancelled`) reject
 * every outgoing edge. The decomposition-review states `proposed`/`accepted`
 * slot ahead of `ready`: `backlog → proposed` (decomposed) → `accepted`
 * (review passed — the gate that fires next-layer decompose) → `ready`.
 * `proposed → backlog` is the review-kickback edge. The direct
 * `backlog → ready|in_progress` edges remain for tasks that need no review.
 */
const ALLOWED_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  backlog: ['proposed', 'ready', 'in_progress', 'cancelled'],
  proposed: ['accepted', 'backlog', 'cancelled'],
  accepted: ['ready', 'in_progress', 'backlog', 'cancelled'],
  ready: ['in_progress', 'blocked', 'cancelled', 'backlog'],
  in_progress: ['review', 'blocked', 'done', 'cancelled', 'ready'],
  review: ['in_progress', 'done', 'cancelled'],
  blocked: ['ready', 'in_progress', 'cancelled'],
  done: [],
  cancelled: [],
};

// ---------------------------------------------------------------------------
// Public write — the single owner of the status_changed event emission
// ---------------------------------------------------------------------------

/**
 * Update a task's status. Rejects invalid transitions (see
 * `ALLOWED_TRANSITIONS`) and unknown task ids. Enforces the two story-layer
 * floors, then appends a `status_changed` event inside the same transaction as
 * the row update and bumps `last_event_at`. Returns the post-write task view.
 */
export function updateTaskStatus(
  store: Store,
  id: string,
  next: TaskStatus,
  agent?: string | null,
): TransitionTask {
  const db = store.getDb();
  const task = getTransitionTask(db, id);
  if (!task) throw new Error(`updateTaskStatus: unknown task '${id}'`);
  const allowed = ALLOWED_TRANSITIONS[task.status];
  if (!allowed.includes(next)) {
    throw new Error(
      `updateTaskStatus: invalid transition '${task.status}' -> '${next}' for task '${id}'`,
    );
  }

  // Story-layer transition floors. Both are mechanical engine-owned gates:
  // a `layer=story` task carries obligations a flat `layer=task` does not.
  // Non-story layers pass straight through.
  if (task.layer === 'story') {
    assertStoryAcceptanceFloor(task, next);
    if (next === 'done') assertStorySynthesisFloor(store, db, id);
  }

  const ts = isoNow();
  const { workerId, runId } = resolveRunContext();
  const tx = db.transaction(() => {
    db.prepare(
      'UPDATE scrum_tasks SET status = ?, last_event_at = ?, last_modified_by = ?, last_modified_at = ?, worker_id = ?, run_id = ? WHERE id = ?',
    ).run(next, ts, agent ?? null, ts, workerId, runId, id);
    db.prepare(
      'INSERT INTO scrum_events (task_id, ts, kind, agent, payload_json) VALUES (?, ?, ?, ?, ?)',
    ).run(id, ts, 'status_changed', agent ?? null, JSON.stringify({ from: task.status, to: next }));
  });
  tx();

  const updated = getTransitionTask(db, id);
  if (!updated) throw new Error(`updateTaskStatus: task '${id}' vanished mid-update`);
  return updated;
}

// ---------------------------------------------------------------------------
// Story-layer transition floors
// ---------------------------------------------------------------------------

/**
 * Reject a `layer=story` transition INTO `ready`/`in_progress`/`done` when the
 * story has zero APPLICABLE active acceptance criteria, and additionally reject
 * `→ done` when any applicable criterion is unsatisfied. A story with no
 * goalposts cannot be started or closed; superseded criteria do not count.
 * Other target statuses (`blocked`, `review`, `cancelled`, `backlog`) pass — a
 * story may be parked or abandoned without criteria. Invariant: only called for
 * `task.layer === 'story'`.
 *
 * Applicability honors `scope`: only criteria that apply to the story itself
 * (`self`/`both`/absent) gate it; a `descendants`-scoped criterion is the
 * subtree's goalpost, not the parent's, so it never blocks the parent.
 *
 * The `→ done` satisfaction gate is split by cost (a store-level floor cannot
 * run a git worktree, nor does it hold the run/plan context an assert needs):
 *   - `gate` is decided HERE via the persisted human verdict
 *     (`criterionSatisfied`) — context-free standing state.
 *   - `assert`/`bash`/`agent` are decided at the orchestrator validation gate
 *     and RECORDED onto the criterion's `verification`; this floor READS that
 *     record. An unsatisfied (`failed`) or never-recorded (`pending`/absent)
 *     verdict blocks the close.
 */
function assertStoryAcceptanceFloor(task: TransitionTask, next: TaskStatus): void {
  if (next !== 'ready' && next !== 'in_progress' && next !== 'done') return;
  const active = task.acceptance?.criteria.filter((c) => c.status === 'active') ?? [];
  const applicable = active.filter((c) => appliesToSelf(c.scope));
  if (applicable.length === 0) {
    throw new Error(
      `updateTaskStatus: story '${task.id}' has no active acceptance criteria; add at least one (\`scrum task acceptance add ${task.id} ...\`) before '${next}'`,
    );
  }
  if (next !== 'done') return;

  const unsatisfied = applicable.filter((c) => !criterionSatisfiedAtFloor(c));
  if (unsatisfied.length > 0) {
    const detail = unsatisfied.map((c) => `${c.id} (${c.verifies_by})`).join(', ');
    throw new Error(
      `updateTaskStatus: story '${task.id}' cannot close — unsatisfied acceptance criteria: ${detail}. Approve gate criteria (\`scrum gate respond\`) and record assert/bash/agent verdicts (\`scrum task acceptance verify ${task.id} --verdict verified|failed [--criterion ID]\`, or inline at the orchestrator validation gate) before '${next}'.`,
    );
  }
}

/**
 * Reject a `layer=story` -> `done` transition when the story's most-recent
 * linked run carries no `synthesis` reasoning-log entry. The synthesis entry is
 * the worker's hand-off-of-record; closing a story without it loses the
 * episode's outcome.
 *
 * Boundary: the floor applies only once a worker has run — a story with NO
 * linked runs has no episode to synthesize and passes. The orchestrator always
 * links a run before dispatch, so the only way to reach `done` with no run is a
 * manually-driven story, which the floor intentionally does not gate.
 * Invariant: only called for `task.layer === 'story'`.
 */
function assertStorySynthesisFloor(store: Store, db: Database, taskId: string): void {
  const runs = listRunsForTask(db, taskId);
  if (runs.length === 0) return;

  // listRunsForTask is ordered by linked_at ASC — the last entry is the
  // most-recent worker.
  const latest = runs[runs.length - 1];
  if (!latest) return;
  const runDir = resolveRunDir(store, latest.run_path);

  let hasSynthesis = false;
  try {
    hasSynthesis = hasSynthesisEntry(runDir);
  } catch {
    // A malformed entry file makes the synthesis status unknowable; treat as
    // absent so the floor fails closed rather than waving the story through.
    hasSynthesis = false;
  }

  if (!hasSynthesis) {
    throw new Error(
      `updateTaskStatus: story '${taskId}' cannot close — its most-recent run (${latest.run_path}) has no synthesis reasoning-log entry. The worker must write one before the story reaches 'done'.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Reads — task decode, run links, run-dir resolution, synthesis presence
// ---------------------------------------------------------------------------

/** Raw `scrum_tasks` projection the transition write reads. */
interface TransitionTaskRow {
  id: string;
  status: TaskStatus;
  layer: TaskLayer | null;
  acceptance_json: string | null;
}

/**
 * Fetch the transition-relevant projection of a live task, decoding
 * `acceptance_json`, or null if the row is missing or soft-deleted. A corrupt
 * `acceptance_json` degrades to `null` (with a stderr warning) rather than
 * throwing, so one poisoned row cannot brick the transition read.
 */
function getTransitionTask(db: Database, id: string): TransitionTask | null {
  const row = db
    .prepare(
      'SELECT id, status, layer, acceptance_json FROM scrum_tasks WHERE id = ? AND deleted_at IS NULL',
    )
    .get(id) as TransitionTaskRow | null;
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    layer: row.layer,
    acceptance: safeParseAcceptance(row.acceptance_json, row.id),
  };
}

function safeParseAcceptance(raw: string | null, taskId: string): Acceptance | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as Acceptance;
  } catch {
    process.stderr.write(`scrum: task '${taskId}' has corrupt acceptance_json; treating as null\n`);
    return null;
  }
}

/** Run links for `taskId`, ordered by `linked_at` ASC (oldest first). */
function listRunsForTask(db: Database, taskId: string): { run_path: string }[] {
  return db
    .prepare('SELECT run_path FROM scrum_run_links WHERE task_id = ? ORDER BY linked_at ASC')
    .all(taskId) as { run_path: string }[];
}

/**
 * Resolve a stored `run_path` to an absolute run directory for reasoning-log
 * reads. Absolute paths pass through; relative paths resolve against the
 * workspace root derived from the store's db path (`<root>/.prove/prove.db`). A
 * `:memory:` store has no root, so relative paths resolve against cwd — tests
 * linking real run dirs use absolute paths.
 */
function resolveRunDir(store: Store, runPath: string): string {
  if (isAbsolute(runPath)) return runPath;
  const dbPath = store.path;
  const root = dbPath === ':memory:' ? process.cwd() : dirname(dirname(dbPath));
  return join(root, runPath);
}

/** The per-run reasoning-log subdirectory: `<runDir>/log`. */
const LOG_DIRNAME = 'log';

/**
 * Whether any reasoning-log entry under `<runDir>/log/<agent>/*.json` is a
 * `synthesis` entry. The on-disk layout is one JSON file per entry under a
 * per-agent subdirectory. A missing log dir => no synthesis. A file whose JSON
 * does not parse throws (the caller fails closed). This is the narrow read the
 * synthesis floor needs — not the full strict entry validator.
 */
function hasSynthesisEntry(runDir: string): boolean {
  const root = join(runDir, LOG_DIRNAME);
  if (!existsSync(root)) return false;

  for (const agentDir of readdirSync(root).sort()) {
    const dir = join(root, agentDir);
    if (!statSync(dir).isDirectory()) continue;
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith('.json')) continue;
      const raw = readFileSync(join(dir, name), 'utf8');
      const parsed = JSON.parse(raw) as { type?: unknown };
      if (parsed.type === 'synthesis') return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Criterion satisfaction (store-vantage) + scope applicability
// ---------------------------------------------------------------------------

/**
 * Whether a criterion is a goalpost on the task it is authored on. `self` and
 * `both` apply to the task itself; `descendants` does NOT. An absent scope
 * defaults to `both`, so pre-scope criteria stay goalposts on their own task.
 */
function appliesToSelf(scope: AcceptanceScope | undefined): boolean {
  return scope === undefined || scope === 'self' || scope === 'both';
}

/**
 * Whether a single criterion counts as satisfied from the store's mechanical
 * vantage. Only `gate`-kind is decided here: an `approved` verdict satisfies,
 * `gate_pending`/`rejected` do not. The other three kinds are decided by their
 * downstream channels, so this returns false for them.
 */
function criterionSatisfied(criterion: AcceptanceCriterion): boolean {
  if (criterion.verifies_by !== 'gate') return false;
  return (criterion.gate?.verdict ?? 'gate_pending') === 'approved';
}

/**
 * Whether a criterion counts as satisfied from the story-CLOSE-floor vantage.
 * The floor has no git and no run/plan context, so it splits by cost:
 *   - `gate` is decided directly via the persisted human verdict.
 *   - `assert`/`bash`/`agent` are decided upstream at the orchestrator
 *     validation gate, which RECORDS the outcome onto `verification`; the floor
 *     reads `verification.verdict === 'verified'`. An absent or non-`verified`
 *     record (`pending`/`failed`) is NOT satisfied.
 */
function criterionSatisfiedAtFloor(criterion: AcceptanceCriterion): boolean {
  if (criterion.verifies_by === 'gate') return criterionSatisfied(criterion);
  return criterion.verification?.verdict === 'verified';
}

// ---------------------------------------------------------------------------
// Provenance stamping helpers
// ---------------------------------------------------------------------------

function isoNow(): string {
  return new Date().toISOString();
}

/**
 * The executing-worker/run context for a row write. The orchestrator exports
 * these in the dispatch env so a leaf worker's writes carry attribution without
 * threading the ids through every call site; a bare CLI edit outside a run
 * leaves both NULL. Empty-string env values normalize to NULL.
 */
function resolveRunContext(): { workerId: string | null; runId: string | null } {
  const workerId = process.env.PROVE_WORKER_ID ?? null;
  const runId = process.env.PROVE_RUN_SLUG ?? null;
  return {
    workerId: workerId && workerId.length > 0 ? workerId : null,
    runId: runId && runId.length > 0 ? runId : null,
  };
}
