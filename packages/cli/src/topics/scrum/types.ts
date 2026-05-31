/**
 * Scrum domain types. One row-type per `scrum_*` table plus the enum
 * string-literal unions pinned to SQL CHECK constraints.
 *
 * All row types mirror the on-disk column names (snake_case) one-to-one so
 * SELECT results can be cast directly. The `ScrumStore` class is
 * responsible for any camelCase translation at its public surface.
 */

// ---------------------------------------------------------------------------
// Enum string-literal unions
// ---------------------------------------------------------------------------

/** Task lifecycle. Matches `scrum_tasks.status` column values. */
export type TaskStatus =
  | 'backlog'
  | 'ready'
  | 'in_progress'
  | 'review'
  | 'blocked'
  | 'done'
  | 'cancelled';

/** Milestone lifecycle. Matches `scrum_milestones.status` column values. */
export type MilestoneStatus = 'planned' | 'active' | 'closed';

/**
 * Optional containment tier for a task (audit §3.4). Matches
 * `scrum_tasks.layer`; NULL on the column means flat/untiered. The column
 * has no CHECK constraint, so this union documents the canonical set
 * without pinning the schema.
 */
export type TaskLayer = 'epic' | 'story' | 'task';

/**
 * Canonical set of event kinds appended to `scrum_events.kind`. New kinds
 * extend this union — the column itself has no CHECK constraint so older
 * databases stay forward-compatible.
 */
export type EventKind =
  | 'task_created'
  | 'status_changed'
  | 'milestone_changed'
  | 'run_started'
  | 'run_completed'
  | 'steward_verdict'
  | 'decision_linked'
  | 'blocker_raised'
  | 'note'
  | 'unlinked_run_detected';

/**
 * Dependency direction. Pinned by a CHECK constraint on `scrum_deps.kind`;
 * the migration rejects any other value at insert time.
 */
export type DepKind = 'blocks' | 'blocked_by';

// ---------------------------------------------------------------------------
// Acceptance criteria (v5, audit §5.2)
// ---------------------------------------------------------------------------

/**
 * How a single acceptance criterion is verified (audit §5.2). The four kinds
 * map onto existing prove machinery at story-close time (NOT this task — see
 * the `// TODO(story-close):` seam in store.ts):
 *
 *   bash   — `check` is a shell command; pass = exit 0 (→ a `validator`)
 *   assert — `check` is a boolean expression evaluated against run context
 *   gate   — `check` is a prompt shown to the operator via `AskUserQuestion`
 *   agent  — `check` is a prompt judged by the `validation-agent`
 *
 * Closed vocabulary documented here, not pinned by a SQL CHECK — the value
 * lives inside `acceptance_json`, so the schema stays forward-compatible.
 */
export type AcceptanceVerifiesBy = 'bash' | 'assert' | 'gate' | 'agent';

/** Lifecycle of a single criterion. Append-only: retire via supersession. */
export type AcceptanceCriterionStatus = 'active' | 'superseded';

/**
 * One acceptance criterion on a task (audit §5.2). Criteria are append-only:
 * a retired criterion flips `status` to `'superseded'` with a `reason` (and
 * optional `superseded_by` pointer) rather than being removed — mirrors the
 * v4 `scrum_decisions` supersession discipline.
 *
 *   idempotent     — safe to re-run without side effects; required true for
 *                    `parallel` eval_order or `failed_only` rerun_policy.
 *   timeout        — optional wall-clock budget (e.g. `'30s'`); story-close
 *                    interprets it. Free-form string, not validated here.
 *   inherited_from — set when copied from a parent task's `shared_acceptance`
 *                    (the parent task id); null on locally-authored criteria.
 *                    Copies are independent — editing the parent does not
 *                    retroactively change an existing child copy.
 */
export interface AcceptanceCriterion {
  id: string;
  text: string;
  verifies_by: AcceptanceVerifiesBy;
  /** Kind-specific check payload (command / expression / prompt). */
  check: string;
  status: AcceptanceCriterionStatus;
  idempotent: boolean;
  timeout?: string;
  /** Set on supersession to the replacement criterion id. NULL = current. */
  superseded_by?: string | null;
  /** Rationale recorded at supersession time. NULL until superseded. */
  reason?: string | null;
  /** Parent task id when copied via shared_acceptance inheritance. */
  inherited_from?: string | null;
}

/**
 * Evaluation policy for a task's criteria (audit §5.2). `parallel`/`failed_only`
 * are gated on every criterion being `idempotent: true` — enforced by
 * `ScrumStore.setAcceptance`/`addCriterion`.
 *
 *   eval_order    — `fifo` (run in array order) | `parallel` (run concurrently)
 *   rerun_policy  — `all` (re-run every criterion) | `failed_only`
 */
export interface AcceptancePolicy {
  eval_order: 'fifo' | 'parallel';
  rerun_policy: 'all' | 'failed_only';
}

/**
 * Decoded `scrum_tasks.acceptance_json`. NULL column → `null` on
 * `ScrumTask.acceptance`. `policy` is optional; absent = default
 * sequential, re-run-all behavior at story-close time.
 */
export interface Acceptance {
  criteria: AcceptanceCriterion[];
  policy?: AcceptancePolicy;
}

// ---------------------------------------------------------------------------
// Row types — one per scrum_* table
// ---------------------------------------------------------------------------

export interface ScrumTask {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  milestone_id: string | null;
  /** Self-FK to the containing task (the epic→story→task tree). NULL = flat. */
  parent_id: string | null;
  /** Containment tier. NULL = untiered/flat task. */
  layer: TaskLayer | null;
  /**
   * Decoded from `scrum_tasks.acceptance_json` at the row boundary (v5).
   * NULL = no authored acceptance. Criteria are append-only (supersede,
   * never remove).
   */
  acceptance: Acceptance | null;
  created_by_agent: string | null;
  created_at: string;
  last_event_at: string | null;
  deleted_at: string | null;
}

export interface ScrumMilestone {
  id: string;
  title: string;
  description: string | null;
  target_state: string | null;
  status: MilestoneStatus;
  created_at: string;
  closed_at: string | null;
}

export interface ScrumTag {
  task_id: string;
  tag: string;
  added_at: string;
}

export interface ScrumDep {
  from_task_id: string;
  to_task_id: string;
  kind: DepKind;
}

export interface ScrumEvent {
  id: number;
  task_id: string;
  ts: string;
  kind: EventKind;
  agent: string | null;
  /** JSON-decoded payload; callers parse from `payload_json` at the SQL boundary. */
  payload: unknown;
}

export interface ScrumRunLink {
  task_id: string;
  run_path: string;
  branch: string | null;
  slug: string | null;
  linked_at: string;
}

export interface ScrumContextBundle {
  task_id: string;
  rebuilt_at: string;
  /** JSON-decoded bundle; callers parse from `bundle_json` at the SQL boundary. */
  bundle: unknown;
}

/**
 * One row of the `scrum_decisions` table. `id` is the filename slug
 * (e.g., `2026-04-24-decision-persistence`). `content_sha` is the
 * hex-encoded sha256 of `content`, computed at write time so drift
 * detection never needs to re-read the working-tree file. `source_path`
 * is nullable because git-recovered rows may lack a working-tree file.
 *
 * `status` defaults to `'accepted'` per ADR convention; the column is
 * `TEXT` (not a typed enum) so downstream domains can extend the
 * vocabulary without a schema migration. The canonical closed vocabulary
 * is `accepted | superseded | deprecated` (audit §5.3) — kept as TEXT, not
 * a CHECK constraint, to preserve the forward-compatible convention above.
 *
 * Supersession is append-only (audit §5.3 / design-principles §4): a
 * retired decision is never hard-deleted. Instead its `status` flips to
 * `'superseded'`, `superseded_by` points at the replacement's `id`, and
 * `reason` records why. Both are NULL on current (non-retired) decisions.
 */
export interface DecisionRow {
  id: string;
  title: string;
  topic: string | null;
  status: string;
  content: string;
  source_path: string | null;
  content_sha: string;
  /** ISO-8601 timestamp. */
  recorded_at: string;
  recorded_by_agent: string | null;
  /** Self-FK to the replacement decision's `id`. NULL = current/not retired. */
  superseded_by: string | null;
  /** Rationale recorded at supersession time. NULL until superseded. */
  reason: string | null;
}

// ---------------------------------------------------------------------------
// Derived views
// ---------------------------------------------------------------------------

/**
 * Result row for `ScrumStore.nextReady`. Exposes the task, the composite
 * priority score, and the breakdown so callers can render "why is this task
 * next" without recomputing.
 *
 * Score formula (matches store.ts):
 *   unblock_depth * 10 + milestone_boost * 5 + context_hotness * 3 + tag_boost
 */
export interface NextReadyRow {
  task: ScrumTask;
  score: number;
  rationale: {
    unblock_depth: number;
    milestone_boost: number;
    context_hotness: number;
    tag_boost: number;
  };
}
