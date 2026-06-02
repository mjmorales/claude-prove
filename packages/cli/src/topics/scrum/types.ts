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
  | 'curation_proposed'
  | 'gate_responded';

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
 * Copy-down scope of a criterion when a child task inherits its parent's
 * shared acceptance. Closed vocabulary documented here, not pinned by a SQL
 * CHECK — the value lives inside `acceptance_json`, so the schema stays
 * forward-compatible.
 *
 *   descendants — copy to inheriting children; not a goalpost on the parent
 *                 itself (the parent declares it for the subtree to satisfy).
 *   self        — parent-only; NOT copied down to children.
 *   both        — applies to the parent AND copies down to children.
 *
 * Absent/undefined on a criterion is the copy-down default — treated as
 * `both` — so legacy rows authored before scope existed keep inheriting
 * exactly as before, with no silent behavior break.
 */
export type AcceptanceScope = 'descendants' | 'self' | 'both';

/** Runtime-checkable list of the closed `AcceptanceScope` set. */
export const ACCEPTANCE_SCOPES: AcceptanceScope[] = ['descendants', 'self', 'both'];

/**
 * Persisted verdict of a `gate`-kind criterion — a HUMAN decision recorded as
 * standing state on the criterion, never a process that blocks waiting for it.
 * Closed vocabulary documented here, not pinned by a SQL CHECK — the value
 * lives inside `acceptance_json`, so the schema stays forward-compatible.
 *
 *   gate_pending — the default a fresh gate-kind criterion carries: a human
 *                  has not yet decided. NOT satisfied; NOT a failure either.
 *   approved     — a human approved the gate. The criterion counts as satisfied.
 *   rejected     — a human rejected the gate. A verification failure.
 *
 * The decision is resolved PULL-based — an interactive `AskUserQuestion` turn,
 * the `scrum gate respond` CLI, or a session-start surfacing of pending gates.
 * There is NEVER a daemon or loop that blocks the engine waiting for the human;
 * "deferred" means recorded-state-that-persists, not a waiting process.
 */
export type GateVerdict = 'gate_pending' | 'approved' | 'rejected';

/** Runtime-checkable list of the closed `GateVerdict` set. */
export const GATE_VERDICTS: GateVerdict[] = ['gate_pending', 'approved', 'rejected'];

/**
 * Recorded outcome of verifying a `bash`/`agent` (or in-process `assert`)
 * criterion at the orchestrator validation gate. The gate has the two resources
 * a store-level close floor lacks — git (to cut an isolation worktree for a
 * `bash` check) and the run/plan context (for an `assert` expression) — so it
 * RUNS the heavy verification and STAMPS the result here. The close floor then
 * READS this standing verdict instead of re-running the worktree it cannot run.
 * Closed vocabulary documented here, not pinned by a SQL CHECK — the value lives
 * inside `acceptance_json`, so the schema stays forward-compatible.
 *
 *   pending  — the default a fresh criterion carries: the gate has not recorded
 *              an outcome yet. NOT satisfied; NOT a failure either.
 *   verified — the gate ran the check and it passed (bash exit 0 / assert true /
 *              agent judged satisfied). The criterion counts as satisfied.
 *   failed   — the gate ran the check and it failed. A verification failure.
 */
export type VerificationVerdict = 'pending' | 'verified' | 'failed';

/** Runtime-checkable list of the closed `VerificationVerdict` set. */
export const VERIFICATION_VERDICTS: VerificationVerdict[] = ['pending', 'verified', 'failed'];

/**
 * Recorded verification state for a criterion whose verdict the orchestrator
 * validation gate decides and the close floor reads. Carried inside the
 * criterion's `verification` field in `acceptance_json` (no DB migration).
 *
 *   verdict     — the current recorded outcome (see `VerificationVerdict`).
 *   reason      — short detail of the outcome: the offending sub-expression on a
 *                 failed `assert`, a transcript pointer on a failed `bash`, etc.
 *                 NULL while `pending`.
 *   verified_by — the executing unit that recorded the verdict (the orchestrator
 *                 validation gate / leaf worker), or NULL when none was in scope.
 *   verified_at — ISO-8601 timestamp of the recording write; NULL while pending.
 */
export interface VerificationRecord {
  verdict: VerificationVerdict;
  reason?: string | null;
  verified_by?: string | null;
  verified_at?: string | null;
}

/**
 * Persisted decision state for a `gate`-kind criterion, carried inside the
 * criterion's `gate` field in `acceptance_json` (no DB migration). A fresh
 * gate-kind criterion starts `{ verdict: 'gate_pending' }`; `scrum gate respond`
 * transitions it to `approved`/`rejected` and stamps the human responder.
 *
 *   verdict      — the current persisted decision (see `GateVerdict`).
 *   responder    — the human (or agent acting on a human's behalf) who resolved
 *                  the gate; NULL while `gate_pending`. The verification
 *                  contributor of record.
 *   comment      — optional free-text rationale recorded at respond time.
 *   responded_at — ISO-8601 timestamp of the resolving write; NULL while pending.
 */
export interface GateState {
  verdict: GateVerdict;
  responder?: string | null;
  comment?: string | null;
  responded_at?: string | null;
}

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
 *   scope          — copy-down gate when a child inherits this criterion:
 *                    `descendants`/`both` descend, `self` stays on the parent.
 *                    Absent = the copy-down default (`both`), so legacy rows
 *                    inherit exactly as before.
 */
export interface AcceptanceCriterion {
  id: string;
  text: string;
  verifies_by: AcceptanceVerifiesBy;
  /** Kind-specific check payload (command / expression / prompt). */
  check: string;
  status: AcceptanceCriterionStatus;
  idempotent: boolean;
  /**
   * Copy-down scope when a child inherits the parent's shared acceptance.
   * Absent = the copy-down default (`both`): copies down and applies to the
   * parent, preserving pre-scope inheritance behavior.
   */
  scope?: AcceptanceScope;
  timeout?: string;
  /**
   * Persisted gate-decision state for a `verifies_by: 'gate'` criterion. A
   * fresh gate-kind criterion is seeded `{ verdict: 'gate_pending' }`; resolved
   * via `scrum gate respond` (or an in-turn `AskUserQuestion`). Absent on
   * non-gate criteria. A gate criterion counts as satisfied only when
   * `gate.verdict === 'approved'`; `rejected` is a verification failure.
   */
  gate?: GateState;
  /**
   * Recorded verification verdict for a `bash`/`agent`/`assert` criterion,
   * stamped by the orchestrator validation gate (which has the git + run
   * context the store-level close floor lacks). The close floor READS this
   * standing verdict rather than re-running the worktree. Absent = never
   * verified (treated as `pending`). A `gate`-kind criterion does NOT use this
   * field — its decision lives in `gate.verdict`.
   */
  verification?: VerificationRecord;
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
 * Resource ceilings inside `TaskBounds`. Each is enforced by a different native
 * primitive — claude-prove has no enforcement daemon:
 *
 *   tool_calls   — ENFORCED by the PreToolUse bounds hook, which keeps a
 *                  per-task tool-call counter, soft-warns as the count nears
 *                  the limit, and hard-stops (canonical deny) at the limit.
 *   wall_clock_s — bounded by the native subagent dispatch timeout; a
 *                  PreToolUse hook cannot observe idle wall-clock.
 *   tokens       — bounded by the workflow/run token budget; a hook has no view
 *                  of the conversation's token accounting.
 *
 * `prep-permissions` additionally renders all three into the task prompt as
 * guidance. All fields optional; absent = unbounded.
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
 *   tools   — a NATIVE surface; allow/deny merge into permissions.
 *   budgets — `tool_calls` is ENFORCED by the PreToolUse bounds hook's
 *             per-task counter; `wall_clock_s`/`tokens` are bounded by the
 *             subagent timeout and the workflow token budget respectively. All
 *             three are also rendered into the prompt as guidance.
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

/**
 * Contributor lifecycle. Matches `scrum_contributors.status`; the column has
 * no CHECK constraint, so this union documents the canonical closed set
 * (`active | inactive`) without pinning the schema — a future status lands via
 * a schema-version bump, not a silent value.
 *
 *   active   — a current contributor; the default a fresh registration carries.
 *   inactive — a retired contributor kept for attribution history. Never
 *              hard-deleted, so past task rows referencing it still resolve.
 */
export type ContributorStatus = 'active' | 'inactive';

/** Runtime-checkable list of the closed `ContributorStatus` set. */
export const CONTRIBUTOR_STATUSES: ContributorStatus[] = ['active', 'inactive'];

/**
 * One row of the `scrum_contributors` table (v12) — a stable contributor
 * identity that backs role rosters, attribution, and PR-comment author
 * matching.
 *
 *   id    — a CT-prefixed stable contributor id (a CT-UUID, e.g.
 *           `ct-jane-doe-…`). Minted once at registration and NEVER changed, so
 *           attribution survives a renamed handle or a changed email. This is
 *           what task provenance columns (`created_by`/`last_modified_by`/
 *           `worker_id`) resolve TO.
 *   slug  — human-friendly handle, unique across the registry. The
 *           operator-facing name; the `id` is the durable key.
 *   github / email — the two resolution keys. `resolve` matches an executing
 *           worker / event author against `github` first, then falls back to
 *           `email`. Either may be NULL when unknown.
 *
 * `created_by`/`created_at`/`last_modified_by`/`last_modified_at` mirror the
 * provenance block the on-disk `contributor.md` identity artifact carries, so
 * the row and the file are one shape. The column names are snake_case to match
 * the on-disk columns one-to-one (SELECT results cast directly).
 */
export interface Contributor {
  id: string;
  slug: string;
  status: ContributorStatus;
  display_name: string | null;
  github: string | null;
  email: string | null;
  created_by: string | null;
  created_at: string;
  last_modified_by: string | null;
  last_modified_at: string | null;
}

/**
 * One row of `scrum_operator_history` (v13) — a single interval during which one
 * contributor held the operator-of-record role.
 *
 *   contributor_id — the holder, a `scrum_contributors.id` (CT-UUID).
 *   from_ts        — when the holder took the role (ISO-8601). May be backdated
 *                    to the real handoff instant, distinct from `created_at`.
 *   to_ts          — when they handed it off, or NULL for the CURRENT (open)
 *                    holder. The interval is half-open `[from_ts, to_ts)`: a
 *                    point-in-time resolve at `t` returns the row where
 *                    `from_ts <= t AND (to_ts IS NULL OR t < to_ts)`.
 *
 * At most one open row (`to_ts IS NULL`) exists at a time — setting a new holder
 * closes the prior open row before appending. History is append-only: an
 * interval is never mutated except to stamp its `to_ts` once on handoff.
 *
 * This is the single role slot that exists — a degenerate one-row roster that a
 * later multi-role roster generalizes.
 */
export interface OperatorHistoryRow {
  id: number;
  contributor_id: string;
  from_ts: string;
  to_ts: string | null;
  created_at: string;
  created_by: string | null;
}

/**
 * Input to `setOperatorOfRecord` (v13). `contributorId` is the new holder's
 * CT-UUID; it must be a registered contributor (validated by the store).
 * `fromTs` defaults to now() — the instant the handoff takes effect, used both
 * as the new interval's `from_ts` and as the prior open interval's `to_ts`.
 * Provenance is sourced from the run env (`PROVE_AGENT`) when `createdBy` is
 * omitted.
 */
export interface SetOperatorOfRecordInput {
  contributorId: string;
  /** ISO-8601 effective instant of the handoff; defaults to now(). */
  fromTs?: string;
  /** Agent that authored the transfer; defaults to `PROVE_AGENT` else NULL. */
  createdBy?: string | null;
}

/**
 * A team's interaction archetype. Matches `scrum_teams.team_type`; the column
 * has no CHECK constraint, so this union documents the canonical closed set
 * without pinning the schema — a future type lands via a schema-version bump,
 * not a silent value. Enforced at the store boundary in `createTeam`.
 *
 *   stream_aligned        — a team aligned to a single flow of work (a product,
 *                           feature stream, or user journey).
 *   platform              — a team providing an internal product (a platform)
 *                           that reduces cognitive load for stream-aligned teams.
 *   enabling              — a team that helps other teams adopt a capability,
 *                           then steps back; transient by intent.
 *   complicated_subsystem — a team owning a part requiring deep specialist
 *                           knowledge, kept separate to concentrate expertise.
 */
export type TeamType = 'stream_aligned' | 'platform' | 'enabling' | 'complicated_subsystem';

/** Runtime-checkable list of the closed `TeamType` set. */
export const TEAM_TYPES: TeamType[] = [
  'stream_aligned',
  'platform',
  'enabling',
  'complicated_subsystem',
];

/**
 * A team's expected longevity. Matches `scrum_teams.lifetime`; the column has
 * no CHECK constraint, so this union documents the canonical closed set without
 * pinning the schema. Enforced at the store boundary in `createTeam`.
 *
 *   persistent              — the team stands indefinitely; the default a fresh
 *                             team carries.
 *   terminates_on_milestone — the team disbands when its goal milestone closes.
 *                             The concrete target milestone is recorded by a
 *                             later additive column, not on the base registry.
 */
export type TeamLifetime = 'persistent' | 'terminates_on_milestone';

/** Runtime-checkable list of the closed `TeamLifetime` set. */
export const TEAM_LIFETIMES: TeamLifetime[] = ['persistent', 'terminates_on_milestone'];

/**
 * One row of the `scrum_teams` table (v14) — a team, the unit a body of work and
 * the artifacts it owns are organized around.
 *
 *   slug      — human-friendly handle, unique across the registry and the
 *               primary key. The operator-facing name a team is referenced by.
 *   team_type — the team's interaction archetype (see `TeamType`).
 *   charter   — a one-line mission statement, or NULL when unset.
 *   lifetime  — the team's expected longevity (see `TeamLifetime`).
 *
 * Scope globs, a roster, accept/expose contracts, and the concrete terminating
 * milestone target are NOT on this base row — later additive migrations append
 * them (own columns or own tables). The column names are snake_case to match the
 * on-disk columns one-to-one (SELECT results cast directly).
 */
export interface Team {
  slug: string;
  team_type: TeamType;
  charter: string | null;
  lifetime: TeamLifetime;
  created_at: string;
}

/**
 * Input to `createTeam` (v14). `slug` is the unique handle (primary key);
 * re-registering the same slug throws rather than silently overwriting.
 * `lifetime` defaults to `'persistent'`. `charter` defaults to NULL. Both
 * `teamType` and `lifetime` are validated against their closed vocabularies at
 * the store boundary.
 */
export interface CreateTeamInput {
  slug: string;
  teamType: TeamType;
  charter?: string | null;
  lifetime?: TeamLifetime;
  /** ISO-8601 timestamp; defaults to now(). */
  createdAt?: string;
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
