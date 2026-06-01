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
 * Optional containment tier for a task. Matches
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
  | 'task_deleted'
  | 'milestone_changed'
  | 'run_started'
  | 'run_completed'
  | 'steward_verdict'
  | 'decision_linked'
  | 'blocker_raised'
  | 'note'
  | 'unlinked_run_detected'
  | 'curation_proposed';

/**
 * Dependency direction. Pinned by a CHECK constraint on `scrum_deps.kind`;
 * the migration rejects any other value at insert time.
 */
export type DepKind = 'blocks' | 'blocked_by';

// ---------------------------------------------------------------------------
// Structured escalation typing
// ---------------------------------------------------------------------------

/**
 * Closed taxonomy for how a worker subagent escalates back to the driver.
 * Rides inside a `blocker_raised` scrum event's payload —
 * no new column, no migration (the event `kind`/`payload_json` are already
 * free-form). claude-prove stays human-in-the-loop: the type enriches the
 * agent→driver report so the driver routes it; there is NO agent-to-agent
 * autonomy.
 *
 *   blocked         — a hard dependency the worker cannot satisfy itself
 *   ambiguous       — the spec/criteria admit multiple defensible readings
 *   conflict        — two requirements/constraints contradict
 *   missing_context — needed information is absent and unreachable from the run
 */
export type EscalationType = 'blocked' | 'ambiguous' | 'conflict' | 'missing_context';

/** Runtime-checkable list of the closed `EscalationType` set. */
export const ESCALATION_TYPES: EscalationType[] = [
  'blocked',
  'ambiguous',
  'conflict',
  'missing_context',
];

/**
 * Typed payload carried by a `blocker_raised` event. `summary` is the
 * attention-bearing prose the driver reads; `blocking_task_id` optionally
 * names the dependency that triggered a `blocked` escalation.
 */
export interface EscalationPayload {
  escalation_type: EscalationType;
  summary: string;
  blocking_task_id?: string | null;
}

// ---------------------------------------------------------------------------
// Acceptance criteria (v5)
// ---------------------------------------------------------------------------

/**
 * How a single acceptance criterion is verified. The four kinds
 * map onto existing prove machinery at story-close time (not evaluated in
 * this module — only authored here):
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
 * One acceptance criterion on a task. Criteria are append-only:
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
 * Evaluation policy for a task's criteria. `parallel`/`failed_only`
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
// Declared bounds (v6)
// ---------------------------------------------------------------------------

/**
 * Tool allow/deny patterns inside `TaskBounds`. These map onto NATIVE
 * `settings.local.json` permission rules — `allow[]` merges into
 * `permissions.allow`, `deny[]` into `permissions.deny` — when
 * `prep-permissions` reads the forwarded plan-task bounds. Patterns are the
 * native form, e.g. `'Bash(go test *)'`.
 */
export interface TaskBoundsTools {
  allow?: string[];
  deny?: string[];
}

/**
 * Soft resource ceilings inside `TaskBounds`. ADVISORY ONLY — claude-prove
 * has no enforcement daemon; `prep-permissions` renders these into the task
 * prompt as guidance and nothing blocks on them (the native subagent timeout
 * is the only hard floor).
 */
export interface TaskBoundsBudgets {
  tokens?: number;
  tool_calls?: number;
  wall_clock_s?: number;
}

/**
 * Decoded `scrum_tasks.bounds_json` (v6). The OPTIONAL milestone-authored
 * declared bounds for a task; absent column → `null` on `ScrumTask.bounds`.
 * Mirrors the run-state v3 plan-side `TASK_PLAN_SPEC.bounds` shape so
 * `compile-plan` can forward it verbatim into `plan.tasks[].bounds`.
 *
 * Enforcement split:
 *   read    — advisory; rendered into the task prompt (no native read-deny).
 *   write   — advisory; the git worktree is the write wall. Native permission
 *             deny rules match a set, not its complement, so there is NO
 *             `Edit(!glob)`/`Write(!glob)` "writable only inside X" rule.
 *   tools   — the only NATIVE surface; allow/deny merge into permissions.
 *   budgets — ADVISORY ONLY; soft ceilings rendered into the prompt.
 *
 * All fields optional; absent = unbounded. The closed
 * top-level key set (`read | write | tools | budgets`) is enforced on write
 * by `validateBounds` in `store.ts`.
 */
export interface TaskBounds {
  read?: string[];
  write?: string[];
  tools?: TaskBoundsTools;
  budgets?: TaskBoundsBudgets;
}

// ---------------------------------------------------------------------------
// Row types — one per scrum_* table
// ---------------------------------------------------------------------------

/**
 * Reusable per-artifact provenance block — the standing attribution shape every
 * scrum row carries. Assembled once at the row boundary (see `taskProvenance`
 * in `store.ts`) from the row's stored columns plus the domain schema version,
 * rather than re-declaring the same five fields ad hoc per consumer.
 *
 *   created_by       — agent that authored the artifact; never overwritten.
 *   created_at       — ISO-8601 creation timestamp.
 *   last_modified_by — agent of the most recent row mutation, or NULL when the
 *                      mutation carried no agent.
 *   last_modified_at — ISO-8601 timestamp of the most recent row write.
 *   worker_id        — executing unit (leaf worker / driver) of the last write,
 *                      or NULL when no worker context was in scope.
 *   run_id           — orchestrator run slug the last write happened under, or
 *                      NULL when no run context was in scope.
 *   schema_version   — the domain store version the artifact was read under.
 */
export interface Provenance {
  created_by: string | null;
  created_at: string;
  last_modified_by: string | null;
  last_modified_at: string | null;
  worker_id: string | null;
  run_id: string | null;
  schema_version: number;
}

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
  /**
   * Decoded from `scrum_tasks.bounds_json` at the row boundary (v6). NULL =
   * no authored bounds (unbounded). The optional milestone-authored source
   * that `compile-plan` forwards into the plan's `tasks[].bounds`.
   */
  bounds: TaskBounds | null;
  /**
   * Coarse cause a task reached a terminal status (v7).
   * Closed vocabulary: `'cancelled'` (direct `task cancel`) | `'parent_cancelled'`
   * (swept by a `--cascade` walk). NULL on live tasks and on `done` (success
   * carries no reason). TEXT column — forward-compatible, not pinned by CHECK.
   */
  terminal_reason: string | null;
  /** Free-text elaboration recorded at cancel time. NULL when none given. */
  terminal_detail: string | null;
  created_by_agent: string | null;
  created_at: string;
  last_event_at: string | null;
  /**
   * Provenance of the most recent row mutation (v9). `last_modified_at` is
   * stamped on every task-row write (status / milestone / acceptance / bounds /
   * cancel / soft-delete); `last_modified_by` carries the mutating agent where
   * the store method receives one (status / milestone / cancel), else NULL.
   * Seeded to (`created_by_agent`, `created_at`) at creation. Distinct from
   * `last_event_at` (bumped on any event append) and `created_by_agent` (the
   * creator, never overwritten). Pairs with `worker_id`/`run_id` for the full
   * executing attribution; together they form the reusable `Provenance` block.
   */
  last_modified_by: string | null;
  last_modified_at: string | null;
  /**
   * Executing-worker/run attribution of the most recent row write (v11).
   * `worker_id` is the opaque executing unit (leaf worker / driver session);
   * `run_id` is the orchestrator run slug the write happened under. Both NULL
   * when no run context was in scope (a bare CLI edit) or on every legacy row.
   * Stamped from the run env at write time. The agent + timestamp half of the
   * attribution lives in `last_modified_by`/`_at`.
   */
  worker_id: string | null;
  run_id: string | null;
  deleted_at: string | null;
  /**
   * Reusable per-artifact provenance block, assembled at the row boundary by
   * `decodeTask` from the stored columns plus the domain schema version. A
   * read-only convenience view (`created_by`, `created_at`, `last_modified_by`,
   * `last_modified_at`, `worker_id`, `run_id`, `schema_version`) — the
   * authoritative values stay on the snake_case columns above.
   */
  provenance: Provenance;
}

export interface ScrumMilestone {
  id: string;
  title: string;
  description: string | null;
  target_state: string | null;
  status: MilestoneStatus;
  /**
   * Optional initiative grouping (v10): a free-text label tying several
   * milestones to one outcome bet — the tier above milestone. NULL = the
   * milestone belongs to no initiative (the flat default). TEXT column with no
   * CHECK; `milestone list --initiative <x>` filters case-insensitively.
   */
  initiative: string | null;
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
 * (e.g., `decision-persistence`). `content_sha` is the
 * hex-encoded sha256 of `content`, computed at write time so drift
 * detection never needs to re-read the working-tree file. `source_path`
 * is nullable because git-recovered rows may lack a working-tree file.
 *
 * `status` defaults to `'accepted'` per decision-record convention; the
 * column is `TEXT` (not a typed enum) so downstream domains can extend the
 * vocabulary without a schema migration. The canonical closed vocabulary
 * is `accepted | superseded | deprecated` — kept as TEXT, not
 * a CHECK constraint, to preserve the forward-compatible convention above.
 *
 * Supersession is append-only: a
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
  /**
   * Codex subtype (v8). Canonical closed vocabulary
   * `adr | glossary | pattern`; NULL = untyped/legacy. TEXT column — not pinned
   * by a CHECK, matching the forward-compatible convention on `status`.
   */
  kind: string | null;
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
    /**
     * Staleness auto-bubble: a task carrying an open
     * `blocker_raised` escalation gets a positive boost that grows with the
     * escalation's age, so unresolved escalations rank *up* over time. 0 when
     * the task has no open escalation.
     */
    escalation_boost: number;
    /** Type of the task's most-recent open escalation, or null if none. */
    escalation_type: EscalationType | null;
  };
}
