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

/**
 * Task lifecycle. Matches `scrum_tasks.status` column values. The column is
 * plain TEXT with no CHECK constraint, so this union extends freely and older
 * databases stay forward-compatible — no DB migration is needed to add a state.
 *
 * Canonical order: `backlog → proposed → accepted → ready → in_progress →
 * review → done`, with `blocked`/`cancelled` reachable from the active states.
 *
 *   proposed — decomposed into children, awaiting the decomposition review.
 *   accepted — the decomposition review passed; this is the gate that fires the
 *              next layer's decompose. Distinct from `ready` (deps cleared,
 *              implementation may start), which the two states used to conflate.
 */
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
  | 'gate_responded'
  | 'ask_filed'
  | 'ask_responded';

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
// Escalation protocol — walk-up chain + state machine + resolution modes
// ---------------------------------------------------------------------------

/**
 * The fixed escalation ladder a typed escalation walks UP, one layer per step.
 * A first-class chain distinct from the per-team `TeamRole` roster: the roster
 * names who fills a team's three slots, whereas this ladder is the org-wide
 * authority chain an escalation climbs until someone resolves it. The order is
 * canonical and total — `implementer` is the lowest rung (where work happens),
 * `human` is the top (the terminal authority that cannot be walked past).
 *
 *   implementer — the worker that raised the escalation; the bottom rung.
 *   engineer    — the next rung up; owns the immediate technical decision.
 *   tech_lead   — owns the team's technical direction.
 *   pm          — owns scope and priority for the body of work.
 *   strategy    — owns cross-cutting direction above any single team.
 *   human       — the terminal authority; an escalation at `human` has nowhere
 *                 higher to walk, so a re-escalate at this rung is rejected.
 */
export type EscalationLayer =
  | 'implementer'
  | 'engineer'
  | 'tech_lead'
  | 'pm'
  | 'strategy'
  | 'human';

/**
 * The walk-up chain in canonical bottom-to-top order. The single source of
 * truth for "one layer up": `nextEscalationLayer` indexes this array, so an
 * escalation advances EXACTLY one rung and never skips. The array order IS the
 * chain — reordering it reorders the ladder.
 */
export const ESCALATION_CHAIN: EscalationLayer[] = [
  'implementer',
  'engineer',
  'tech_lead',
  'pm',
  'strategy',
  'human',
];

/**
 * The layer exactly one rung above `layer`, or null when `layer` is the top
 * (`human`) and there is nowhere higher to walk. The store's walk-up uses this
 * to advance an escalation by exactly one rung — there is no skip-ahead path.
 */
export function nextEscalationLayer(layer: EscalationLayer): EscalationLayer | null {
  const idx = ESCALATION_CHAIN.indexOf(layer);
  if (idx < 0 || idx + 1 >= ESCALATION_CHAIN.length) return null;
  return ESCALATION_CHAIN[idx + 1] ?? null;
}

/**
 * Lifecycle of one escalation. A closed four-state machine matching the
 * `scrum_escalations.state` column; the column carries no CHECK, so this union
 * documents the closed set and the store boundary enforces every transition.
 *
 *   open         — the escalation is awaiting its current layer's resolution;
 *                  the state a fresh escalation is raised in.
 *   resolved     — the current layer resolved it (`resolve`). TERMINAL.
 *   re_escalated — the current layer kicked it one rung higher (`re_escalate`):
 *                  this escalation row is closed `re_escalated` and a NEW `open`
 *                  row is appended at the next layer up. TERMINAL for THIS row.
 *   auto_bubbled — the escalation aged past its threshold without a resolution
 *                  and was bubbled one rung higher by the staleness floor rather
 *                  than by an explicit receiver action. TERMINAL for THIS row;
 *                  like `re_escalated`, it closes this row and opens the next.
 */
export type EscalationState = 'open' | 'resolved' | 're_escalated' | 'auto_bubbled';

/** Runtime-checkable list of the closed `EscalationState` set. */
export const ESCALATION_STATES: EscalationState[] = [
  'open',
  'resolved',
  're_escalated',
  'auto_bubbled',
];

/**
 * How a receiver resolves an `open` escalation — the `escalation_resolution`
 * mode. A closed set: the receiver at the escalation's current layer applies
 * exactly one of these, and the store transitions the row's state accordingly.
 *
 *   resolve       — the receiver answered the escalation. The row → `resolved`.
 *   re_decompose  — the escalation cannot be answered as-posed; it needs the
 *                   work re-decomposed. The row → `resolved` (this escalation is
 *                   discharged) AND `re_decompose_triggered` is set on the
 *                   result, the signal the driver uses to force re-decomposition
 *                   of the owning task. No walk-up — re-decomposition happens at
 *                   the SAME layer that received it.
 *   re_escalate   — the receiver cannot resolve at this layer and kicks it one
 *                   rung up. The row → `re_escalated` and a NEW `open` row is
 *                   appended at `nextEscalationLayer`. Rejected when the current
 *                   layer is already `human` (the top — nowhere higher to walk).
 */
export type EscalationResolutionMode = 'resolve' | 're_decompose' | 're_escalate';

/** Runtime-checkable list of the closed `EscalationResolutionMode` set. */
export const ESCALATION_RESOLUTION_MODES: EscalationResolutionMode[] = [
  'resolve',
  're_decompose',
  're_escalate',
];

/**
 * The fixed staleness threshold (hours) an `open` escalation may sit before the
 * reconciler hook auto-bubbles it one rung up. A constant — not persisted — so
 * the floor is uniform across every project and needs no schema or config
 * surface. An escalation whose age (`now − created_at`) EXCEEDS this is stale;
 * an escalation at exactly the threshold is not yet (strict `>`).
 */
export const STALENESS_THRESHOLD_HOURS = 24;

/**
 * Structured markers carried on `scrum_escalations.attributes` (the v25 JSON
 * column). NULL on every raised / re-escalated / resolved row; set ONLY on a
 * row the staleness floor auto-bubbles.
 *
 *   auto_bubbled       — true on a row advanced by the staleness clock (the
 *                        engine), distinguishing it from a receiver-driven
 *                        `re_escalate` without reading `resolution_mode`.
 *   linked_escalation  — the `scrum_escalations.id` of the fresh `open` row this
 *                        row was bubbled UP to. The FORWARD pointer (original →
 *                        new), the inverse of the new row's `walked_up_from`
 *                        BACK-pointer, so the staleness walk-up is traversable
 *                        in either direction.
 */
export interface EscalationAttributes {
  auto_bubbled?: boolean;
  linked_escalation?: number;
}

/**
 * A row of `scrum_escalations` — one typed escalation at one layer of the
 * walk-up chain. Walk-up is APPEND-ONLY: a `re_escalate` / `auto_bubble` does
 * not move a row up, it CLOSES this row (state `re_escalated` / `auto_bubbled`)
 * and APPENDS a fresh `open` row at the next layer that points back here via
 * `walked_up_from`. The whole chain a single escalation climbed is therefore
 * reconstructable by following `walked_up_from` back to the root (`null`).
 *
 *   id              — AUTOINCREMENT surrogate.
 *   task_id         — the owning task; a SOFT reference (no FK) so an escalation
 *                     may name a task the store does not verify, matching how the
 *                     roster and annotations hold their referents.
 *   escalation_type — the closed `EscalationType` (blocked | ambiguous |
 *                     conflict | missing_context); guarded at the store boundary.
 *   layer           — the rung of the walk-up chain this row sits at (see
 *                     `EscalationLayer`); guarded at the store boundary.
 *   state           — the closed `EscalationState` (open | resolved |
 *                     re_escalated | auto_bubbled).
 *   summary         — the attention-bearing prose the receiver reads.
 *   raised_by       — who raised this escalation (an identifier — typically a
 *                     CT-UUID). Recorded for provenance.
 *   resolution_mode — the `EscalationResolutionMode` applied to close it, or
 *                     NULL while still `open`.
 *   resolution_note — the receiver's free-text rationale on resolution, or NULL.
 *   resolved_by     — who resolved it, or NULL while still `open`.
 *   walked_up_from  — the `scrum_escalations.id` this row was walked up FROM, or
 *                     NULL for a root escalation (the first rung). The back-pointer
 *                     that reconstructs the chain.
 *   attributes      — structured `EscalationAttributes` markers, or NULL. Set
 *                     ONLY on a row the staleness floor auto-bubbled, carrying
 *                     `auto_bubbled: true` and `linked_escalation` (the forward
 *                     pointer to the fresh row one rung up).
 *   created_at      — when this row was raised/appended (ISO-8601).
 *   resolved_at     — when this row left `open` (ISO-8601), or NULL while open.
 */
export interface EscalationRow {
  id: number;
  task_id: string;
  escalation_type: EscalationType;
  layer: EscalationLayer;
  state: EscalationState;
  summary: string;
  raised_by: string | null;
  resolution_mode: EscalationResolutionMode | null;
  resolution_note: string | null;
  resolved_by: string | null;
  walked_up_from: number | null;
  attributes: EscalationAttributes | null;
  created_at: string;
  resolved_at: string | null;
}

/**
 * Input to `raiseEscalation`. `escalationType` must be a member of the closed
 * `EscalationType` set; `layer` defaults to `implementer` (the bottom rung —
 * where a worker raises). Both are guarded at the store boundary. `taskId` is a
 * soft reference (existence not checked). `createdAt` defaults to now().
 */
export interface RaiseEscalationInput {
  taskId: string;
  escalationType: EscalationType;
  summary: string;
  /** The rung this escalation is raised at; defaults to `implementer`. */
  layer?: EscalationLayer;
  raisedBy?: string | null;
  /** ISO-8601 timestamp; defaults to now(). */
  createdAt?: string;
}

/**
 * Input to `resolveEscalation`. `id` names the `open` escalation row to act on;
 * `mode` is the `EscalationResolutionMode` the receiver applies (guarded at the
 * store boundary). `note`/`resolvedBy` are recorded for provenance.
 * `resolvedAt` defaults to now().
 */
export interface ResolveEscalationInput {
  id: number;
  mode: EscalationResolutionMode;
  note?: string | null;
  resolvedBy?: string | null;
  /** ISO-8601 timestamp; defaults to now(). */
  resolvedAt?: string;
}

/**
 * The result of `resolveEscalation`. `row` is the (now-closed) escalation row
 * the resolution acted on. `walkedUpTo` is the freshly-appended `open` row at
 * the next layer when `mode` was `re_escalate` (otherwise null).
 * `reDecomposeTriggered` is true ONLY for `re_decompose` — the signal the driver
 * reads to force re-decomposition of the owning task. Exactly one of
 * (`walkedUpTo` set) / (`reDecomposeTriggered` true) / (neither, for `resolve`)
 * holds.
 */
export interface ResolveEscalationResult {
  row: EscalationRow;
  walkedUpTo: EscalationRow | null;
  reDecomposeTriggered: boolean;
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
  /**
   * Team binding (v27): the `scrum_teams.slug` that owns this task, or NULL for
   * an unbound (team-less) task. A soft reference — registry membership is
   * validated at the CLI boundary on `--team`, not by a SQL constraint.
   */
  team_slug: string | null;
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
 * Closed Codex subtypes whose write path is GATED — a decision of one of these
 * kinds does NOT land durably `accepted` on record. It enters as a DRAFT and
 * becomes `accepted` only when its required write-gate is approved:
 *   - `adr` and `pattern` require a human approve gate (any responder).
 *   - `glossary` requires a tech_lead review (the responder must currently hold
 *     a `tech_lead` slot on some team).
 * A decision with NO kind, or a kind outside this set, is NOT gated — it lands
 * `accepted` immediately on record, exactly as an untyped decision always has.
 */
export const GATED_DECISION_KINDS = ['adr', 'glossary', 'pattern'] as const;

/** The subtype that requires tech_lead review (rather than a plain human gate). */
export const TECH_LEAD_REVIEW_KIND = 'glossary';

/**
 * Write-gate state on a Codex decision (v21). Mirrors the `GateVerdict` idiom
 * (a HUMAN decision recorded as standing state, never a blocking process), but
 * names the write-acceptance lifecycle of a gated decision:
 *
 *   draft    — the decision is recorded but NOT durably accepted; its required
 *              approve gate / tech_lead review has not yet been approved. The
 *              row's `status` is held at `'draft'` (out of the accepted set)
 *              while in this state.
 *   approved — the gate was approved; the decision is durably `accepted`.
 *   rejected — the gate was rejected; the decision is BLOCKED — it never becomes
 *              `accepted`. Re-deciding a rejected (or approved) gate is refused.
 *
 * A NON-gated decision (no kind, or a kind outside `GATED_DECISION_KINDS`)
 * carries `write_status = null` — it bypasses the gate entirely and lands
 * `accepted` on record.
 */
export type DecisionWriteStatus = 'draft' | 'approved' | 'rejected';

/** Runtime-checkable list of the closed `DecisionWriteStatus` set. */
export const DECISION_WRITE_STATUSES: DecisionWriteStatus[] = ['draft', 'approved', 'rejected'];

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
  /**
   * Write-gate state (v21). `draft | approved | rejected` for a GATED-kind
   * decision (`adr | glossary | pattern`); NULL for a non-gated decision (no
   * kind, or a kind outside the gated set) — which bypasses the gate and lands
   * `accepted` on record. A `draft` row is NOT durably accepted (`status` is
   * held at `'draft'`); `approved` flips `status` to `'accepted'`; `rejected`
   * blocks the decision (it never becomes accepted). TEXT column — not pinned by
   * a CHECK, matching the forward-compatible convention on `status`/`kind`.
   */
  write_status: DecisionWriteStatus | null;
  /**
   * The responder who resolved the write-gate (v21) — `approveDecision` /
   * `rejectDecision` stamp it. NULL while `draft` or on a non-gated row. The
   * write-acceptance contributor of record, mirroring `gate.responder` on a
   * task's acceptance gate.
   */
  gate_responder: string | null;
  /** ISO-8601 timestamp of the gate-resolving write (v21). NULL until resolved. */
  gate_responded_at: string | null;
  /**
   * Provenance back-pointer (v22): the `scrum_lores.id` this decision was
   * promoted FROM, or NULL when the decision was authored directly (the common
   * case). Set ONLY by `promoteLoreToCodex`, which lifts a generally-applicable
   * team Lore entry into the Codex as a gated DRAFT carrying this back-pointer.
   * The Lore row is append-only and never hard-deleted, so the pointer always
   * resolves. INTEGER column — not pinned by a CHECK, matching the
   * forward-compatible convention on `status`/`kind`/`write_status`.
   */
  source_lore_id: number | null;
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
 *                             team carries. Carries no `terminates_on_milestone`
 *                             target.
 *   terminates_on_milestone — the team disbands when its goal milestone closes.
 *                             The concrete target milestone is the team's
 *                             `terminates_on_milestone` column; a team with this
 *                             lifetime MUST carry a target, enforced at the store
 *                             boundary in `createTeam`/`setTeamTerminatesOn`.
 */
export type TeamLifetime = 'persistent' | 'terminates_on_milestone';

/** Runtime-checkable list of the closed `TeamLifetime` set. */
export const TEAM_LIFETIMES: TeamLifetime[] = ['persistent', 'terminates_on_milestone'];

/**
 * A team's lifecycle state. Matches `scrum_teams.status`; the column has no
 * CHECK constraint, so this union documents the closed set without pinning the
 * schema. Enforced at the store boundary.
 *
 *   active   — the team is live and operable; the default a fresh team carries.
 *   inactive — the team has been disbanded (its scope released, exposes
 *              superseded, roster vacated). Terminal: `teamTerminate` flips a
 *              team here and nothing flips it back.
 */
export type TeamStatus = 'active' | 'inactive';

/** Runtime-checkable list of the closed `TeamStatus` set. */
export const TEAM_STATUSES: TeamStatus[] = ['active', 'inactive'];

/**
 * One row of the `scrum_teams` table (v14) — a team, the unit a body of work and
 * the artifacts it owns are organized around.
 *
 *   slug                    — human-friendly handle, unique across the registry
 *                             and the primary key. The operator-facing name a
 *                             team is referenced by.
 *   team_type               — the team's interaction archetype (see `TeamType`).
 *   charter                 — a one-line mission statement, or NULL when unset.
 *   lifetime                — the team's expected longevity (see `TeamLifetime`).
 *   terminates_on_milestone — the concrete milestone id the team disbands on for
 *                             a `terminates_on_milestone` lifetime, or NULL for a
 *                             `persistent` team (v18). A soft reference — not an
 *                             FK to `scrum_milestones` — so a team may name a
 *                             milestone created later.
 *   status                  — the team's lifecycle state (see `TeamStatus`); a
 *                             live team is `active`, a disbanded team `inactive`
 *                             (v18).
 *
 * Scope globs, a roster, and accept/expose contracts are NOT on this base row —
 * additive migrations append them as their own tables. The column names are
 * snake_case to match the on-disk columns one-to-one (SELECT results cast
 * directly).
 */
export interface Team {
  slug: string;
  team_type: TeamType;
  charter: string | null;
  lifetime: TeamLifetime;
  terminates_on_milestone: string | null;
  status: TeamStatus;
  created_at: string;
}

/**
 * Input to `createTeam` (v14, extended v18). `slug` is the unique handle
 * (primary key); re-registering the same slug throws rather than silently
 * overwriting. `lifetime` defaults to `'persistent'`. `charter` defaults to
 * NULL. A fresh team is always `status = 'active'`.
 *
 * `terminatesOnMilestone` is the concrete target a `terminates_on_milestone`
 * team disbands on. The lifetime↔target consistency rule is enforced at the
 * store boundary: a `terminates_on_milestone` lifetime REQUIRES a target, and a
 * `persistent` lifetime FORBIDS one. Both `teamType` and `lifetime` are validated
 * against their closed vocabularies at the same boundary.
 */
export interface CreateTeamInput {
  slug: string;
  teamType: TeamType;
  charter?: string | null;
  lifetime?: TeamLifetime;
  /** Target milestone id for a `terminates_on_milestone` team; omit for a persistent team. */
  terminatesOnMilestone?: string | null;
  /** ISO-8601 timestamp; defaults to now(). */
  createdAt?: string;
}

/**
 * The result of `teamTerminate` (v18) — the team-local disband. Every effect is
 * applied in one transaction: the team's scope is released, every active expose
 * is superseded with the disband reason, every open roster slot is vacated, and
 * the team's `status` flips to `inactive`. The result reports the counts so the
 * caller can summarize the disband without re-querying.
 *
 *   slug             — the disbanded team.
 *   exposesRetired   — how many active expose entries were superseded.
 *   rosterVacated    — how many open (team, role) roster rows were closed.
 *   scopesCleared    — total read + write globs released (the prior scope size).
 */
export interface TeamTerminateResult {
  slug: string;
  exposesRetired: number;
  rosterVacated: number;
  scopesCleared: number;
}

/**
 * Which side of a team's scope a glob belongs to. Matches
 * `scrum_team_scopes.kind`; the column has no CHECK constraint, so this union
 * documents the closed set without pinning the schema. Enforced at the store
 * boundary in `setTeamScopes`.
 *
 *   read  — a path glob the team reads from. READ globs MAY overlap across
 *           teams — many teams can read the same shared code.
 *   write — a path glob the team writes to. WRITE globs MUST NOT overlap across
 *           teams: a single writer owns each path (the single-writer-per-path
 *           rule), the team-level analog of the per-task write-wall a sub-task
 *           git worktree enforces. The cross-team write-disjointness is checked
 *           by `validateTeamWriteScopes`.
 */
export type TeamScopeKind = 'read' | 'write';

/** Runtime-checkable list of the closed `TeamScopeKind` set. */
export const TEAM_SCOPE_KINDS: TeamScopeKind[] = ['read', 'write'];

/**
 * A team's scope globs (v15), grouped by side. The decoded view of the
 * `scrum_team_scopes` rows for one team: every `read` row collected into
 * `read`, every `write` row into `write`. Both arrays are deduped and sorted at
 * the store boundary, so the shape is canonical regardless of insert order.
 * Empty arrays mean the team declares no globs on that side (the unscoped
 * default a freshly-created team carries).
 */
export interface TeamScopes {
  read: string[];
  write: string[];
}

/**
 * A write-scope overlap between two teams — the conflict `validateTeamWriteScopes`
 * returns when the single-writer-per-path rule is violated. Identifies BOTH
 * conflicting teams and the specific pair of globs whose path sets could
 * intersect, so the caller can name the conflict precisely rather than failing
 * with a bare "overlap detected".
 *
 *   teamA / teamB — the two team slugs whose write scopes collide, ordered so
 *                   `teamA <= teamB` (stable, slug-sorted) for deterministic
 *                   reporting.
 *   globA / globB — the offending write glob from `teamA` and from `teamB`
 *                   respectively. Equal strings when the exact-same glob is
 *                   declared by both teams.
 */
export interface TeamWriteScopeConflict {
  teamA: string;
  teamB: string;
  globA: string;
  globB: string;
}

/**
 * One of a team's three role slots. Every team has exactly these three —
 * `tech_lead`, `engineer`, and `implementer` — and no others. Matches
 * `scrum_team_members.role`; the column has no CHECK constraint, so this union
 * documents the canonical closed set without pinning the schema (a new role
 * lands via a schema-version bump, not a silent value). Enforced at the store
 * boundary in `rotateTeamMember`.
 *
 *   tech_lead   — sets technical direction and is accountable for the team's
 *                 architecture and standards.
 *   engineer    — designs and builds the team's substantive work.
 *   implementer — executes well-specified work against the engineer's design.
 */
export type TeamRole = 'tech_lead' | 'engineer' | 'implementer';

/** Runtime-checkable list of the closed `TeamRole` set, in canonical order. */
export const TEAM_ROLES: TeamRole[] = ['tech_lead', 'engineer', 'implementer'];

/**
 * One row of the `scrum_team_members` table (v16) — a single interval during
 * which one contributor held one role slot on one team. The per-(team, role)
 * generalization of the single-slot operator-of-record position history: each
 * (team_slug, role) pair is its own append-only series of intervals.
 *
 *   team_slug      — the owning team, a `scrum_teams.slug`.
 *   role           — which of the three slots this interval fills (see
 *                    `TeamRole`).
 *   contributor_id — the holder, a `scrum_contributors.id` (CT-UUID). A soft
 *                    reference: it is NOT enforced by a foreign key, matching how
 *                    the operator position history stores its holder.
 *   from_ts        — when the holder took the slot (ISO-8601).
 *   to_ts          — when they vacated it, or NULL for the CURRENT (open) holder
 *                    of that (team, role). The interval is half-open
 *                    `[from_ts, to_ts)`.
 *   reason         — free-text rationale recorded on the rotation, or NULL.
 *
 * Exactly one open row (`to_ts IS NULL`) exists per (team_slug, role) once the
 * slot has ever been filled — rotating a slot closes its prior open row before
 * appending the new one. History is append-only: an interval is never mutated
 * except to stamp its `to_ts` once on rotation.
 */
export interface TeamMemberRow {
  id: number;
  team_slug: string;
  role: TeamRole;
  contributor_id: string;
  from_ts: string;
  to_ts: string | null;
  reason: string | null;
  created_at: string;
}

/**
 * Input to `rotateTeamMember` (v16). `teamSlug` must be a registered team and
 * `role` must be one of the closed `TeamRole` set (both guarded at the store
 * boundary). `contributorId` is the new holder's CT-UUID — a soft reference, not
 * validated against the contributor registry, mirroring the operator history.
 * `fromTs` defaults to now() — the instant the rotation takes effect, used both
 * as the new interval's `from_ts` and as the prior open interval's `to_ts`.
 * `reason` is an optional rationale recorded on the new interval.
 */
export interface RotateTeamMemberInput {
  teamSlug: string;
  role: TeamRole;
  contributorId: string;
  /** ISO-8601 effective instant of the rotation; defaults to now(). */
  fromTs?: string;
  /** Free-text rationale recorded on the new interval; defaults to NULL. */
  reason?: string | null;
}

/**
 * The result of `rotateTeamMember`: the newly-appended open interval plus an
 * optional multi-slot warning. A WARNING (never a rejection) is emitted when the
 * rotated-in contributor already holds ANOTHER open role on the SAME team — the
 * team-of-one case where one person fills multiple slots. The rotation always
 * completes; the caller surfaces `warning` on stderr.
 */
export interface RotateTeamMemberResult {
  row: TeamMemberRow;
  /** Set when the holder already occupies another open slot on the team. */
  warning: string | null;
}

/**
 * A team's current roster (v16) — the open holder of each of the three role
 * slots, plus optionally the full position history per slot. The current view of
 * the `scrum_team_members` open rows for one team.
 *
 *   slug    — the team the roster belongs to.
 *   current — the open holder per role: each of `tech_lead`/`engineer`/
 *             `implementer` maps to its open `TeamMemberRow`, or NULL when that
 *             slot has never been filled (or has no current holder).
 *   history — every interval for the team, oldest-first, grouped by role. Present
 *             only when the caller requests it; omitted for the current-only view.
 */
export interface TeamRoster {
  slug: string;
  current: Record<TeamRole, TeamMemberRow | null>;
  history?: Record<TeamRole, TeamMemberRow[]>;
}

/**
 * Lifecycle of a team-interface entry (an accept or an expose). Matches
 * `scrum_team_accepts.status` / `scrum_team_exposes.status`; the columns carry
 * no CHECK constraint, so this union documents the closed set without pinning
 * the schema. Enforced at the store boundary.
 *
 *   active     — the interface entry is current and consumable.
 *   superseded — the entry was retired by an explicit edit. The row is never
 *                hard-deleted (removing a published interface is a backward-
 *                compatibility hazard that must stay auditable); instead its
 *                `reason` records why and `superseded_by` optionally points at a
 *                replacement entry. A superseded entry cannot be re-superseded.
 */
export type TeamInterfaceStatus = 'active' | 'superseded';

/** Runtime-checkable list of the closed `TeamInterfaceStatus` set. */
export const TEAM_INTERFACE_STATUSES: TeamInterfaceStatus[] = ['active', 'superseded'];

/**
 * One row of the `scrum_team_accepts` table (v17) — a closed kebab-case ask type
 * a team handles (e.g. `schema-change`, `api-review`). Append-only with
 * supersession: a retired ask type is never removed; its `status` flips to
 * `superseded` with a `reason` and an optional `superseded_by` pointer.
 *
 *   id            — AUTOINCREMENT surrogate; the replacement target a later
 *                   entry's `superseded_by` references.
 *   team_slug     — the owning team, a `scrum_teams.slug`.
 *   ask_type      — the kebab-case ask type. Format `^[a-z0-9]+(-[a-z0-9]+)*$`,
 *                   validated at the store boundary in `addTeamAccept`.
 *   status        — `active` or `superseded` (see `TeamInterfaceStatus`).
 *   superseded_by — id of the replacement accept row, or NULL when the entry is
 *                   active or was superseded without a named replacement.
 *   reason        — free-text rationale recorded at supersession, or NULL while
 *                   active.
 *   created_at    — when the row was appended (ISO-8601).
 */
export interface TeamAcceptRow {
  id: number;
  team_slug: string;
  ask_type: string;
  status: TeamInterfaceStatus;
  superseded_by: number | null;
  reason: string | null;
  created_at: string;
}

/**
 * One row of the `scrum_team_exposes` table (v17) — an output a team publishes
 * for other teams to consume. Append-only with supersession, mirroring
 * `TeamAcceptRow`.
 *
 *   id            — AUTOINCREMENT surrogate; the replacement target a later
 *                   entry's `superseded_by` references.
 *   team_slug     — the owning team, a `scrum_teams.slug`.
 *   name          — the output's handle (free text).
 *   schema_ref    — a pointer to the output's shape (free text).
 *   status        — `active` or `superseded` (see `TeamInterfaceStatus`).
 *   superseded_by — id of the replacement expose row, or NULL.
 *   reason        — free-text rationale recorded at supersession, or NULL while
 *                   active.
 *   created_at    — when the row was appended (ISO-8601).
 */
export interface TeamExposeRow {
  id: number;
  team_slug: string;
  name: string;
  schema_ref: string;
  status: TeamInterfaceStatus;
  superseded_by: number | null;
  reason: string | null;
  created_at: string;
}

/**
 * Input to `addTeamExpose` (v17). `name` is the output's handle and `schemaRef`
 * points at its shape; both are free text. `createdAt` defaults to now().
 */
export interface AddTeamExposeInput {
  name: string;
  schemaRef: string;
  /** ISO-8601 timestamp; defaults to now(). */
  createdAt?: string;
}

/**
 * A team's published interface (v17) — the ask types it accepts and the outputs
 * it exposes. The decoded view of one team's `scrum_team_accepts` and
 * `scrum_team_exposes` rows. By default only `active` entries are present; a
 * caller can request the full history (including superseded entries) for audit.
 * Tolerates an unknown slug: both arrays are empty (the absence reads as "no
 * interface" rather than an error, matching `getTeamScopes`).
 *
 *   slug    — the team the interface belongs to.
 *   accepts — the team's accept entries, ordered by id.
 *   exposes — the team's expose entries, ordered by id.
 */
export interface TeamInterface {
  slug: string;
  accepts: TeamAcceptRow[];
  exposes: TeamExposeRow[];
}

/**
 * One team's contribution to the cross-team Manifest — a team's slug paired with
 * its ACTIVE interface contracts (the ask types it accepts and the outputs it
 * exposes). The flattened decode of one team's `TeamInterface`: same `accepts` /
 * `exposes` rows, carried without the redundant per-row `slug` echo (the entry's
 * own `slug` field is the owner).
 *
 *   slug    — the team this entry describes.
 *   accepts — the team's ACTIVE accept entries, ordered by id.
 *   exposes — the team's ACTIVE expose entries, ordered by id.
 */
export interface ManifestTeamEntry {
  slug: string;
  accepts: TeamAcceptRow[];
  exposes: TeamExposeRow[];
}

/**
 * The cross-team Manifest — the single both-teams-visible surface that
 * aggregates every team's published interface contracts (its accepts and
 * exposes) into one view, so any team can read what every other team handles and
 * publishes without walking the registry itself. A pure read aggregation over
 * the team-interface tables: no Manifest state is persisted, and building it
 * never mutates.
 *
 *   teams — one `ManifestTeamEntry` per registered team, ordered by slug
 *           (mirroring `listTeams`). Empty when no teams exist.
 *   asks  — the cross-team asks surface. Always empty until an inter-agent ask
 *           protocol (a capability that lets one team file a request against
 *           another's accepted ask types) exists to source it; the field is the
 *           declared shape that surface will fill, kept present so a Manifest
 *           reader sees the full contract from the start. Each ask, once
 *           sourced, will name a requesting team, a target team, and an ask type
 *           drawn from the target's accepts.
 */
export interface Manifest {
  teams: ManifestTeamEntry[];
  asks: ManifestAsk[];
}

/**
 * One cross-team ask — a request one team files against another team's accepted
 * ask types. The declared shape of the Manifest's `asks` surface; no instances
 * are produced until an inter-agent ask protocol exists to source them, so the
 * Manifest's `asks` array is always empty at present. Defined here so the
 * Manifest contract is complete and a future ask source has a fixed target type.
 *
 *   from_team — the requesting team's slug.
 *   to_team   — the target team's slug (the team that accepts the ask type).
 *   ask_type  — the kebab-case ask type requested, drawn from the target team's
 *               `accepts`.
 */
export interface ManifestAsk {
  from_team: string;
  to_team: string;
  ask_type: string;
}

/**
 * The lifecycle state of a cross-team ask. A freshly-filed ask is always
 * `'filed'` (v23); the triage/respond step (v25) discharges it to exactly one of
 * three terminal verdicts. Later protocol steps extend this closed set via a
 * schema-version bump, never a silent value. Matches `scrum_asks.state`; the
 * column has no CHECK constraint, so this union documents the canonical closed
 * set without pinning the schema. Enforced at the store boundary in `fileAsk`
 * (the `filed` seed) and `respondAsk` (the verdict transition).
 *
 *   filed     — the ask has been recorded against the target team; no response
 *               yet. The only state from which `respondAsk` may transition.
 *   accepted  — the accepting team agreed: it created one child task under its
 *               tree (`mapped_artifact`) and the from-team's blocking artifact
 *               now `blocked_by` that child.
 *   rejected  — the team declined the ask; `rejected_reason` records why. No
 *               tree or dependency mutation.
 *   countered — the team proposed a different artifact/scope/interface;
 *               `counter_proposal` records it. No tree or dependency mutation.
 */
export type AskState = 'filed' | 'accepted' | 'rejected' | 'countered';

/** Runtime-checkable list of the closed `AskState` set, in canonical order. */
export const ASK_STATES: AskState[] = ['filed', 'accepted', 'rejected', 'countered'];

/**
 * A triage verdict the driver produces for a filed ask, passed to `respondAsk`.
 * The driver (a skill, a native Agent-tool subagent, or an `AskUserQuestion`
 * gate) makes the judgment; the CLI applies the verdict MECHANICALLY with no
 * model invocation. A closed set, one per terminal `AskState`:
 *
 *   accept  — create one child task under the to-team's tree, set the ask's
 *             `mapped_artifact` to it, and add a `blocked_by` dep from the
 *             from-team's blocking artifact onto the child. State → `accepted`.
 *   reject  — record `rejected_reason`; mutate nothing in the tree or deps.
 *             State → `rejected`.
 *   counter — record `counter_proposal`; mutate nothing in the tree or deps.
 *             State → `countered`.
 */
export type AskVerdict = 'accept' | 'reject' | 'counter';

/** Runtime-checkable list of the closed `AskVerdict` set, in canonical order. */
export const ASK_VERDICTS: AskVerdict[] = ['accept', 'reject', 'counter'];

/** The terminal `AskState` each verdict transitions a filed ask into. */
export const ASK_VERDICT_STATE: Record<AskVerdict, AskState> = {
  accept: 'accepted',
  reject: 'rejected',
  counter: 'countered',
};

/**
 * One row of the `scrum_asks` table (v23) — a single cross-team ask a worker
 * files against a sibling team. An ask is the request raised when work is blocked
 * on another team's published interface: `from_team` needs `to_team` to handle
 * `ask_type`, and `blocking_artifact` stays blocked until it does.
 *
 *   id                — AUTOINCREMENT surrogate.
 *   from_team         — the requesting team's slug, a `scrum_teams.slug`.
 *   to_team           — the target team's slug, a `scrum_teams.slug`. At filing
 *                       time `ask_type` MUST be one of this team's ACTIVE
 *                       `scrum_team_accepts` rows — a team can only be asked for
 *                       what it has published it accepts. Enforced at the store
 *                       boundary in `fileAsk`.
 *   ask_type          — the kebab-case interface type requested.
 *   blocking_artifact — the `scrum_tasks.id` of the artifact blocked on the ask;
 *                       the FK guarantees the cited artifact exists.
 *   state             — the ask lifecycle state (see `AskState`); a freshly-filed
 *                       ask is `'filed'`, and `respondAsk` discharges it to
 *                       `accepted` | `rejected` | `countered`.
 *   mapped_artifact   — the `scrum_tasks.id` of the child task created to satisfy
 *                       an ACCEPTED ask (v25); NULL while `filed` and on
 *                       reject/counter. A soft reference.
 *   rejected_reason   — the responder's rationale on a REJECTED ask (v25); NULL
 *                       otherwise.
 *   counter_proposal  — the responder's counter on a COUNTERED ask (v25); NULL
 *                       otherwise.
 *   created_at        — when the ask was filed (ISO-8601).
 */
export interface AskRow {
  id: number;
  from_team: string;
  to_team: string;
  ask_type: string;
  blocking_artifact: string;
  state: AskState;
  mapped_artifact: string | null;
  rejected_reason: string | null;
  counter_proposal: string | null;
  created_at: string;
}

/**
 * Input to `fileAsk` (v23). `fromTeam` and `toTeam` must both be registered
 * teams (guarded at the store boundary). `askType` MUST be one of `toTeam`'s
 * ACTIVE accepted ask types, and `blockingArtifact` MUST be an existing task id
 * — both are validated at the boundary, with each failure throwing a domain
 * error. `createdAt` defaults to now().
 */
export interface FileAskInput {
  fromTeam: string;
  toTeam: string;
  askType: string;
  blockingArtifact: string;
  /** ISO-8601 timestamp; defaults to now(). */
  createdAt?: string;
}

/**
 * Input to `respondAsk` (v25) — the MECHANICAL application of a triage verdict
 * the driver already produced. The store performs no judgment: it applies
 * `verdict` deterministically and spawns no model. `id` names a `filed` ask
 * (a non-`filed` ask is rejected — an ask is responded to exactly once).
 *
 *   id      — the `scrum_asks.id` to respond to; must be in state `filed`.
 *   verdict — the closed `AskVerdict` (accept | reject | counter), guarded at
 *             the boundary against the closed set.
 *   comment — verdict-specific free text: the `rejected_reason` on `reject`, the
 *             `counter_proposal` on `counter`. Ignored on `accept`. Optional.
 *   childTitle  — title for the child task created on `accept`; defaults to a
 *                 derived title naming the ask type. Ignored on reject/counter.
 *   childLayer  — containment tier of the `accept` child: `story` (the default)
 *                 or `epic`. Ignored on reject/counter.
 *   childId     — explicit id for the `accept` child; defaults to a generated id.
 *                 Ignored on reject/counter.
 *   respondedBy — who produced the verdict (recorded on the `ask_responded`
 *                 event for provenance). Optional.
 */
export interface RespondAskInput {
  id: number;
  verdict: AskVerdict;
  comment?: string | null;
  childTitle?: string;
  childLayer?: Extract<TaskLayer, 'epic' | 'story'>;
  childId?: string;
  respondedBy?: string | null;
  /** ISO-8601 timestamp; defaults to now(). */
  respondedAt?: string;
}

/**
 * The mechanical phase a filed ask is in when polled by `awaitAsk` — the closed
 * vocabulary the team-as-workflow-kind sugar branches on. A NON-terminal phase
 * (`pending`, `waiting`) means the calling script should poll again later; a
 * TERMINAL phase (`ready`, `rejected`, `countered`) means the step resolves now.
 * Derived purely from the ask's `state` plus, on `accepted`, its
 * `mapped_artifact` task's `status`; computing it spawns no model. New phases
 * extend this closed set via a schema-version bump, never a silent value.
 *
 *   pending   — the ask is still `filed`; the responder has not triaged it yet.
 *               NON-terminal: poll again.
 *   waiting   — the ask is `accepted` but its `mapped_artifact` child task has
 *               not reached `done`. NON-terminal: poll again.
 *   ready     — the ask is `accepted` AND its `mapped_artifact` child is `done`;
 *               the to-team's exposed outputs are available. TERMINAL (success).
 *   rejected  — the ask is `rejected`; `reason` carries the responder's
 *               `rejected_reason`. TERMINAL (the step surfaces the rejection,
 *               never hangs).
 *   countered — the ask is `countered`; `reason` carries the responder's
 *               `counter_proposal`. TERMINAL (the step surfaces the counter,
 *               never hangs).
 */
export type AskAwaitPhase = 'pending' | 'waiting' | 'ready' | 'rejected' | 'countered';

/** Runtime-checkable list of the closed `AskAwaitPhase` set, in canonical order. */
export const ASK_AWAIT_PHASES: AskAwaitPhase[] = [
  'pending',
  'waiting',
  'ready',
  'rejected',
  'countered',
];

/** The `AskAwaitPhase` values from which the team-as-workflow-kind step resolves. */
export const ASK_AWAIT_TERMINAL_PHASES: AskAwaitPhase[] = ['ready', 'rejected', 'countered'];

/**
 * The structured status report `awaitAsk` returns for one ask — the MECHANICAL
 * primitive the `kind:<team-slug>` workflow sugar composes. It reports whether a
 * filed ask has been responded to and, on accept, whether its mapped child has
 * reached `done`; on `ready` it carries the to-team's exposed outputs. A pure
 * read: computing the report spawns no model and never mutates. The driver
 * branches on `phase` — re-poll on a NON-terminal phase, resolve the step on a
 * TERMINAL one (return `outputs` on `ready`, surface `reason` on
 * `rejected`/`countered` so the calling script never hangs).
 *
 *   ask_id          — the polled `scrum_asks.id`.
 *   phase           — the closed `AskAwaitPhase` (see its doc).
 *   terminal        — true on `ready` | `rejected` | `countered`; false on
 *                     `pending` | `waiting`. The single boolean the calling loop
 *                     checks to stop polling.
 *   state           — the ask's current `AskState`, echoed for context.
 *   mapped_artifact — the accepted ask's child task id, or NULL when the ask is
 *                     not accepted.
 *   artifact_status — the `mapped_artifact` task's `TaskStatus` on `waiting` /
 *                     `ready`, else NULL. Distinguishes "child not done yet"
 *                     (`waiting`) from "child done" (`ready`).
 *   to_team         — the responding team's slug (the `exposes` owner).
 *   outputs         — the to-team's ACTIVE exposed outputs, present and populated
 *                     ONLY on `ready` (empty array on every other phase). This is
 *                     the value the `kind:<team-slug>` step returns.
 *   reason          — the responder's rationale on a TERMINAL non-success phase:
 *                     `rejected_reason` on `rejected`, `counter_proposal` on
 *                     `countered`. NULL otherwise. The surfaced terminal result
 *                     that prevents a silent hang.
 */
export interface AskAwaitReport {
  ask_id: number;
  phase: AskAwaitPhase;
  terminal: boolean;
  state: AskState;
  mapped_artifact: string | null;
  artifact_status: TaskStatus | null;
  to_team: string;
  outputs: TeamExposeRow[];
  reason: string | null;
}

/**
 * One row of the `scrum_lores` table (v19) — a single Lore entry, the
 * accumulated convention or wisdom a team writes down for itself. Readable by
 * all, written only by the team's current `tech_lead`. Append-only: a
 * correction is a NEW entry, never an edit to an existing one, so the full
 * history of what a team believed at each point survives.
 *
 *   id                    — AUTOINCREMENT surrogate.
 *   team_slug             — the owning team, a `scrum_teams.slug`.
 *   body                  — the entry's free-text content (a convention, a
 *                           lesson, a standing note).
 *   author_contributor_id — the writer's CT-UUID. A soft reference: it is NOT
 *                           enforced by a foreign key, matching how the roster
 *                           and operator history store their holders. The
 *                           authorship rule (this must be the team's current
 *                           tech_lead when one is seated) is enforced at the
 *                           store boundary in `recordLore`, not by a SQL
 *                           constraint.
 *   created_at            — when the entry was appended (ISO-8601).
 */
export interface LoreRow {
  id: number;
  team_slug: string;
  body: string;
  author_contributor_id: string;
  created_at: string;
}

/**
 * Input to `recordLore` (v19). `teamSlug` must be a registered team (guarded at
 * the store boundary). `authorContributorId` is the writer's CT-UUID — when the
 * team has a seated `tech_lead`, it MUST match that holder's contributor id, or
 * the write is rejected; when the slot is empty (team-of-one / bootstrapping),
 * the write is allowed with a warning. `createdAt` defaults to now().
 */
export interface RecordLoreInput {
  teamSlug: string;
  body: string;
  authorContributorId: string;
  /** ISO-8601 timestamp; defaults to now(). */
  createdAt?: string;
}

/**
 * The result of `recordLore` (v19): the newly-appended Lore entry plus an
 * optional bootstrapping warning. A WARNING (never a rejection) is emitted when
 * the team has NO current `tech_lead` seated — the team-of-one / bootstrapping
 * tolerance where the authorship guard cannot be checked. The write always
 * completes; the caller surfaces `warning` on stderr. When a tech_lead IS
 * seated and the author does not match, `recordLore` throws instead (the row is
 * never written).
 */
export interface RecordLoreResult {
  row: LoreRow;
  /** Set when the team had no seated tech_lead to author-check against. */
  warning: string | null;
}

/**
 * Input to `promoteLoreToCodex` (v22). Lifts one generally-applicable team Lore
 * entry into the Codex (`scrum_decisions`) as a gated DRAFT — a PROPOSAL, not an
 * acceptance. The promotion always routes through the gated write protocol: the
 * resulting decision lands `write_status = 'draft'` and becomes `accepted` only
 * when its write-gate is later approved (a separate human / tech_lead step). The
 * promotion never auto-approves.
 *
 *   loreId        — the `scrum_lores.id` to promote. Must exist (the FK target);
 *                   an unknown id throws.
 *   decisionId    — the id of the Codex decision to write. Deterministic ids let
 *                   a re-promotion upsert the same row rather than duplicating;
 *                   defaults to `lore-promotion-<team_slug>-<loreId>`.
 *   kind          — the Codex subtype to record under. A generalized team
 *                   convention defaults to `pattern` (a gated kind). Any value in
 *                   `GATED_DECISION_KINDS` keeps the draft gate; a non-gated kind
 *                   would bypass the gate, so the default stays gated.
 *   title         — the decision title. Defaults to a derived
 *                   `Promoted Lore from team <team_slug>`.
 *   recordedByAgent — provenance for who promoted; threaded to `recordDecision`.
 */
export interface PromoteLoreToCodexInput {
  loreId: number;
  decisionId?: string;
  kind?: string;
  title?: string;
  recordedByAgent?: string | null;
}

/**
 * The kind of artifact an Annotation is attached to. A closed set: an
 * Annotation hangs off a task, a team, or a decision. Matches the
 * `scrum_annotations.target_kind` column; the column carries no CHECK
 * constraint, so this union documents the canonical set and the store boundary
 * enforces it (`addAnnotation` rejects any value outside this list).
 *
 *   task     — the target_ref is a `scrum_tasks.id`.
 *   team     — the target_ref is a `scrum_teams.slug`.
 *   decision — the target_ref is a `scrum_decisions.id`.
 */
export type AnnotationTargetKind = 'task' | 'team' | 'decision';

/** Runtime-checkable list of the closed `AnnotationTargetKind` set. */
export const ANNOTATION_TARGET_KINDS: AnnotationTargetKind[] = ['task', 'team', 'decision'];

/**
 * A row in `scrum_annotations` (v20) — the Annotation memory layer. An
 * Annotation is the lightest layer: a per-artifact note captured during work,
 * visible to ANYONE reading the target, written by the artifact's owner. Unlike
 * Lore (team-scoped, tech_lead-gated), an Annotation hangs off a single target
 * artifact and carries no authorship gate beyond recording who wrote it.
 *
 *   id          — AUTOINCREMENT surrogate.
 *   target_kind — which artifact class the note attaches to (`task` | `team` |
 *                 `decision`). A closed enum, guarded at the store boundary.
 *   target_ref  — the specific target's identifier within that class: a task id,
 *                 a team slug, or a decision id. A SOFT reference — it spans
 *                 multiple tables by `target_kind`, so it carries NO foreign key
 *                 and the store does NOT verify the target row exists (matching
 *                 how `author_contributor_id` and the operator history hold their
 *                 referents without an FK).
 *   body        — the note's free-text content.
 *   author      — who wrote the note (an identifier — typically a CT-UUID).
 *                 Recorded, not gated: any author may annotate any target.
 *   created_at  — when the note was appended (ISO-8601).
 */
export interface AnnotationRow {
  id: number;
  target_kind: AnnotationTargetKind;
  target_ref: string;
  body: string;
  author: string;
  created_at: string;
}

/**
 * Input to `addAnnotation` (v20). `targetKind` must be a member of the closed
 * `AnnotationTargetKind` set (guarded at the store boundary). `targetRef` is a
 * soft reference — the store does NOT check that the target row exists.
 * `createdAt` defaults to now().
 */
export interface AddAnnotationInput {
  targetKind: AnnotationTargetKind;
  targetRef: string;
  body: string;
  author: string;
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
