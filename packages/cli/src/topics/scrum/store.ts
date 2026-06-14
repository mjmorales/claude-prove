/**
 * ScrumStore — typed CRUD + query surface over the scrum domain.
 *
 * Structural mirror of `packages/cli/src/topics/acb/store.ts::AcbStore`:
 *   - `openScrumStore(opts)` wraps `openStore` + `runMigrations` + `new ScrumStore(store)`
 *   - Methods are thin SQL wrappers; multi-row writes run inside a sqlite
 *     transaction (see `createTask`, `saveContextBundle`)
 *   - All row decoding happens at the public boundary — SELECTs return the
 *     domain row types from `./types`, never raw column bags.
 *
 * Schema registration is a side-effect of importing `./schemas`; this module
 * re-imports `ensureScrumSchemaRegistered` so opening a store after a
 * `clearRegistry()` test helper still works.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  type SqlParam,
  type Store,
  type StoreOptions,
  assertStoreSchemaCompatible,
  openStore,
  runMigrations,
  ulid,
  updateTaskStatus as updateTaskStatusViaService,
  withTx,
} from '@claude-prove/store';
import type { Database } from '@tursodatabase/database';
import { type AssertContext, type CriterionVerification, verifyCriterion } from './assert-grammar';
import {
  type BashVerifyResult,
  prepareAgentWorktree,
  verifyBashCriterion,
} from './criterion-verify';
import { globsOverlap } from './glob-overlap';
import { SCRUM_SCHEMA_VERSION, ensureScrumSchemaRegistered } from './schemas';

// Re-exported so registry-dependent consumers outside this package (the
// review-ui server's schema guard, cross-domain conformance tests) can
// re-land the scrum domain after a `clearRegistry()` without reaching into
// the unexported `./schemas` module path.
export { ensureScrumSchemaRegistered } from './schemas';
import type {
  Acceptance,
  AcceptanceCriterion,
  AcceptancePolicy,
  AcceptanceScope,
  AddAnnotationInput,
  AnnotationRow,
  AnnotationTargetKind,
  AskAwaitPhase,
  AskAwaitReport,
  AskRow,
  AskState,
  AskVerdict,
  Contributor,
  ContributorStatus,
  DecisionRow,
  DecisionWriteStatus,
  DepKind,
  EscalationAttributes,
  EscalationLayer,
  EscalationPayload,
  EscalationResolutionMode,
  EscalationRow,
  EscalationState,
  EscalationType,
  EventKind,
  FileAskInput,
  GateVerdict,
  LoreRow,
  Manifest,
  ManifestTeamEntry,
  MilestoneStatus,
  NextReadyRow,
  OperatorHistoryRow,
  PromoteLoreToCodexInput,
  Provenance,
  RaiseEscalationInput,
  RecordLoreInput,
  RecordLoreResult,
  ResolveEscalationInput,
  ResolveEscalationResult,
  RespondAskInput,
  RotateTeamMemberInput,
  RotateTeamMemberResult,
  ScrumContextBundle,
  ScrumDep,
  ScrumEvent,
  ScrumMilestone,
  ScrumRunLink,
  ScrumTag,
  ScrumTask,
  SetOperatorOfRecordInput,
  SupersedeLoreInput,
  SupersedeLoreResult,
  TaskBounds,
  TaskLayer,
  TaskStatus,
  Team,
  TeamAcceptRow,
  TeamExposeRow,
  TeamInterface,
  TeamInterfaceStatus,
  TeamLifetime,
  TeamMemberRow,
  TeamRole,
  TeamRoster,
  TeamScopeKind,
  TeamScopes,
  TeamStatus,
  TeamTerminateResult,
  TeamType,
  TeamWriteScopeConflict,
  VerificationVerdict,
} from './types';
import type { AddTeamExposeInput, CreateTeamInput } from './types';
import {
  ACCEPTANCE_SCOPES,
  ANNOTATION_TARGET_KINDS,
  ASK_AWAIT_TERMINAL_PHASES,
  ASK_VERDICTS,
  ASK_VERDICT_STATE,
  ESCALATION_CHAIN,
  ESCALATION_RESOLUTION_MODES,
  ESCALATION_TYPES,
  GATED_DECISION_KINDS,
  GATE_VERDICTS,
  TEAM_LIFETIMES,
  TEAM_ROLES,
  TEAM_TYPES,
  TECH_LEAD_REVIEW_KIND,
  VERIFICATION_VERDICTS,
  nextEscalationLayer,
} from './types';

/**
 * Resolved prepared-statement type for the async driver. Derived from the
 * public `Database.prepare()` surface — `prepare(sql)` returns a
 * `Promise<Statement>`, so `Awaited<ReturnType<...>>` yields the Statement
 * type without importing the driver's internal `database-common` module.
 */
type Statement = Awaited<ReturnType<Database['prepare']>>;

// ---------------------------------------------------------------------------
// Public openers
// ---------------------------------------------------------------------------

/**
 * Open a scrum store: resolves the unified prove.db, runs every pending
 * migration, and returns the wrapped `ScrumStore`. Pass `{ path: ':memory:' }`
 * in tests for isolation.
 */
export async function openScrumStore(opts: StoreOptions = {}): Promise<ScrumStore> {
  ensureScrumSchemaRegistered();
  const store = await openStore(opts);
  // Refuse a write-open against a legacy (pre-Turso-v1) or ahead store BEFORE
  // running migrations, so an incompatible store is never silently migrated or
  // written. A readonly open skips the guard — inspecting an old store is fine.
  if (!opts.readonly) {
    try {
      await assertStoreSchemaCompatible(store);
    } catch (err) {
      store.close();
      throw err;
    }
  }
  await runMigrations(store);
  return new ScrumStore(store);
}

// ---------------------------------------------------------------------------
// Input shapes for create methods
// ---------------------------------------------------------------------------

export interface CreateTaskInput {
  id: string;
  title: string;
  description?: string | null;
  status?: TaskStatus;
  milestoneId?: string | null;
  /**
   * Team binding (v27): the owning team's slug, or NULL/omitted for an unbound
   * task. When non-null, validated against the team registry — an unknown or
   * already-disbanded (`inactive`) team is rejected, mirroring the
   * `unknown milestone_id` guard so every caller (CLI or programmatic) gets the
   * same rejection at the store boundary.
   */
  teamSlug?: string | null;
  /** Containing task id (the tree). Validated to exist, like `milestoneId`. */
  parentId?: string | null;
  /** Containment tier; NULL = flat. */
  layer?: TaskLayer | null;
  /**
   * Acceptance criteria authored at create time. Validated for the
   * idempotent/policy invariant before insert. When omitted, the task gets no
   * criteria unless `parentId` carries inheritable ones (see
   * `inheritAcceptance`).
   */
  acceptance?: Acceptance | null;
  /**
   * Declared bounds authored at create time (v6). Validated for the
   * closed-top-level-key shape before insert. When omitted, the task's
   * `bounds_json` stays NULL (absent = unbounded).
   */
  bounds?: TaskBounds | null;
  createdByAgent?: string | null;
  /**
   * Executing-worker id of the creating write (v11). When omitted, the store
   * sources it from the run env (`PROVE_WORKER_ID`), defaulting NULL.
   */
  workerId?: string | null;
  /**
   * Orchestrator run slug the creating write happened under (v11). When
   * omitted, the store sources it from the run env (`PROVE_RUN_SLUG`),
   * defaulting NULL.
   */
  runId?: string | null;
  /** ISO-8601 timestamp; defaults to now(). */
  createdAt?: string;
  /** Initial tags to bind under the same transaction as the task row. */
  tags?: string[];
}

export interface CreateMilestoneInput {
  id: string;
  title: string;
  description?: string | null;
  targetState?: string | null;
  status?: MilestoneStatus;
  /** Initiative grouping label (v10); the tier above milestone. Omitted = NULL. */
  initiative?: string | null;
  /** ISO-8601 timestamp; defaults to now(). */
  createdAt?: string;
}

export interface AppendEventInput {
  taskId: string;
  kind: EventKind;
  payload?: unknown;
  agent?: string | null;
  /** ISO-8601 timestamp; defaults to now(). */
  ts?: string;
}

export interface LinkRunInput {
  taskId: string;
  runPath: string;
  branch?: string | null;
  slug?: string | null;
  /** ISO-8601 timestamp; defaults to now(). */
  linkedAt?: string;
}

export interface ListTasksOptions {
  status?: TaskStatus;
  milestoneId?: string | null;
  /** Exclude soft-deleted rows. Defaults to true. */
  excludeDeleted?: boolean;
}

export interface NextReadyOptions {
  milestoneId?: string;
  limit?: number;
  /** Unix-epoch seconds for the hotness calculation. Defaults to now(). */
  nowMs?: number;
}

/**
 * Input to `recordDecision`. `id` is the filename slug; `content` is the
 * raw markdown body. `content_sha` is derived from `content` at write
 * time, so callers do not supply it. Status defaults to `'accepted'`
 * per decision-record convention.
 */
export interface RecordDecisionInput {
  id: string;
  title: string;
  topic?: string | null;
  status?: string;
  content: string;
  sourcePath?: string | null;
  recordedByAgent?: string | null;
  /** Codex subtype (v8): `adr | glossary | pattern`. Omitted = untyped (NULL). */
  kind?: string | null;
}

/** Filter shape for `listDecisions`. All fields are optional and AND-combined. */
export interface ListDecisionsFilter {
  topic?: string;
  status?: string;
  /** Codex subtype filter (v8); case-insensitive, like `topic`/`status`. */
  kind?: string;
}

/**
 * Input to `registerContributor` (v12). `id` is derived (a CT-UUID minted from
 * `slug`) when omitted, so callers normally pass only `slug` plus the optional
 * resolution keys. Status defaults to `'active'`. Provenance is sourced from the
 * run env (`PROVE_AGENT`) when `createdBy` is omitted.
 */
export interface RegisterContributorInput {
  slug: string;
  /** Explicit CT-UUID; defaults to one derived from `slug`. */
  id?: string;
  status?: ContributorStatus;
  displayName?: string | null;
  /** GitHub handle — the primary resolution key. */
  github?: string | null;
  /** Email — the fallback resolution key. */
  email?: string | null;
  /** Agent that authored the registration; defaults to `PROVE_AGENT` else NULL. */
  createdBy?: string | null;
  /** ISO-8601 timestamp; defaults to now(). */
  createdAt?: string;
}

/**
 * Input to `reconcileContributor` — the merge half of an idempotent
 * re-register. `slug` keys the existing row. Field semantics differ from
 * registration: `undefined` means "preserve the stored value", a present value
 * overrides it. `id` never merges — when present it is an identity GUARD that
 * must match the stored CT-UUID (a mismatch throws), since the id is minted
 * once and never changed.
 */
export interface ReconcileContributorInput {
  slug: string;
  /** Identity guard — must equal the stored CT-UUID when present. */
  id?: string;
  status?: ContributorStatus;
  displayName?: string;
  github?: string;
  email?: string;
  /** Agent performing the reconcile; defaults to `PROVE_AGENT` else NULL. */
  modifiedBy?: string | null;
  /** ISO-8601 timestamp; defaults to now(). */
  modifiedAt?: string;
}

/**
 * Lookup key for `resolveContributor` (v12) — the executing worker / event
 * author to map onto a contributor. Resolution tries `github` first, then falls
 * back to `email`. At least one must be present; both absent resolves to null.
 */
export interface ResolveContributorKey {
  github?: string | null;
  email?: string | null;
}

/**
 * Canonical `scrum_tasks` column list, in declaration order. Every SELECT
 * routes through this so the `parent_id`/`layer`, `acceptance_policy_json`,
 * `bounds_json`, and `worker_id`/`run_id` columns stay in lockstep with the
 * `ScrumTaskRow` shape. The acceptance CRITERIA are normalized out into
 * `scrum_acceptance_criteria` (verdicts append-only in
 * `scrum_criterion_verdicts`); only the task-level acceptance POLICY rides the
 * task row as `acceptance_policy_json`. Raw rows carry
 * `acceptance_policy_json`/`bounds_json: string | null`; `decodeTask` joins the
 * hydrated criteria back onto the policy to rebuild the public
 * `ScrumTask.acceptance` object and assembles the `provenance` block.
 */
const TASK_COLUMNS =
  'id, title, description, status, milestone_id, team_slug, parent_id, layer, acceptance_policy_json, bounds_json, terminal_reason, terminal_detail, created_by_agent, created_at, last_event_at, last_modified_by, last_modified_at, worker_id, run_id, status_event_id, deleted_at';

/** `TASK_COLUMNS` qualified with the `t.` alias, for joins that disambiguate `scrum_tasks t`. */
const T_COLS = TASK_COLUMNS.split(', ')
  .map((c) => `t.${c}`)
  .join(', ');

/** Canonical `scrum_milestones` SELECT column list; includes the v10 `initiative` grouping. */
const MILESTONE_COLUMNS =
  'id, title, description, target_state, status, initiative, created_at, closed_at';

/** Canonical `scrum_contributors` SELECT column list (v12); maps 1:1 to `Contributor`. */
const CONTRIBUTOR_COLUMNS =
  'id, slug, status, display_name, github, email, created_by, created_at, last_modified_by, last_modified_at';

/** Canonical `scrum_operator_history` SELECT column list (v13); maps 1:1 to `OperatorHistoryRow`. */
const OPERATOR_HISTORY_COLUMNS = 'id, contributor_id, from_ts, to_ts, created_at, created_by';

/** Canonical `scrum_teams` SELECT column list (v14, +v18 lifecycle); maps 1:1 to `Team`. */
const TEAM_COLUMNS =
  'slug, team_type, charter, lifetime, terminates_on_milestone, status, created_at';

/** Canonical `scrum_team_members` SELECT column list (v16); maps 1:1 to `TeamMemberRow`. */
const TEAM_MEMBER_COLUMNS =
  'id, team_slug, role, contributor_id, from_ts, to_ts, reason, created_at';

/** Canonical `scrum_team_accepts` SELECT column list (v17); maps 1:1 to `TeamAcceptRow`. */
const TEAM_ACCEPT_COLUMNS = 'id, team_slug, ask_type, status, superseded_by, reason, created_at';

/** Canonical `scrum_team_exposes` SELECT column list (v17); maps 1:1 to `TeamExposeRow`. */
const TEAM_EXPOSE_COLUMNS =
  'id, team_slug, name, schema_ref, status, superseded_by, reason, created_at';

/** Canonical `scrum_asks` SELECT column list (v23 + v25); maps 1:1 to `AskRow`. */
const ASK_COLUMNS =
  'id, from_team, to_team, ask_type, blocking_artifact, state, mapped_artifact, rejected_reason, counter_proposal, created_at';

/** Canonical `scrum_lores` SELECT column list (v19); maps 1:1 to `LoreRow`. */
const LORE_COLUMNS =
  'id, team_slug, body, author_contributor_id, created_at, superseded_by, reason';

/**
 * The Codex subtype a Lore→Codex promotion defaults to (v22). A generalized team
 * convention reads as a `pattern` — a gated kind, so the promotion lands as a
 * DRAFT awaiting a human approve gate rather than a durably-accepted decision.
 * Routing through a gated kind is the whole point: a promotion PROPOSES, it never
 * silently accepts.
 */
const PROMOTION_DEFAULT_KIND = 'pattern';

/** Canonical `scrum_annotations` SELECT column list (v20); maps 1:1 to `AnnotationRow`. */
const ANNOTATION_COLUMNS = 'id, target_kind, target_ref, body, author, created_at';

/**
 * Canonical `scrum_escalations` SELECT column list (v24/v25). Maps to
 * `EscalationRowRaw` — the `attributes` column arrives as a JSON string|null and
 * is decoded into `EscalationRow.attributes` by `decodeEscalation`.
 */
const ESCALATION_COLUMNS =
  'id, task_id, escalation_type, layer, state, summary, raised_by, resolution_mode, resolution_note, resolved_by, walked_up_from, attributes, created_at, resolved_at';

/** Canonical `scrum_decisions` SELECT column list (v2/v4/v8/v21/v22); maps 1:1 to `DecisionRow`. */
const DECISION_COLUMNS =
  'id, title, topic, status, content, source_path, content_sha, recorded_at, recorded_by_agent, superseded_by, reason, kind, write_status, gate_responder, gate_responded_at, source_lore_id';

/**
 * Kebab-case ask-type format: one or more lowercase-alphanumeric segments
 * joined by single hyphens (e.g. `schema-change`, `api-review`, `db`). No
 * leading/trailing/double hyphens, no uppercase, no underscores. Validated at
 * the store boundary in `addTeamAccept` — `ask_type` carries no SQL constraint.
 */
const ASK_TYPE_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Raw `scrum_tasks` SELECT shape — identical to `ScrumTask` except the bounds
 * column arrives as its on-disk JSON string, the acceptance CRITERIA are NOT on
 * the row (they live in `scrum_acceptance_criteria`, hydrated separately) — only
 * the task-level acceptance POLICY rides as `acceptance_policy_json` — and the
 * derived `provenance` block is absent (assembled by `decodeTask`). `decodeTask`
 * is the sole bridge from this (plus the hydrated criteria) to the public
 * `ScrumTask`.
 */
type ScrumTaskRow = Omit<ScrumTask, 'acceptance' | 'bounds' | 'provenance'> & {
  acceptance_policy_json: string | null;
  bounds_json: string | null;
};

/**
 * Raw `scrum_acceptance_criteria` SELECT shape — the criterion DEFINITION. `id`
 * is the minted ULID surrogate PK (and the verdict-log FK target);
 * `criterion_id` is the author-given external id, unique only within a task.
 */
interface AcceptanceCriterionRow {
  id: string;
  task_id: string;
  criterion_id: string;
  ord: string;
  text: string;
  verifies_by: AcceptanceCriterion['verifies_by'];
  check_payload: string;
  status: AcceptanceCriterion['status'];
  idempotent: number;
  scope: string | null;
  timeout: string | null;
  superseded_by: string | null;
  reason: string | null;
  inherited_from: string | null;
}

/**
 * Raw `scrum_criterion_head` view row — the latest verdict per criterion. Its
 * `criterion_id` is the criterion-row SURROGATE id (`scrum_acceptance_criteria.id`),
 * not the external author id.
 */
interface CriterionHeadRow {
  criterion_id: string;
  channel: 'gate' | 'verification';
  verdict: string;
  reason: string | null;
  by_whom: string | null;
  comment: string | null;
  at: string;
}

/** Canonical `scrum_acceptance_criteria` SELECT column list. */
const ACCEPTANCE_CRITERION_COLUMNS =
  'id, task_id, criterion_id, ord, text, verifies_by, check_payload, status, idempotent, scope, timeout, superseded_by, reason, inherited_from';

// Tags that boost priority in nextReady ranking.
const PRIORITY_TAGS = new Set(['p0', 'p1', 'urgent', 'blocker']);

// Tags that suppress a task in nextReady ranking. Each contributes -1 to
// `tag_boost`, allowing deferred/blocked/wontfix work to net negative even
// when the task also carries a priority tag.
const DEFER_TAGS = new Set(['deferred', 'blocked', 'wontfix']);

// ---------------------------------------------------------------------------
// Acceptance verification — entry-point result shape
// ---------------------------------------------------------------------------

/**
 * Per-criterion outcome inside a `verifyTaskAcceptance` aggregate. `ok` is the
 * resolved pass/fail; `kind` echoes the criterion's `verifies_by`; `reason`
 * carries the failing detail (offending assert sub-expression, bash transcript
 * pointer, gate verdict, agent-pending note). A criterion that cannot be
 * decided in the calling context (a `bash` worktree run that was not requested,
 * or an `agent` judgment that stays driver-side) reports `ok: false` with
 * `pending: true` — unverified, NOT a confirmed failure.
 */
export interface CriterionResult {
  id: string;
  kind: AcceptanceCriterion['verifies_by'];
  ok: boolean;
  reason: string;
  /** True when the criterion is unresolved in this context (delegated/awaiting). */
  pending: boolean;
}

/**
 * Aggregate outcome of `verifyTaskAcceptance`. `ok` is true only when every
 * applicable criterion resolved `ok` (a `pending` criterion makes the aggregate
 * not-ok — an unverified goalpost is not a passed one). `results` carries the
 * per-criterion breakdown in evaluation order.
 */
export interface TaskAcceptanceResult {
  ok: boolean;
  results: CriterionResult[];
}

/**
 * Inputs `verifyTaskAcceptance` needs beyond the task id. All optional — what
 * is supplied determines which kinds can be decided in this call:
 *
 *   assertContext — the run/plan view an `assert` criterion evaluates against
 *                   (build it with `buildAssertContext`). Absent → `assert`
 *                   criteria report `pending` (no context to decide them).
 *   repoRoot      — repository path; required to run a `bash` criterion's
 *                   isolation worktree. Absent → `bash` criteria report
 *                   `pending`.
 *   storyHead     — the commit-ish a `bash`/`agent` worktree is cut from.
 *                   Absent → `bash`/`agent` criteria report `pending`.
 *   runDir        — directory a failing `bash` transcript is persisted under.
 *   record        — when true, each resolved heavy-kind (`assert`/`bash`)
 *                   outcome is STAMPED onto the criterion's `verification`
 *                   record so the close floor can later read it. The
 *                   orchestrator validation gate passes `record: true`.
 */
export interface VerifyTaskAcceptanceOptions {
  assertContext?: AssertContext;
  repoRoot?: string;
  storyHead?: string;
  runDir?: string;
  record?: boolean;
}

// ---------------------------------------------------------------------------
// ScrumStore class
// ---------------------------------------------------------------------------

/**
 * SQLite-backed CRUD + query surface for the scrum domain. Wraps a
 * `@claude-prove/store` `Store`; the underlying connection stays live
 * until `close()` is called.
 */
export class ScrumStore {
  private readonly store: Store;
  /**
   * Prepared-statement cache keyed by SQL text. Caches the `prepare()` PROMISE
   * (not the resolved Statement) so a hot SQL string is prepared exactly once:
   * the first caller seeds the async prepare, every later caller awaits the
   * same in-flight or settled promise. Re-preparing on each hot-path call would
   * cost a driver round-trip per node in graph walks like nextReady.
   */
  private readonly statements: Map<string, Promise<Statement>> = new Map();

  /**
   * Ambient write actor — the identity stamped into `created_by` /
   * `last_modified_by` / event `agent` columns when a write carries no
   * explicit agent. The CLI layer seeds it from the per-user project-root →
   * default-contributor mapping (`resolveDefaultContributor`) so cold CLI
   * writes attribute to the operator instead of landing permanent NULLs in
   * the append-only provenance. NULL (the default) keeps the store's
   * historical "unattributed" behavior for callers that never set it.
   */
  defaultActor: string | null = null;

  constructor(store: Store) {
    this.store = store;
  }

  /**
   * Resolve the actor for one write: explicit value → `PROVE_AGENT` run env →
   * `defaultActor` → NULL. Mirrors `resolveRunContext` (the worker/run
   * analog): empty strings read as unset at every tier.
   */
  private actor(explicit?: string | null): string | null {
    if (explicit !== undefined && explicit !== null && explicit.length > 0) return explicit;
    const env = process.env.PROVE_AGENT;
    if (env !== undefined && env.length > 0) return env;
    return this.defaultActor;
  }

  /** Close the underlying database connection. Idempotent. */
  close(): void {
    this.store.close();
  }

  /** Accessor for the wrapped store — for integration-test introspection. */
  getStore(): Store {
    return this.store;
  }

  /**
   * Run `fn` inside a single sqlite transaction, committing on return and
   * rolling back every write if `fn` throws. Lets a caller make a multi-method
   * sequence (e.g. the `scrum init` seed, many createTask/createMilestone
   * calls) atomic: a mid-sequence failure leaves the store untouched rather
   * than half-written. The inner per-method transactions nest as savepoints.
   */
  transaction<T>(fn: () => Promise<T>): Promise<T> {
    return withTx(this.store, fn);
  }

  // ==========================================================================
  // Tasks
  // ==========================================================================

  /**
   * Insert a task plus optional tags plus an initial `task_created` event
   * inside a single transaction. Throws if `milestoneId` is given but no
   * row with that id exists — the FK would accept it (sqlite doesn't
   * enforce FKs without `PRAGMA foreign_keys = ON`, which file-backed
   * stores set but `:memory:` does not).
   */
  async createTask(input: CreateTaskInput): Promise<ScrumTask> {
    const createdAt = input.createdAt ?? isoNow();
    const status: TaskStatus = input.status ?? 'backlog';
    const milestoneId = input.milestoneId ?? null;
    const parentId = input.parentId ?? null;
    const teamSlug = input.teamSlug ?? null;

    if (milestoneId !== null) {
      const exists = await this.getMilestone(milestoneId);
      if (!exists) {
        throw new Error(`createTask: unknown milestone_id '${milestoneId}'`);
      }
    }

    if (parentId !== null) {
      const parent = await this.getTask(parentId);
      if (!parent) {
        throw new Error(`createTask: unknown parent_id '${parentId}'`);
      }
    }

    if (teamSlug !== null) await this.assertBindableTeam('createTask', teamSlug);

    // Resolve acceptance: explicit input wins; otherwise inherit the parent's
    // shared_acceptance criteria (independent copies tagged `inherited_from`).
    // Validated for the idempotent/policy invariant before insert.
    const authored = input.acceptance ?? null;
    let acceptance: Acceptance | null = authored;
    if (authored === null && parentId !== null) {
      const inherited = await this.inheritAcceptance(parentId);
      acceptance = inherited.length > 0 ? { criteria: inherited } : null;
    }
    // Seed `gate_pending` on any gate-kind criterion that arrived without an
    // explicit gate state, so a fresh gate criterion always carries a resolvable
    // verdict. Idempotent on an already-stated gate.
    if (acceptance !== null) acceptance = withGateStatesSeeded(acceptance);
    if (acceptance !== null) validateAcceptance(acceptance);

    // Declared bounds (v6): explicit input only — never inherited. Validated
    // for the closed-top-level-key shape before insert; null = unbounded.
    const bounds = input.bounds ?? null;
    if (bounds !== null) validateBounds(bounds);

    // Executing-worker/run attribution (v11): explicit input wins, else the run
    // env the orchestrator exports at dispatch, else NULL.
    const { workerId, runId } = resolveRunContext({
      workerId: input.workerId,
      runId: input.runId,
    });
    const createdBy = this.actor(input.createdByAgent);

    const row: ScrumTask = {
      id: input.id,
      title: input.title,
      description: input.description ?? null,
      status,
      milestone_id: milestoneId,
      team_slug: teamSlug,
      parent_id: parentId,
      layer: input.layer ?? null,
      acceptance,
      bounds,
      terminal_reason: null,
      terminal_detail: null,
      created_by_agent: createdBy,
      created_at: createdAt,
      last_event_at: createdAt,
      // Seed last-touch provenance (v9) to the creation event so a fresh task
      // already reads coherently before its first mutation.
      last_modified_by: createdBy,
      last_modified_at: createdAt,
      worker_id: workerId,
      run_id: runId,
      // No transition has fired yet — the authored status is the creation status,
      // not one set by a status_changed event. The pointer is stamped on the
      // first transition (see updateTaskStatus), so a fresh task reads NULL.
      status_event_id: null,
      deleted_at: null,
      provenance: {
        created_by: createdBy,
        created_at: createdAt,
        last_modified_by: createdBy,
        last_modified_at: createdAt,
        worker_id: workerId,
        run_id: runId,
        schema_version: SCRUM_SCHEMA_VERSION,
      },
    };

    const tx = async () => {
      await this.exec(
        'INSERT INTO scrum_tasks (id, title, description, status, milestone_id, team_slug, parent_id, layer, acceptance_policy_json, bounds_json, created_by_agent, created_at, last_event_at, last_modified_by, last_modified_at, worker_id, run_id, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)',
        row.id,
        row.title,
        row.description,
        row.status,
        row.milestone_id,
        row.team_slug,
        row.parent_id,
        row.layer,
        acceptance?.policy ? JSON.stringify(acceptance.policy) : null,
        bounds === null ? null : JSON.stringify(bounds),
        row.created_by_agent,
        row.created_at,
        row.last_event_at,
        row.last_modified_by,
        row.last_modified_at,
        row.worker_id,
        row.run_id,
      );

      // Acceptance CRITERIA are normalized into their own table — insert each
      // criterion's DEFINITION row in authored array order. A fresh task carries
      // no verdicts; the gate seed (`gate_pending`) is a decode artifact, not a
      // verdict row, so nothing lands in scrum_criterion_verdicts here.
      for (const criterion of acceptance?.criteria ?? []) {
        await this.insertCriterionRow(row.id, criterion, createdAt);
      }

      if (input.tags && input.tags.length > 0) {
        const stmt = await this.prep(
          'INSERT INTO scrum_tags (task_id, tag, added_at) VALUES (?, ?, ?)',
        );
        for (const tag of input.tags) {
          await stmt.run(row.id, tag, createdAt);
        }
      }

      await this.exec(
        'INSERT INTO scrum_events (id, task_id, ts, kind, agent, payload_json) VALUES (?, ?, ?, ?, ?, ?)',
        ulid(),
        row.id,
        createdAt,
        'task_created',
        row.created_by_agent,
        JSON.stringify({ title: row.title }),
      );
    };
    await withTx(this.store, tx);

    return row;
  }

  /**
   * Decode a batch of raw task rows into public `ScrumTask`s, hydrating each
   * row's `acceptance` from the normalized criteria + head-verdict tables. The
   * hydration is BATCHED: it loads every criterion and head verdict for the
   * whole row set in two queries (not one per task), so a `listTasks`/`nextReady`
   * walk stays query-bounded rather than N+1. The criteria are grouped by
   * `task_id` and the head verdicts keyed by `criterion_id` in memory, then
   * `reconstructAcceptance` folds them onto each task's `policy` column.
   */
  private async hydrateRows(rows: ScrumTaskRow[]): Promise<ScrumTask[]> {
    if (rows.length === 0) return [];
    const taskIds = rows.map((r) => r.id);
    const criteriaByTask = await this.loadCriteriaByTask(taskIds);
    const headByCriterion = await this.loadHeadVerdicts(taskIds);
    return rows.map((row) =>
      decodeTask(
        row,
        reconstructAcceptance(
          criteriaByTask.get(row.id) ?? [],
          headByCriterion,
          row.acceptance_policy_json,
          row.id,
        ),
      ),
    );
  }

  /** Hydrate a single raw row (the one-task read path). */
  private async hydrateRow(row: ScrumTaskRow): Promise<ScrumTask> {
    const [task] = await this.hydrateRows([row]);
    if (!task) throw new Error(`hydrateRow: task '${row.id}' vanished mid-hydrate`);
    return task;
  }

  /**
   * Load every criterion DEFINITION row for the given task ids, grouped by
   * `task_id`. One query over an expanded placeholder list keeps the read
   * bounded regardless of the task count.
   */
  private async loadCriteriaByTask(
    taskIds: string[],
  ): Promise<Map<string, AcceptanceCriterionRow[]>> {
    const placeholders = taskIds.map(() => '?').join(', ');
    const rows = (await this.many(
      `SELECT ${ACCEPTANCE_CRITERION_COLUMNS} FROM scrum_acceptance_criteria WHERE task_id IN (${placeholders})`,
      ...taskIds,
    )) as AcceptanceCriterionRow[];
    const byTask = new Map<string, AcceptanceCriterionRow[]>();
    for (const row of rows) {
      const bucket = byTask.get(row.task_id);
      if (bucket) bucket.push(row);
      else byTask.set(row.task_id, [row]);
    }
    return byTask;
  }

  /**
   * Load the latest verdict per criterion (the criterion-head view) for every
   * criterion belonging to the given task ids, keyed by `criterion_id`. The join
   * to `scrum_acceptance_criteria` scopes the head read to just these tasks.
   */
  private async loadHeadVerdicts(taskIds: string[]): Promise<Map<string, CriterionHeadRow>> {
    const placeholders = taskIds.map(() => '?').join(', ');
    const rows = (await this.many(
      `SELECT h.criterion_id, h.channel, h.verdict, h.reason, h.by_whom, h.comment, h.at
       FROM scrum_criterion_head h
       INNER JOIN scrum_acceptance_criteria c ON c.id = h.criterion_id
       WHERE c.task_id IN (${placeholders})`,
      ...taskIds,
    )) as CriterionHeadRow[];
    const byCriterion = new Map<string, CriterionHeadRow>();
    for (const row of rows) byCriterion.set(row.criterion_id, row);
    return byCriterion;
  }

  /** Fetch one task by id, or null if missing or soft-deleted. */
  async getTask(id: string): Promise<ScrumTask | null> {
    const row = (await this.one(
      `SELECT ${TASK_COLUMNS} FROM scrum_tasks WHERE id = ? AND deleted_at IS NULL`,
      id,
    )) as ScrumTaskRow | null;
    return row ? await this.hydrateRow(row) : null;
  }

  /**
   * Fetch one task by id ignoring the soft-delete filter, or null if no row
   * physically exists. Unlike `getTask`, a soft-deleted row is still returned.
   * Used to distinguish "never existed" from "soft-deleted" so a unique
   * sentinel (see `ensureOrphanTask`) can be revived rather than re-inserted
   * into a PK conflict.
   */
  async getTaskIncludingDeleted(id: string): Promise<ScrumTask | null> {
    const row = (await this.one(
      `SELECT ${TASK_COLUMNS} FROM scrum_tasks WHERE id = ?`,
      id,
    )) as ScrumTaskRow | null;
    return row ? await this.hydrateRow(row) : null;
  }

  /** Clear `deleted_at`, reviving a soft-deleted task. No-op on a live row. */
  async undeleteTask(id: string): Promise<void> {
    await this.exec('UPDATE scrum_tasks SET deleted_at = NULL WHERE id = ?', id);
  }

  /**
   * List tasks with optional filters. Excludes soft-deleted rows unless
   * `excludeDeleted` is explicitly false.
   *
   * The composed SQL has a small, bounded set of distinct shapes (one per
   * filter combination). Each shape is routed through `prep()` so the
   * statement cache reuses the parsed plan across calls — matching the
   * caching discipline of every other method on this class.
   */
  async listTasks(options: ListTasksOptions = {}): Promise<ScrumTask[]> {
    const excludeDeleted = options.excludeDeleted !== false;
    const clauses: string[] = [];
    const params: (string | null)[] = [];

    if (excludeDeleted) clauses.push('deleted_at IS NULL');
    if (options.status !== undefined) {
      clauses.push('status = ?');
      params.push(options.status);
    }
    if (options.milestoneId !== undefined) {
      if (options.milestoneId === null) {
        clauses.push('milestone_id IS NULL');
      } else {
        clauses.push('milestone_id = ?');
        params.push(options.milestoneId);
      }
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const sql = `SELECT ${TASK_COLUMNS} FROM scrum_tasks ${where} ORDER BY created_at ASC`;
    return await this.hydrateRows((await this.many(sql, ...params)) as ScrumTaskRow[]);
  }

  /**
   * Update a task's status. Thin delegate to the `@claude-prove/store`
   * transition write-service, which is the single owner of the closed
   * transition table, both story-layer floors (acceptance presence/satisfaction
   * and synthesis-entry presence), and the in-transaction row update +
   * `status_changed` event emission.
   *
   * Actor resolution stays at this CLI boundary: the `agent` argument is the
   * already-resolved attribution the caller supplies, forwarded verbatim, and
   * the service stamps it (`agent ?? null`) — one attribution semantic across
   * both call paths. The service returns the narrow transition view; this
   * method re-reads the full decoded `ScrumTask` for callers that depend on
   * the wider shape.
   */
  async updateTaskStatus(id: string, next: TaskStatus, agent?: string | null): Promise<ScrumTask> {
    // Ambient-actor resolution (explicit -> PROVE_AGENT -> defaultActor ->
    // NULL) happens HERE so the shared service keeps its narrow `agent ?? null`
    // stamping while cold CLI writes still attribute to the mapped operator.
    await updateTaskStatusViaService(this.store, id, next, this.actor(agent));
    const updated = await this.getTask(id);
    if (!updated) throw new Error(`updateTaskStatus: task '${id}' vanished mid-update`);
    return updated;
  }

  /**
   * Reassign a task's milestone. Pass `null` to clear. Validates the target
   * milestone exists when non-null (same pattern as `createTask`). Appends a
   * `milestone_changed` event with payload `{ from, to }` inside the same
   * transaction and bumps `last_event_at`.
   *
   * Closed-milestone policy is intentionally *not* enforced here — callers
   * (CLI) are responsible for surfacing a warning so operators can re-open
   * closed milestones without fighting the store.
   */
  async updateTaskMilestone(
    id: string,
    nextMilestoneId: string | null,
    agent?: string | null,
  ): Promise<ScrumTask> {
    const task = await this.getTask(id);
    if (!task) throw new Error(`updateTaskMilestone: unknown task '${id}'`);

    if (nextMilestoneId !== null) {
      const target = await this.getMilestone(nextMilestoneId);
      if (!target) {
        throw new Error(`updateTaskMilestone: unknown milestone_id '${nextMilestoneId}'`);
      }
    }

    if (task.milestone_id === nextMilestoneId) {
      return task;
    }

    const ts = isoNow();
    const { workerId, runId } = resolveRunContext();
    const by = this.actor(agent);
    const tx = async () => {
      await this.exec(
        'UPDATE scrum_tasks SET milestone_id = ?, last_event_at = ?, last_modified_by = ?, last_modified_at = ?, worker_id = ?, run_id = ? WHERE id = ?',
        nextMilestoneId,
        ts,
        by,
        ts,
        workerId,
        runId,
        id,
      );
      await this.exec(
        'INSERT INTO scrum_events (id, task_id, ts, kind, agent, payload_json) VALUES (?, ?, ?, ?, ?, ?)',
        ulid(),
        id,
        ts,
        'milestone_changed',
        by,
        JSON.stringify({ from: task.milestone_id, to: nextMilestoneId }),
      );
    };
    await withTx(this.store, tx);

    const updated = await this.getTask(id);
    if (!updated) throw new Error(`updateTaskMilestone: task '${id}' vanished mid-update`);
    return updated;
  }

  /**
   * Reject binding a task to a team that cannot own work: an unknown slug or an
   * already-disbanded (`inactive`) team. Shared by `createTask` and
   * `updateTaskTeam` so the two write paths reject identically. `context` names
   * the caller for the thrown message.
   */
  private async assertBindableTeam(context: string, slug: string): Promise<void> {
    const team = await this.getTeam(slug);
    if (team === null) {
      throw new Error(`${context}: unknown team_slug '${slug}'`);
    }
    if (team.status === 'inactive') {
      throw new Error(`${context}: team '${slug}' is inactive (disbanded)`);
    }
  }

  /**
   * Reassign a task's owning team. Pass `null` to unbind. Validates the target
   * team is bindable when non-null (`assertBindableTeam` — same registry guard
   * `createTask` runs), so the move path and create path reject an unknown or
   * disbanded team identically. Appends a `team_changed` event with payload
   * `{ from, to }` inside the same transaction and bumps `last_event_at`.
   */
  async updateTaskTeam(
    id: string,
    nextTeamSlug: string | null,
    agent?: string | null,
  ): Promise<ScrumTask> {
    const task = await this.getTask(id);
    if (!task) throw new Error(`updateTaskTeam: unknown task '${id}'`);

    if (nextTeamSlug !== null) await this.assertBindableTeam('updateTaskTeam', nextTeamSlug);

    if (task.team_slug === nextTeamSlug) {
      return task;
    }

    const ts = isoNow();
    const { workerId, runId } = resolveRunContext();
    const by = this.actor(agent);
    const tx = async () => {
      await this.exec(
        'UPDATE scrum_tasks SET team_slug = ?, last_event_at = ?, last_modified_by = ?, last_modified_at = ?, worker_id = ?, run_id = ? WHERE id = ?',
        nextTeamSlug,
        ts,
        by,
        ts,
        workerId,
        runId,
        id,
      );
      await this.exec(
        'INSERT INTO scrum_events (id, task_id, ts, kind, agent, payload_json) VALUES (?, ?, ?, ?, ?, ?)',
        ulid(),
        id,
        ts,
        'team_changed',
        by,
        JSON.stringify({ from: task.team_slug, to: nextTeamSlug }),
      );
    };
    await withTx(this.store, tx);

    const updated = await this.getTask(id);
    if (!updated) throw new Error(`updateTaskTeam: task '${id}' vanished mid-update`);
    return updated;
  }

  /**
   * Soft-delete: stamp `deleted_at = now()`. Does not cascade to dependents.
   * Appends a `task_deleted` event inside the same transaction so the
   * append-only audit log records the retirement —
   * matching createTask/updateTaskStatus/updateTaskMilestone, which all emit
   * an event under their write. Without this the events table — the sole
   * audit + reconcile signal — would have no trace of when a task was retired.
   */
  async softDeleteTask(id: string): Promise<void> {
    const task = await this.getTask(id);
    if (!task) throw new Error(`softDeleteTask: unknown task '${id}'`);

    const ts = isoNow();
    const { workerId, runId } = resolveRunContext();
    const by = this.actor();
    const tx = async () => {
      await this.exec(
        'UPDATE scrum_tasks SET deleted_at = ?, last_modified_by = ?, last_modified_at = ?, worker_id = ?, run_id = ? WHERE id = ?',
        ts,
        by,
        ts,
        workerId,
        runId,
        id,
      );
      await this.exec(
        'INSERT INTO scrum_events (id, task_id, ts, kind, agent, payload_json) VALUES (?, ?, ?, ?, ?, ?)',
        ulid(),
        id,
        ts,
        'task_deleted',
        by,
        JSON.stringify({ status: task.status }),
      );
    };
    await withTx(this.store, tx);
  }

  // ==========================================================================
  // Cancellation + terminal provenance (v7)
  // ==========================================================================

  /**
   * Cancel a single task, recording terminal provenance. Throws on an unknown
   * id or an already-terminal task (`done`/`cancelled`) — the same closed-edge
   * discipline `updateTaskStatus` enforces. `reason` defaults to `'cancelled'`;
   * `detail` is free-text elaboration (NULL when omitted). Emits a
   * `status_changed` event whose payload carries the terminal fields.
   */
  async cancelTask(
    id: string,
    opts: { reason?: string; detail?: string | null; agent?: string | null } = {},
  ): Promise<ScrumTask> {
    const task = await this.getTask(id);
    if (!task) throw new Error(`cancelTask: unknown task '${id}'`);
    if (task.status === 'done' || task.status === 'cancelled') {
      throw new Error(`cancelTask: task '${id}' is already terminal ('${task.status}')`);
    }
    await this.transaction(async () => {
      await this.cancelOne(
        id,
        opts.reason ?? 'cancelled',
        opts.detail ?? null,
        this.actor(opts.agent),
      );
    });
    return await this.requireTask(id, 'cancelTask');
  }

  /**
   * Cancel a task and recursively cancel every non-terminal descendant in its
   * `parent_id` subtree, in one transaction. The root
   * carries `terminal_reason = reason ?? 'cancelled'`; descendants carry
   * `terminal_reason = 'parent_cancelled'` with a detail naming the root.
   *
   * Already-terminal nodes (`done`/`cancelled`) are left untouched but their
   * children are still visited — a completed mid-tree task does not shield its
   * unfinished descendants from the sweep. A malformed `parent_id` cycle is
   * guarded by a `visited` set. Returns the ids actually transitioned.
   */
  async cancelTaskCascade(
    rootId: string,
    opts: { reason?: string; detail?: string | null; agent?: string | null } = {},
  ): Promise<{ cancelled: string[] }> {
    const root = await this.getTask(rootId);
    if (!root) throw new Error(`cancelTaskCascade: unknown task '${rootId}'`);

    const cancelled: string[] = [];
    const agent = this.actor(opts.agent);
    const childDetail = `parent '${rootId}' cancelled`;

    // Fetch the whole subtree once; the DFS below walks the adjacency map in
    // memory rather than issuing one getChildren SELECT per node.
    const childrenOf = await this.fetchSubtreeChildren(rootId);

    await this.transaction(async () => {
      if (await this.cancelOne(rootId, opts.reason ?? 'cancelled', opts.detail ?? null, agent)) {
        cancelled.push(rootId);
      }
      const visited = new Set<string>([rootId]);
      const stack = (childrenOf.get(rootId) ?? []).map((c) => c.id);
      while (stack.length > 0) {
        const id = stack.pop();
        if (id === undefined || visited.has(id)) continue;
        visited.add(id);
        if (await this.cancelOne(id, 'parent_cancelled', childDetail, agent)) {
          cancelled.push(id);
        }
        for (const child of childrenOf.get(id) ?? []) stack.push(child.id);
      }
    });

    return { cancelled };
  }

  /**
   * Cancel one task in place if it is non-terminal, writing terminal
   * provenance and a `status_changed` event. Returns true when it transitioned,
   * false when the task was missing or already terminal. Must run inside a
   * caller-owned transaction (see `cancelTask`/`cancelTaskCascade`).
   */
  private async cancelOne(
    id: string,
    reason: string,
    detail: string | null,
    agent: string | null,
  ): Promise<boolean> {
    const task = await this.getTask(id);
    if (!task) return false;
    if (task.status === 'done' || task.status === 'cancelled') return false;

    const ts = isoNow();
    const { workerId, runId } = resolveRunContext();
    // Cancel is a status transition, so it stamps `status_event_id` with the id
    // of the status_changed event it appends — same provenance invariant the
    // service-level transition enforces. The event INSERT runs first so the
    // pointer's FK target onto scrum_events(id) already exists at UPDATE time.
    const statusEventId = ulid();
    await this.exec(
      'INSERT INTO scrum_events (id, task_id, ts, kind, agent, payload_json) VALUES (?, ?, ?, ?, ?, ?)',
      statusEventId,
      id,
      ts,
      'status_changed',
      agent,
      JSON.stringify({
        from: task.status,
        to: 'cancelled',
        terminal_reason: reason,
        terminal_detail: detail,
      }),
    );
    await this.exec(
      'UPDATE scrum_tasks SET status = ?, status_event_id = ?, terminal_reason = ?, terminal_detail = ?, last_event_at = ?, last_modified_by = ?, last_modified_at = ?, worker_id = ?, run_id = ? WHERE id = ?',
      'cancelled',
      statusEventId,
      reason,
      detail,
      ts,
      agent,
      ts,
      workerId,
      runId,
      id,
    );
    return true;
  }

  // ==========================================================================
  // Containment tree (v3) — parent_id hierarchy + derived status rollup
  // ==========================================================================

  /**
   * Direct children of `taskId` via `parent_id`, ordered by `created_at` ASC.
   * Excludes soft-deleted rows. Returns `[]` for a leaf or unknown id —
   * callers treat both the same.
   */
  async getChildren(taskId: string): Promise<ScrumTask[]> {
    return await this.hydrateRows(
      (await this.many(
        `SELECT ${TASK_COLUMNS} FROM scrum_tasks WHERE parent_id = ? AND deleted_at IS NULL ORDER BY created_at ASC`,
        taskId,
      )) as ScrumTaskRow[],
    );
  }

  /**
   * Build a `parent_id → children` adjacency map over every live task in ONE
   * round-trip, with each child list ordered by `created_at ASC` (soft-deleted
   * rows excluded by the SELECT). Both the derived-status fold and the cancel
   * cascade walk this map in memory from a root, so they touch only the rows in
   * that subtree while the query count stays bounded at 1 — not one
   * `getChildren` SELECT per node. The driver engine has no recursive-CTE
   * support, so the subtree is reconstructed in memory rather than walked in
   * SQL. `rootId` is accepted for call-site symmetry; the map spans the whole
   * forest, and a walk from `rootId` visits exactly its descendants.
   */
  private async fetchSubtreeChildren(_rootId: string): Promise<Map<string, ScrumTask[]>> {
    const rows = (await this.many(
      `SELECT ${TASK_COLUMNS} FROM scrum_tasks WHERE deleted_at IS NULL ORDER BY created_at ASC`,
    )) as ScrumTaskRow[];

    const byParent = new Map<string, ScrumTask[]>();
    for (const row of await this.hydrateRows(rows)) {
      const parent = row.parent_id;
      if (parent === null) continue;
      const bucket = byParent.get(parent);
      // Rows arrive `created_at ASC`, so append preserves the ordering
      // `getChildren` guaranteed without a second in-memory sort.
      if (bucket) bucket.push(row);
      else byParent.set(parent, [row]);
    }
    return byParent;
  }

  /**
   * Status of `taskId` rolled up from its subtree. Computed,
   * never stored. A leaf (no live children) returns its authored status, so
   * flat tasks behave exactly as a single self-status read. A parent folds its children's
   * DERIVED statuses post-order by precedence:
   *
   *   in_progress — any child derives in_progress
   *   blocked     — any child blocked AND none in_progress
   *   done        — ≥1 non-cancelled child AND every non-cancelled child done
   *   review      — any child review
   *   ready       — any child ready
   *   accepted    — any child accepted (decomposition review passed)
   *   proposed    — any child proposed (decomposed, awaiting review)
   *   backlog     — otherwise (incl. all-cancelled subtree)
   *
   * Cancelled children are excluded from the `done` quorum so a fully
   * cancelled subtree never reads as done. Recursion is invocation-scoped;
   * a `visited` set guards a malformed `parent_id` cycle (returns the
   * authored status for the re-entered node rather than recursing forever).
   */
  async derivedStatus(taskId: string): Promise<TaskStatus> {
    const task = await this.getTask(taskId);
    if (!task) throw new Error(`derivedStatus: unknown task '${taskId}'`);
    // One query fetches the whole subtree; the recursive fold then runs in
    // memory off the adjacency map — no per-node round-trip.
    const childrenOf = await this.fetchSubtreeChildren(taskId);
    return this.rollupStatus(task, childrenOf, new Set<string>());
  }

  /**
   * Post-order fold backing `derivedStatus`, computed entirely in memory off a
   * pre-fetched `parent_id → children` map. `visited` carries the ancestor
   * chain on the current DFS path; re-entering a node (a parent_id cycle)
   * short-circuits to its authored status instead of recursing.
   */
  private rollupStatus(
    task: ScrumTask,
    childrenOf: Map<string, ScrumTask[]>,
    visited: Set<string>,
  ): TaskStatus {
    if (visited.has(task.id)) return task.status;
    visited.add(task.id);

    const children = childrenOf.get(task.id) ?? [];
    if (children.length === 0) {
      visited.delete(task.id);
      return task.status;
    }

    const childStatuses = children.map((child) => this.rollupStatus(child, childrenOf, visited));
    visited.delete(task.id);
    return foldChildStatuses(childStatuses);
  }

  // ==========================================================================
  // Acceptance criteria (v5) — append-only, never hard-delete
  //
  // This module lands the data model + authoring surface. Verification
  // dispatches by `verifies_by` via `verifyCriterion` in `./assert-grammar`:
  // bash→validators, assert→in-process expression evaluator, gate→AskUserQuestion,
  // agent→validation-agent. Only `assert` is decided in-process (the engine owns
  // the closed grammar); the other three delegate to channels the driver session
  // owns.
  //
  // The `gate` channel is the one whose decision the engine PERSISTS but does
  // not make: a gate criterion carries a `gate.verdict` (gate_pending → approved
  // | rejected) resolved PULL-based via `respondGate` (the human approve/reject
  // is the judgment). The verdict is standing state on the criterion — there is
  // never a daemon blocking the engine waiting for the human to decide.
  // ==========================================================================

  /**
   * Replace a task's entire acceptance object. Validates the
   * idempotent/policy invariant: `parallel` eval_order or
   * `failed_only` rerun_policy require every criterion to be
   * `idempotent: true`. Throws on an unknown task id. Pass `null` to clear.
   */
  async setAcceptance(taskId: string, acceptance: Acceptance | null): Promise<ScrumTask> {
    const task = await this.getTask(taskId);
    if (!task) throw new Error(`setAcceptance: unknown task '${taskId}'`);
    const seeded = acceptance === null ? null : withGateStatesSeeded(acceptance);
    if (seeded !== null) validateAcceptance(seeded);
    await this.writeAcceptance(taskId, seeded);
    return await this.requireTask(taskId, 'setAcceptance');
  }

  /**
   * Append one criterion to a task's acceptance list. Creates
   * the acceptance object if the task had none. Rejects a duplicate criterion
   * id and re-validates the idempotent/policy invariant against any existing
   * policy. A TARGETED insert (not a whole-list rewrite) so every existing
   * criterion keeps its surrogate row and append-only verdict history.
   */
  async addCriterion(taskId: string, criterion: AcceptanceCriterion): Promise<ScrumTask> {
    const task = await this.getTask(taskId);
    if (!task) throw new Error(`addCriterion: unknown task '${taskId}'`);
    assertAcceptanceUnfrozen(task, 'addCriterion');
    const current = task.acceptance;
    const criteria = current ? [...current.criteria] : [];
    if (criteria.some((c) => c.id === criterion.id)) {
      throw new Error(`addCriterion: duplicate criterion id '${criterion.id}' on task '${taskId}'`);
    }
    // Validate the WHOLE resulting acceptance (the new criterion against any
    // existing policy / scope-enum guard) before persisting just the new row.
    const seeded = withGateStatesSeeded(
      current?.policy
        ? { criteria: [...criteria, criterion], policy: current.policy }
        : { criteria: [...criteria, criterion] },
    );
    validateAcceptance(seeded);
    const seededCriterion = seeded.criteria[seeded.criteria.length - 1] as AcceptanceCriterion;
    await this.transaction(async () => {
      await this.insertCriterionRow(taskId, seededCriterion, isoNow());
      await this.bumpTaskTouch(taskId);
    });
    return await this.requireTask(taskId, 'addCriterion');
  }

  /**
   * Supersede a criterion (append-only). Flips its `status` to `'superseded'`,
   * records `reason`, and optionally points `superseded_by` at a replacement
   * criterion id. Never removes the row — the retired criterion stays for audit,
   * mirroring `supersedeDecision`. A TARGETED UPDATE of the one criterion's
   * definition row, leaving its surrogate and verdict history intact. Rejects
   * unknown task/criterion ids and an already-superseded criterion.
   */
  async supersedeCriterion(
    taskId: string,
    criterionId: string,
    reason: string,
    supersededBy?: string | null,
  ): Promise<ScrumTask> {
    const task = await this.getTask(taskId);
    if (!task) throw new Error(`supersedeCriterion: unknown task '${taskId}'`);
    assertAcceptanceUnfrozen(task, 'supersedeCriterion');
    if (!task.acceptance) {
      throw new Error(`supersedeCriterion: task '${taskId}' has no acceptance criteria`);
    }
    const target = task.acceptance.criteria.find((c) => c.id === criterionId);
    if (!target) {
      throw new Error(`supersedeCriterion: unknown criterion '${criterionId}' on task '${taskId}'`);
    }
    if (target.status === 'superseded') {
      throw new Error(`supersedeCriterion: criterion '${criterionId}' is already superseded`);
    }

    await this.transaction(async () => {
      await this.exec(
        'UPDATE scrum_acceptance_criteria SET status = ?, reason = ?, superseded_by = ? WHERE task_id = ? AND criterion_id = ?',
        'superseded',
        reason,
        supersededBy ?? null,
        taskId,
        criterionId,
      );
      await this.bumpTaskTouch(taskId);
    });
    return await this.requireTask(taskId, 'supersedeCriterion');
  }

  /**
   * Bump a task's last-touch provenance (`last_modified_*` + executing
   * worker/run) after a criterion-table write that does not itself go through
   * the task-row UPDATE in `writeAcceptance`. Mirrors that write's attribution.
   */
  private async bumpTaskTouch(taskId: string): Promise<void> {
    const { workerId, runId } = resolveRunContext();
    await this.exec(
      'UPDATE scrum_tasks SET last_modified_by = ?, last_modified_at = ?, worker_id = ?, run_id = ? WHERE id = ?',
      this.actor(),
      isoNow(),
      workerId,
      runId,
      taskId,
    );
  }

  /**
   * Resolve a `gate`-kind criterion's verdict — the mechanical half of the human
   * approve/reject decision. APPENDS a `gate`-channel verdict row (the criterion
   * head then reads `approved`/`rejected` with the human `responder` and optional
   * `comment`) and appends a `gate_responded` event so the responder is recorded
   * in the append-only audit log. The verdict is an append, not a mutation: a
   * re-decision would land another row, so the gate is guarded to resolve once
   * (supersede the criterion to re-decide).
   *
   * This is PULL-based resolution: a session (an interactive `AskUserQuestion`
   * turn, the `scrum gate respond` CLI, or a session-start surfacing of pending
   * gates) calls in to record the verdict. It NEVER blocks waiting for input.
   *
   * Rejects, as domain errors:
   *   - unknown task / criterion id
   *   - a non-`gate` criterion (only gate-kind carries a verdict)
   *   - an already-resolved gate (verdict no longer `gate_pending`) — the gate
   *     is decided once; re-deciding requires superseding the criterion
   *   - a `verdict` outside the closed `approved | rejected` respond set
   */
  async respondGate(
    taskId: string,
    criterionId: string,
    verdict: 'approved' | 'rejected',
    opts: { responder: string; comment?: string | null } = { responder: '' },
  ): Promise<ScrumTask> {
    if (verdict !== 'approved' && verdict !== 'rejected') {
      throw new Error(
        `respondGate: invalid verdict '${verdict}'; expected one of: approved, rejected`,
      );
    }
    const task = await this.getTask(taskId);
    if (!task) throw new Error(`respondGate: unknown task '${taskId}'`);
    if (!task.acceptance) {
      throw new Error(`respondGate: task '${taskId}' has no acceptance criteria`);
    }
    const target = task.acceptance.criteria.find((c) => c.id === criterionId);
    if (!target) {
      throw new Error(`respondGate: unknown criterion '${criterionId}' on task '${taskId}'`);
    }
    if (target.verifies_by !== 'gate') {
      throw new Error(
        `respondGate: criterion '${criterionId}' is verifies_by '${target.verifies_by}', not 'gate'`,
      );
    }
    const current = target.gate?.verdict ?? 'gate_pending';
    if (current !== 'gate_pending') {
      throw new Error(
        `respondGate: gate criterion '${criterionId}' is already resolved ('${current}'); supersede it to re-decide`,
      );
    }

    const respondedAt = isoNow();
    const responder = opts.responder.length > 0 ? opts.responder : null;
    const comment = opts.comment && opts.comment.length > 0 ? opts.comment : null;

    // Single transaction: APPEND the gate verdict (never mutate the criterion)
    // AND record the human responder as the verification contributor in the
    // append-only event log.
    await this.transaction(async () => {
      await this.appendCriterionVerdict(
        taskId,
        criterionId,
        'gate',
        verdict,
        { by: responder, comment },
        respondedAt,
      );
      await this.appendEvent({
        taskId,
        kind: 'gate_responded',
        agent: responder,
        payload: { criterion_id: criterionId, verdict, responder, comment },
      });
    });
    return await this.requireTask(taskId, 'respondGate');
  }

  // ==========================================================================
  // Acceptance verification — the capstone caller of the kind primitives
  //
  // `verifyTaskAcceptance` is the single "verify a task's acceptance" entry
  // point. It selects the criteria that APPLY to the task — honoring `scope`,
  // so a `descendants`-scoped criterion is a goalpost for the subtree, NOT for
  // the parent it was authored on — and dispatches each by kind, reusing the
  // existing primitives (never reimplementing assert eval / worktree exec / gate
  // logic):
  //
  //   assert → evaluateAssert over the run/plan AssertContext (in-process)
  //   gate   → criterionSatisfied (the persisted human verdict)
  //   bash   → verifyBashCriterion (a write-isolated ephemeral worktree)
  //   agent  → prepareAgentWorktree (the model judgment stays driver-side; the
  //            engine prepares the isolated tree and reports the criterion
  //            pending — it never invokes a model here)
  //
  // Close-floor vs orchestrator-gate division (a store-level close floor CANNOT
  // run git-worktree bash, and has no run context for an assert expression):
  //
  //   - The CHEAP, context-free kind — `gate` — is enforced directly at the
  //     close floor via `criterionSatisfied` (it reads standing human verdict
  //     state, needing neither git nor run context).
  //   - The HEAVY/context-bearing kinds — `bash` (needs git) and `assert`
  //     (needs the run/plan context) — are run by `verifyTaskAcceptance` at the
  //     orchestrator validation gate, which HAS both. The gate passes
  //     `record: true` so each outcome is STAMPED onto the criterion's
  //     `verification` record. The close floor then READS that recorded verdict
  //     rather than re-running the worktree it cannot run. `agent` is judged
  //     driver-side and its verdict is recorded the same way once the model
  //     reports.
  // ==========================================================================

  /**
   * Verify the acceptance criteria that APPLY to `taskId`, dispatching each by
   * `verifies_by` and aggregating to `{ ok, results }`. Scope selection:
   * `self`/`both`/absent criteria apply to the task itself; a `descendants`
   * criterion does NOT (it is the subtree's goalpost, satisfied on the children
   * that inherited it, not on the parent). Superseded criteria are skipped.
   *
   * Per kind: `assert` evaluates in-process against `opts.assertContext`;
   * `gate` reads the persisted human verdict (`criterionSatisfied`); `bash`
   * runs in a write-isolated worktree (`opts.repoRoot`/`opts.storyHead`
   * required); `agent` prepares the isolation worktree but reports `pending`
   * (the model judgment stays driver-side — this never calls a model). A kind
   * that lacks the inputs to decide it in this call reports `pending`, which
   * makes the aggregate not-ok (an unverified goalpost is not a passed one).
   *
   * When `opts.record` is set, each resolved heavy-kind (`assert`/`bash`)
   * outcome is stamped onto the criterion's `verification` record so the close
   * floor can read it later. `gate` is never stamped here — its decision lives
   * in `gate.verdict`. Throws on an unknown task id.
   */
  async verifyTaskAcceptance(
    taskId: string,
    opts: VerifyTaskAcceptanceOptions = {},
  ): Promise<TaskAcceptanceResult> {
    const task = await this.getTask(taskId);
    if (!task) throw new Error(`verifyTaskAcceptance: unknown task '${taskId}'`);

    const applicable = (task.acceptance?.criteria ?? []).filter(
      (c) => c.status === 'active' && appliesToSelf(c.scope),
    );

    const results: CriterionResult[] = [];
    for (const criterion of applicable) {
      const result = await this.verifyOneCriterion(taskId, criterion, opts);
      results.push(result);
    }
    return { ok: results.every((r) => r.ok), results };
  }

  /**
   * Dispatch one criterion by kind and return its `CriterionResult`. Reuses the
   * kind primitives verbatim; the heavy kinds (`assert`/`bash`) are recorded
   * onto the criterion's `verification` field when `opts.record` is set so the
   * close floor can read the verdict.
   */
  private async verifyOneCriterion(
    taskId: string,
    criterion: AcceptanceCriterion,
    opts: VerifyTaskAcceptanceOptions,
  ): Promise<CriterionResult> {
    const kind = criterion.verifies_by;
    switch (kind) {
      case 'gate': {
        // The persisted human verdict — no run context, no git, no recording.
        const ok = criterionSatisfied(criterion);
        const verdict = criterion.gate?.verdict ?? 'gate_pending';
        const pending = verdict === 'gate_pending';
        return { id: criterion.id, kind, ok, pending, reason: pending ? '' : `gate ${verdict}` };
      }
      case 'assert': {
        if (!opts.assertContext) {
          return pendingResult(criterion, kind, 'assert: no run/plan context supplied');
        }
        // In-process closed-grammar eval via the shared verifyCriterion dispatch.
        const verification: CriterionVerification = verifyCriterion(criterion, opts.assertContext);
        const reason = verification.ok ? '' : verification.reason;
        if (opts.record)
          await this.recordCriterionVerdict(taskId, criterion.id, verification.ok, reason);
        return { id: criterion.id, kind, ok: verification.ok, pending: false, reason };
      }
      case 'bash': {
        if (!opts.repoRoot || !opts.storyHead) {
          return pendingResult(
            criterion,
            kind,
            'bash: no repo/story-head supplied to run worktree',
          );
        }
        const run: BashVerifyResult = await verifyBashCriterion(criterion, {
          repoRoot: opts.repoRoot,
          storyHead: opts.storyHead,
          runDir: opts.runDir,
        });
        const reason = run.ok
          ? ''
          : `bash exit ${run.exitCode}${run.timedOut ? ' (timed out)' : ''}${run.transcriptPath ? ` — ${run.transcriptPath}` : ''}`;
        if (opts.record) await this.recordCriterionVerdict(taskId, criterion.id, run.ok, reason);
        return { id: criterion.id, kind, ok: run.ok, pending: false, reason };
      }
      case 'agent': {
        // The model judgment stays driver-side. The engine only prepares the
        // isolated read surface; the criterion is pending until the driver
        // records the verdict via `recordCriterionVerdict`.
        if (opts.repoRoot && opts.storyHead) {
          const wt = prepareAgentWorktree(criterion, opts.repoRoot, opts.storyHead);
          wt.cleanup();
        }
        return pendingResult(criterion, kind, 'agent: judged driver-side (delegated)');
      }
      default: {
        const exhaustive: never = kind;
        throw new Error(`verifyTaskAcceptance: unknown verifies_by '${String(exhaustive)}'`);
      }
    }
  }

  /**
   * Stamp a recorded verification verdict onto a criterion's `verification`
   * field (append-style in-place, like `respondGate` for `gate`). Two callers:
   * the orchestrator validation gate records `assert`/`bash` outcomes inline,
   * and `scrum task acceptance verify` records the driver-side `agent` (or any
   * heavy-kind) verdict out-of-turn — both so the close floor can later read
   * `verified`/`failed` without re-running the check. `ok` maps to
   * `verified`/`failed`. `verified_by` is the verification contributor of
   * record: the explicit `verifiedBy` (the CLI's `--by`) when given, else the
   * run env (`PROVE_WORKER_ID`), else NULL. Rejects unknown task/criterion ids
   * and a `gate`-kind criterion (whose verdict lives in `gate.verdict`).
   */
  async recordCriterionVerdict(
    taskId: string,
    criterionId: string,
    ok: boolean,
    reason: string | null = null,
    verifiedBy?: string | null,
  ): Promise<ScrumTask> {
    const task = await this.getTask(taskId);
    if (!task) throw new Error(`recordCriterionVerdict: unknown task '${taskId}'`);
    if (!task.acceptance) {
      throw new Error(`recordCriterionVerdict: task '${taskId}' has no acceptance criteria`);
    }
    const target = task.acceptance.criteria.find((c) => c.id === criterionId);
    if (!target) {
      throw new Error(
        `recordCriterionVerdict: unknown criterion '${criterionId}' on task '${taskId}'`,
      );
    }
    if (target.verifies_by === 'gate') {
      throw new Error(
        `recordCriterionVerdict: criterion '${criterionId}' is a gate; its verdict lives in gate.verdict (use respondGate)`,
      );
    }

    const { workerId } = resolveRunContext();
    const verifiedByResolved = verifiedBy && verifiedBy.length > 0 ? verifiedBy : workerId;
    // APPEND a verification verdict (never mutate the criterion). The
    // criterion-head view reads the latest; a re-verify appends another row and
    // the prior verdict is retained for audit.
    await this.appendCriterionVerdict(
      taskId,
      criterionId,
      'verification',
      ok ? 'verified' : 'failed',
      { reason: reason && reason.length > 0 ? reason : null, by: verifiedByResolved },
      isoNow(),
    );
    return await this.requireTask(taskId, 'recordCriterionVerdict');
  }

  /**
   * Stamp the same verdict onto every criterion the story-close floor reads for
   * this task — `status === 'active'`, applies-to-self (`appliesToSelf`), and
   * NOT `gate` kind (a gate's verdict lives in `gate.verdict`, resolved via
   * `respondGate`). This is the whole-task form behind `scrum task acceptance
   * verify <task>` with no `--criterion`: a reviewer confirms (or fails) all of
   * the task's heavy-kind goalposts in one call. Returns the stamped criterion
   * ids; an empty list means the task carried no floor-applicable non-gate
   * criterion to record. `verifiedBy` is forwarded per criterion. Throws on an
   * unknown task id.
   */
  async recordTaskVerdict(
    taskId: string,
    ok: boolean,
    reason: string | null = null,
    verifiedBy?: string | null,
  ): Promise<{ task: ScrumTask; criterionIds: string[] }> {
    const task = await this.getTask(taskId);
    if (!task) throw new Error(`recordTaskVerdict: unknown task '${taskId}'`);
    const targets = (task.acceptance?.criteria ?? []).filter(
      (c) => c.status === 'active' && c.verifies_by !== 'gate' && appliesToSelf(c.scope),
    );
    let current = task;
    for (const criterion of targets) {
      current = await this.recordCriterionVerdict(taskId, criterion.id, ok, reason, verifiedBy);
    }
    return { task: current, criterionIds: targets.map((c) => c.id) };
  }

  /**
   * The criteria a child should inherit from `parentId` via shared_acceptance.
   * Returns independent deep copies of the parent's ACTIVE,
   * copy-down-scoped criteria, each tagged `inherited_from: parentId` and reset
   * to `status: 'active'` with cleared supersession pointers. Returns `[]` when
   * the parent is unknown or carries no inheritable criteria.
   *
   * Scope gates copy-down: only `descendants` and `both` descend; `self`-scoped
   * criteria stay on the parent and are skipped. An absent scope is the
   * copy-down default (`both`), so legacy criteria authored before scope
   * existed still inherit exactly as before.
   *
   * Copies are intentionally independent: a later edit to the parent's
   * criterion does NOT retroactively change a child that already inherited it.
   */
  async inheritAcceptance(parentId: string): Promise<AcceptanceCriterion[]> {
    const parent = await this.getTask(parentId);
    if (!parent?.acceptance) return [];
    return parent.acceptance.criteria
      .filter((c) => c.status === 'active' && copiesDown(c.scope))
      .map((c) => {
        // A child inherits a FRESH, unverified copy: the parent's recorded
        // verification verdict (`verified`/`failed`) does NOT satisfy the
        // child's own copy, so drop it — the child re-verifies from scratch.
        const { verification: _drop, ...rest } = c;
        return {
          ...rest,
          status: 'active' as const,
          superseded_by: null,
          reason: null,
          inherited_from: parentId,
          // The copy lands as `both` on the child: the child IS a descendant, so
          // the criterion is now a goalpost on the child itself, AND it keeps
          // cascading to the child's own descendants. A parent-only (`self`)
          // criterion never reaches here (it does not copy down).
          scope: 'both' as const,
          // A gate-kind child inherits a FRESH pending gate — the parent's human
          // verdict does not satisfy the child's own gate. `withGateStatesSeeded`
          // re-seeds non-gate criteria to undefined gate at the write boundary.
          ...(c.verifies_by === 'gate' ? { gate: { verdict: 'gate_pending' as const } } : {}),
        };
      });
  }

  /**
   * Persist an acceptance object's DEFINITION (criteria rows + the task-level
   * `policy`), or clear it (NULL). The criteria are the authoring source — the
   * whole-object setters (`setAcceptance`/`addCriterion`/`supersedeCriterion`/
   * `createTask`) pass the full intended criteria list, so this replaces the
   * task's criteria rows wholesale (delete-then-reinsert) inside one
   * transaction. It does NOT touch `scrum_criterion_verdicts` — a verdict is an
   * append, owned by `appendCriterionVerdict`; re-writing the definition does
   * not erase recorded verdicts (their rows survive and the head view still
   * resolves them onto the re-inserted criterion of the same id).
   *
   * The gate/verification fields carried on the in-memory criteria are decode
   * artifacts (folded in from the head verdict on read), so they are
   * intentionally ignored here — the verdict log, not the definition write, is
   * their system of record.
   *
   * Bumps last-touch provenance: `last_modified_at = now()`, `last_modified_by`
   * = the ambient actor (`PROVE_AGENT` env / `defaultActor`, NULL when neither
   * is in scope), plus the executing-worker/run attribution from the run env.
   */
  private async writeAcceptance(taskId: string, acceptance: Acceptance | null): Promise<void> {
    const { workerId, runId } = resolveRunContext();
    const at = isoNow();
    await this.transaction(async () => {
      await this.exec(
        'UPDATE scrum_tasks SET acceptance_policy_json = ?, last_modified_by = ?, last_modified_at = ?, worker_id = ?, run_id = ? WHERE id = ?',
        acceptance?.policy ? JSON.stringify(acceptance.policy) : null,
        this.actor(),
        at,
        workerId,
        runId,
        taskId,
      );
      // Replace-the-whole-object semantics: drop this task's criterion rows and
      // re-insert fresh surrogates. The verdict rows of the dropped surrogates are
      // intentionally left in scrum_criterion_verdicts (the append-only log is never
      // pruned); the criterion-head view's INNER JOIN hides them once their
      // definition row is gone, so they are inert history, not live state.
      await this.exec('DELETE FROM scrum_acceptance_criteria WHERE task_id = ?', taskId);
      const criteria = acceptance?.criteria ?? [];
      for (const criterion of criteria) {
        await this.insertCriterionRow(taskId, criterion, at);
      }
    });
  }

  /**
   * Insert one criterion DEFINITION row. PK is the criterion's own author-given
   * id (NOT a minted ULID — it is already unique per task). `ord` is a freshly
   * minted ULID per insert so the authored array order is preserved on read
   * (the criterion id is an external slug, not lexically insert-ordered, so it
   * cannot carry the ordering itself).
   *
   * If the input criterion arrives carrying a RESOLVED verdict (an approved/
   * rejected gate, or any recorded verification) AND no verdict row yet exists
   * for it, seed the first verdict row so a caller establishing criteria from a
   * pre-decided input (`createTask`/`setAcceptance` with an already-resolved
   * gate) materializes that decision into the append-only log. The existence
   * guard keeps this idempotent for the read-modify-write callers
   * (`addCriterion`/`supersedeCriterion`) whose criteria carry the gate/
   * verification as a decode artifact from a prior read — their verdict rows
   * already exist and must NOT be re-appended.
   */
  private async insertCriterionRow(
    taskId: string,
    criterion: AcceptanceCriterion,
    at: string,
  ): Promise<void> {
    const rowId = ulid();
    await this.exec(
      'INSERT INTO scrum_acceptance_criteria (id, task_id, criterion_id, ord, text, verifies_by, check_payload, status, idempotent, scope, timeout, superseded_by, reason, inherited_from, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      rowId,
      taskId,
      criterion.id,
      ulid(),
      criterion.text,
      criterion.verifies_by,
      criterion.check,
      criterion.status,
      criterion.idempotent ? 1 : 0,
      criterion.scope ?? null,
      criterion.timeout ?? null,
      criterion.superseded_by ?? null,
      criterion.reason ?? null,
      criterion.inherited_from ?? null,
      at,
    );
    await this.seedInputVerdict(taskId, rowId, criterion, at);
  }

  /**
   * Seed the first verdict row for a freshly-inserted criterion-row (by SURROGATE
   * id) that arrived with a resolved verdict on its input shape. This appends
   * unconditionally — there is NO in-method existence guard. Safety against a
   * double-append derives entirely from the call shape: every caller reaches a
   * fresh, verdict-less surrogate (`createTask` builds new rows; `writeAcceptance`
   * DELETEs the task's criteria and re-inserts new surrogates; `addCriterion`
   * inserts a duplicate-id-guarded new criterion). A future read-modify-write
   * caller that feeds an already-persisted verdict back through `insertCriterionRow`
   * would double-append — do not wire one without adding a guard here. A pending
   * gate seeds nothing (`gate_pending` is the absent-verdict default the head
   * reconstruction supplies).
   */
  private async seedInputVerdict(
    taskId: string,
    rowId: string,
    criterion: AcceptanceCriterion,
    at: string,
  ): Promise<void> {
    const resolved =
      criterion.verifies_by === 'gate'
        ? criterion.gate && criterion.gate.verdict !== 'gate_pending'
          ? {
              channel: 'gate' as const,
              verdict: criterion.gate.verdict,
              fields: {
                by: criterion.gate.responder ?? null,
                comment: criterion.gate.comment ?? null,
              },
            }
          : null
        : criterion.verification && criterion.verification.verdict !== 'pending'
          ? {
              channel: 'verification' as const,
              verdict: criterion.verification.verdict,
              fields: {
                reason: criterion.verification.reason ?? null,
                by: criterion.verification.verified_by ?? null,
              },
            }
          : null;
    if (!resolved) return;
    await this.appendVerdictRow(
      taskId,
      rowId,
      resolved.channel,
      resolved.verdict,
      resolved.fields,
      at,
    );
  }

  /**
   * Resolve a criterion's SURROGATE row id from `(taskId, externalId)`, or null
   * when the task carries no such criterion. The verdict log keys on the
   * surrogate, so the external-id-facing callers (`respondGate`/
   * `recordCriterionVerdict`) resolve it before appending.
   */
  private async resolveCriterionRowId(taskId: string, externalId: string): Promise<string | null> {
    const row = await this.one<{ id: string }>(
      'SELECT id FROM scrum_acceptance_criteria WHERE task_id = ? AND criterion_id = ?',
      taskId,
      externalId,
    );
    return row?.id ?? null;
  }

  /**
   * Append ONE gate/verification verdict row for the criterion identified by its
   * EXTERNAL id on `taskId` — never an update. Resolves the criterion-row
   * surrogate first, then delegates to `appendVerdictRow`. The external-id-facing
   * public verdict paths (`respondGate`/`recordCriterionVerdict`) call this.
   */
  private async appendCriterionVerdict(
    taskId: string,
    externalCriterionId: string,
    channel: 'gate' | 'verification',
    verdict: string,
    fields: { reason?: string | null; by?: string | null; comment?: string | null },
    at: string,
  ): Promise<void> {
    const rowId = await this.resolveCriterionRowId(taskId, externalCriterionId);
    if (rowId === null) {
      throw new Error(
        `appendCriterionVerdict: unknown criterion '${externalCriterionId}' on task '${taskId}'`,
      );
    }
    await this.appendVerdictRow(taskId, rowId, channel, verdict, fields, at);
  }

  /**
   * Append ONE verdict row to the append-only `scrum_criterion_verdicts` log,
   * keyed by the criterion-row SURROGATE id — never an update. A `gate`-channel
   * row records a human gate response; a `verification`-channel row records a
   * bash/assert/agent verdict. Re-deciding a criterion appends another row; the
   * criterion-head view (max ULID per surrogate) then reads the latest. The
   * minted ULID PK makes two concurrent appends commute under whole-transaction
   * sync replay — both rows survive the rebase, where a single mutable verdict
   * column would have one writer clobber the other. Bumps the task's last-touch
   * provenance.
   */
  private async appendVerdictRow(
    taskId: string,
    criterionRowId: string,
    channel: 'gate' | 'verification',
    verdict: string,
    fields: { reason?: string | null; by?: string | null; comment?: string | null },
    at: string,
  ): Promise<void> {
    const { workerId, runId } = resolveRunContext();
    await this.exec(
      'INSERT INTO scrum_criterion_verdicts (id, criterion_id, channel, verdict, reason, by_whom, comment, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ulid(),
      criterionRowId,
      channel,
      verdict,
      fields.reason ?? null,
      fields.by ?? null,
      fields.comment ?? null,
      at,
    );
    await this.exec(
      'UPDATE scrum_tasks SET last_modified_by = ?, last_modified_at = ?, worker_id = ?, run_id = ? WHERE id = ?',
      this.actor(),
      at,
      workerId,
      runId,
      taskId,
    );
  }

  /** Re-fetch a task that must exist after a same-method write. */
  private async requireTask(taskId: string, method: string): Promise<ScrumTask> {
    const updated = await this.getTask(taskId);
    if (!updated) throw new Error(`${method}: task '${taskId}' vanished mid-update`);
    return updated;
  }

  // ==========================================================================
  // Declared bounds (v6)
  //
  // The optional milestone-authored authoring source for per-task bounds.
  // `compile-plan` forwards this into the emitted plan's `tasks[].bounds`;
  // enforcement (native permissions + worktree wall) happens downstream via
  // prep-permissions reading the plan, NOT here.
  // ==========================================================================

  /**
   * Replace a task's declared bounds. Validates the closed-top-level-key
   * shape (rejects unknown keys; all sub-fields optional) before the write.
   * Throws on an unknown task id. Pass `null` to clear (→ unbounded).
   */
  async setBounds(taskId: string, bounds: TaskBounds | null): Promise<ScrumTask> {
    const task = await this.getTask(taskId);
    if (!task) throw new Error(`setBounds: unknown task '${taskId}'`);
    if (bounds !== null) validateBounds(bounds);
    // Bump last-touch provenance (v9); no per-call agent flows here, so the
    // ambient actor (PROVE_AGENT env / defaultActor, else NULL) attributes the
    // write. Still stamps the executing-worker/run attribution (v11).
    const { workerId, runId } = resolveRunContext();
    await this.exec(
      'UPDATE scrum_tasks SET bounds_json = ?, last_modified_by = ?, last_modified_at = ?, worker_id = ?, run_id = ? WHERE id = ?',
      bounds === null ? null : JSON.stringify(bounds),
      this.actor(),
      isoNow(),
      workerId,
      runId,
      taskId,
    );
    return await this.requireTask(taskId, 'setBounds');
  }

  // ==========================================================================
  // Milestones
  // ==========================================================================

  async createMilestone(input: CreateMilestoneInput): Promise<ScrumMilestone> {
    const row: ScrumMilestone = {
      id: input.id,
      title: input.title,
      description: input.description ?? null,
      target_state: input.targetState ?? null,
      status: input.status ?? 'planned',
      initiative: input.initiative ?? null,
      created_at: input.createdAt ?? isoNow(),
      closed_at: null,
    };
    await this.exec(
      'INSERT INTO scrum_milestones (id, title, description, target_state, status, initiative, created_at, closed_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)',
      row.id,
      row.title,
      row.description,
      row.target_state,
      row.status,
      row.initiative,
      row.created_at,
    );
    return row;
  }

  /**
   * List milestones, optionally filtered by `status` and/or `initiative` (the
   * tier above milestone). The initiative match is case-insensitive, matching
   * the decision-kind filter style.
   */
  async listMilestones(status?: MilestoneStatus, initiative?: string): Promise<ScrumMilestone[]> {
    const clauses: string[] = [];
    const params: string[] = [];
    if (status !== undefined) {
      clauses.push('status = ?');
      params.push(status);
    }
    if (initiative !== undefined && initiative.length > 0) {
      clauses.push('lower(initiative) = lower(?)');
      params.push(initiative);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const sql = `SELECT ${MILESTONE_COLUMNS} FROM scrum_milestones ${where} ORDER BY created_at ASC`;
    return (await this.many(sql, ...params)) as ScrumMilestone[];
  }

  async getMilestone(id: string): Promise<ScrumMilestone | null> {
    const row = (await this.one(
      `SELECT ${MILESTONE_COLUMNS} FROM scrum_milestones WHERE id = ?`,
      id,
    )) as ScrumMilestone | null;
    return row ?? null;
  }

  /**
   * Transition a milestone between `planned` and `active`. Closed is terminal —
   * use `closeMilestone` to close and never re-open (schema invariant).
   * Idempotent: setting status to the current value writes the same row.
   *
   * Does NOT emit a `scrum_events` row — the events table is task-scoped
   * (`task_id NOT NULL`). Milestone-level events are out of scope for this
   * change; operators can follow the transition via the milestone row's
   * `status` column.
   */
  async setMilestoneStatus(id: string, status: 'planned' | 'active'): Promise<ScrumMilestone> {
    const existing = await this.getMilestone(id);
    if (!existing) throw new Error(`setMilestoneStatus: unknown milestone '${id}'`);
    if (existing.status === 'closed') {
      throw new Error(`setMilestoneStatus: cannot re-open closed milestone '${id}'`);
    }
    await this.exec('UPDATE scrum_milestones SET status = ? WHERE id = ?', status, id);
    const updated = await this.getMilestone(id);
    if (!updated) throw new Error(`setMilestoneStatus: milestone '${id}' vanished mid-update`);
    return updated;
  }

  /**
   * Set status = 'closed', stamp `closed_at = now()`, and disband every active
   * team pinned to this milestone (`terminates_on_milestone = id`). Throws on an
   * unknown id.
   *
   * The milestone-close trigger for the team lifecycle: closing a milestone is
   * the structural event that disbands the enabling/terminating-lifetime teams
   * scoped to it, so the termination rides the close path rather than relying on
   * an operator to remember it. The whole close — the milestone UPDATE plus
   * every matching team's team-local disband — runs in ONE transaction, so a
   * milestone is never observed closed with its teams left live (and a failure
   * in any disband rolls the close back). Each `teamTerminate` opens a nested
   * SAVEPOINT inside this transaction; the outer transaction is the atomic unit.
   *
   * Re-closing an already-closed milestone re-runs the trigger, but every
   * matching team is already `inactive` by then, so `terminateTeamsForMilestone`
   * finds no active matches and the close is an idempotent no-op for teams.
   */
  async closeMilestone(id: string): Promise<ScrumMilestone> {
    const existing = await this.getMilestone(id);
    if (!existing) throw new Error(`closeMilestone: unknown milestone '${id}'`);
    const closedAt = isoNow();
    const close = async () => {
      await this.exec(
        'UPDATE scrum_milestones SET status = ?, closed_at = ? WHERE id = ?',
        'closed',
        closedAt,
        id,
      );
      await this.terminateTeamsForMilestone(id, `milestone '${id}' closed`);
    };
    await withTx(this.store, close);
    return { ...existing, status: 'closed', closed_at: closedAt };
  }

  // ==========================================================================
  // Tags
  // ==========================================================================

  /** Upsert-style: no-op if the `(task_id, tag)` pair already exists. */
  async addTag(taskId: string, tag: string, addedAt?: string): Promise<void> {
    if (!(await this.getTask(taskId))) throw new Error(`addTag: unknown task '${taskId}'`);
    await this.exec(
      'INSERT OR IGNORE INTO scrum_tags (task_id, tag, added_at) VALUES (?, ?, ?)',
      taskId,
      tag,
      addedAt ?? isoNow(),
    );
  }

  /** Idempotent: removing a non-existent `(task_id, tag)` pair is a no-op. */
  async removeTag(taskId: string, tag: string): Promise<void> {
    await this.exec('DELETE FROM scrum_tags WHERE task_id = ? AND tag = ?', taskId, tag);
  }

  async listTagsForTask(taskId: string): Promise<ScrumTag[]> {
    return (await this.many(
      'SELECT task_id, tag, added_at FROM scrum_tags WHERE task_id = ? ORDER BY tag ASC',
      taskId,
    )) as ScrumTag[];
  }

  async listTasksForTag(tag: string): Promise<ScrumTask[]> {
    return await this.hydrateRows(
      (await this.many(
        `SELECT ${T_COLS}
       FROM scrum_tasks t
       INNER JOIN scrum_tags g ON g.task_id = t.id
       WHERE g.tag = ? AND t.deleted_at IS NULL
       ORDER BY t.created_at ASC`,
        tag,
      )) as ScrumTaskRow[],
    );
  }

  // ==========================================================================
  // Dependencies
  // ==========================================================================

  /**
   * Record a dependency. Idempotent on the `(from, to, kind)` PK. Rejects
   * self-edges and unknown task ids (FK pragma catches the latter when
   * enabled, but the explicit check keeps :memory: tests honest).
   *
   * Storage is canonical: every edge is persisted as `kind: 'blocks'`,
   * because all readers (getBlockedBy/getBlocking/nextReady) query that
   * kind exclusively. `blocked_by` is the inverse relation, so we
   * normalize "X blocked_by Y" to the equivalent "Y blocks X" by
   * swapping the endpoints before insert. Without this, `blocked_by`
   * rows would persist but never be read — a silent no-op (issue #22).
   */
  async addDep(fromTaskId: string, toTaskId: string, kind: DepKind): Promise<void> {
    const [from, to] = normalizeDepEdge(fromTaskId, toTaskId, kind);
    if (from === to) {
      throw new Error(`addDep: self-dependency rejected for task '${fromTaskId}'`);
    }
    if (!(await this.getTask(from))) throw new Error(`addDep: unknown from_task '${from}'`);
    if (!(await this.getTask(to))) throw new Error(`addDep: unknown to_task '${to}'`);
    await this.exec(
      'INSERT OR IGNORE INTO scrum_deps (from_task_id, to_task_id, kind) VALUES (?, ?, ?)',
      from,
      to,
      'blocks',
    );
  }

  async removeDep(fromTaskId: string, toTaskId: string, kind: DepKind): Promise<void> {
    const [from, to] = normalizeDepEdge(fromTaskId, toTaskId, kind);
    await this.exec(
      "DELETE FROM scrum_deps WHERE from_task_id = ? AND to_task_id = ? AND kind = 'blocks'",
      from,
      to,
    );
  }

  /** Tasks that *block* `taskId`. SELECT is keyed off `idx_scrum_deps_to_task`. */
  async getBlockedBy(taskId: string): Promise<ScrumDep[]> {
    return (await this.many(
      "SELECT from_task_id, to_task_id, kind FROM scrum_deps WHERE to_task_id = ? AND kind = 'blocks'",
      taskId,
    )) as ScrumDep[];
  }

  /** Tasks that `taskId` blocks. */
  async getBlocking(taskId: string): Promise<ScrumDep[]> {
    return (await this.many(
      "SELECT from_task_id, to_task_id, kind FROM scrum_deps WHERE from_task_id = ? AND kind = 'blocks'",
      taskId,
    )) as ScrumDep[];
  }

  // ==========================================================================
  // Events
  // ==========================================================================

  /**
   * Append an event. Rejects unknown task ids up front so the caller sees
   * a domain error rather than an opaque FK violation. Returns the new
   * row's ULID id.
   */
  async appendEvent(input: AppendEventInput): Promise<string> {
    if (!(await this.getTask(input.taskId))) {
      throw new Error(`appendEvent: unknown task '${input.taskId}'`);
    }
    // A `blocker_raised` event carries a typed escalation payload. Validate it
    // at the boundary so a malformed escalation surfaces a domain error here
    // rather than a silently-untyped row that nextReady/alerts later fail to
    // rank. Other event kinds carry free-form payloads.
    if (input.kind === 'blocker_raised') {
      validateEscalationPayload(input.payload);
    }
    const ts = input.ts ?? isoNow();
    const payload = input.payload === undefined ? null : input.payload;

    const id = ulid();
    const tx = async () => {
      await this.exec(
        'INSERT INTO scrum_events (id, task_id, ts, kind, agent, payload_json) VALUES (?, ?, ?, ?, ?, ?)',
        id,
        input.taskId,
        ts,
        input.kind,
        this.actor(input.agent),
        JSON.stringify(payload),
      );
      await this.exec('UPDATE scrum_tasks SET last_event_at = ? WHERE id = ?', ts, input.taskId);
      return id;
    };
    return await withTx(this.store, tx);
  }

  /** Events for one task, newest-first (matches `idx_scrum_events_task_ts`). */
  async listEventsForTask(taskId: string, limit = 100): Promise<ScrumEvent[]> {
    const rows = (await this.many(
      'SELECT id, task_id, ts, kind, agent, payload_json FROM scrum_events WHERE task_id = ? ORDER BY ts DESC, id DESC LIMIT ?',
      taskId,
      limit,
    )) as Array<{
      id: string;
      task_id: string;
      ts: string;
      kind: string;
      agent: string | null;
      payload_json: string;
    }>;
    return rows.map((r) => decodeEvent(r));
  }

  /**
   * Returns true when an `unlinked_run_detected` event already exists for the
   * given `runPath` + `reason` pair. Uses a targeted SQL WHERE on the event
   * kind and JSON payload fields — not window-bounded — so it remains correct
   * regardless of how many orphan events have accumulated on the sentinel task.
   */
  async hasOrphanEventForRunPath(runPath: string, reason: string): Promise<boolean> {
    const row = await this.one(
      "SELECT 1 FROM scrum_events WHERE kind = 'unlinked_run_detected' AND json_extract(payload_json, '$.run_path') = ? AND json_extract(payload_json, '$.reason') = ? LIMIT 1",
      runPath,
      reason,
    );
    return row != null;
  }

  /** Cross-task recent events. Used by the UI feed. */
  async listRecentEvents(limit = 50): Promise<ScrumEvent[]> {
    const rows = (await this.many(
      'SELECT id, task_id, ts, kind, agent, payload_json FROM scrum_events ORDER BY ts DESC, id DESC LIMIT ?',
      limit,
    )) as Array<{
      id: string;
      task_id: string;
      ts: string;
      kind: string;
      agent: string | null;
      payload_json: string;
    }>;
    return rows.map((r) => decodeEvent(r));
  }

  // ==========================================================================
  // Run links
  // ==========================================================================

  async linkRun(input: LinkRunInput): Promise<void> {
    if (!(await this.getTask(input.taskId))) {
      throw new Error(`linkRun: unknown task '${input.taskId}'`);
    }
    await this.exec(
      'INSERT OR REPLACE INTO scrum_run_links (task_id, run_path, branch, slug, linked_at) VALUES (?, ?, ?, ?, ?)',
      input.taskId,
      input.runPath,
      input.branch ?? null,
      input.slug ?? null,
      input.linkedAt ?? isoNow(),
    );
  }

  async unlinkRun(taskId: string, runPath: string): Promise<void> {
    await this.exec(
      'DELETE FROM scrum_run_links WHERE task_id = ? AND run_path = ?',
      taskId,
      runPath,
    );
  }

  async listRunsForTask(taskId: string): Promise<ScrumRunLink[]> {
    return (await this.many(
      'SELECT task_id, run_path, branch, slug, linked_at FROM scrum_run_links WHERE task_id = ? ORDER BY linked_at ASC',
      taskId,
    )) as ScrumRunLink[];
  }

  /** Reverse lookup: which task owns `runPath`? Null if none. */
  async getTaskForRun(runPath: string): Promise<ScrumTask | null> {
    const link = (await this.one(
      'SELECT task_id FROM scrum_run_links WHERE run_path = ? LIMIT 1',
      runPath,
    )) as { task_id: string } | null;
    if (!link) return null;
    return await this.getTask(link.task_id);
  }

  // ==========================================================================
  // Context bundles
  // ==========================================================================

  async saveContextBundle(taskId: string, bundle: unknown, rebuiltAt?: string): Promise<void> {
    if (!(await this.getTask(taskId))) {
      throw new Error(`saveContextBundle: unknown task '${taskId}'`);
    }
    await this.exec(
      `INSERT INTO scrum_context_bundles (task_id, rebuilt_at, bundle_json) VALUES (?, ?, ?)
       ON CONFLICT(task_id) DO UPDATE SET rebuilt_at = excluded.rebuilt_at, bundle_json = excluded.bundle_json`,
      taskId,
      rebuiltAt ?? isoNow(),
      JSON.stringify(bundle),
    );
  }

  async loadContextBundle(taskId: string): Promise<ScrumContextBundle | null> {
    const row = (await this.one(
      'SELECT task_id, rebuilt_at, bundle_json FROM scrum_context_bundles WHERE task_id = ?',
      taskId,
    )) as { task_id: string; rebuilt_at: string; bundle_json: string } | null;
    if (!row) return null;
    return {
      task_id: row.task_id,
      rebuilt_at: row.rebuilt_at,
      bundle: JSON.parse(row.bundle_json) as unknown,
    };
  }

  // ==========================================================================
  // nextReady — ranked pick-list of actionable tasks
  // ==========================================================================

  /**
   * The base actionable task ids — every non-deleted task in `ready` or
   * `backlog`, read straight from the shared `scrum_ready_eligible` view. This
   * is the UNSCORED candidate floor `nextReady` ranks on top of, surfaced as a
   * standalone reader so a second consumer (the review-ui boundary) shares the
   * SAME view definition rather than re-deriving the predicate in TS. Ordered
   * by id for a deterministic, comparable set.
   */
  async readyEligibleIds(): Promise<string[]> {
    const rows = (await this.many('SELECT id FROM scrum_ready_eligible ORDER BY id ASC')) as Array<{
      id: string;
    }>;
    return rows.map((r) => r.id);
  }

  /**
   * Rank tasks in `ready` or `backlog` by composite priority:
   *   score = unblock_depth * 10 + milestone_boost * 5 + context_hotness * 3 + tag_boost
   *
   * Where:
   *   unblock_depth    = count of descendant tasks this one unblocks
   *                      (transitive closure over `blocks` edges)
   *   milestone_boost  = 1.0 if assigned to the filter milestone OR any
   *                      active milestone (strongest boost);
   *                      0.5 if assigned to a non-closed milestone
   *                      (planned — partial credit so milestone-bound
   *                      work outranks unlinked work);
   *                      0   if unlinked or assigned to a closed milestone.
   *                      `scrum milestone <id> activate` promotes a
   *                      planned milestone to the strongest boost.
   *   context_hotness  = sigmoid of hours-since-last-event; fresher tasks
   *                      rank higher. Value in [0, 1].
   *   tag_boost        = sum of +1 per priority tag and -1 per defer tag
   *                      ({deferred, blocked, wontfix}) attached to the task
   *
   * Returns up to `limit` rows sorted by score DESC, then `created_at` ASC
   * for deterministic ordering on ties.
   */
  async nextReady(options: NextReadyOptions = {}): Promise<NextReadyRow[]> {
    const limit = options.limit ?? 10;
    const nowMs = options.nowMs ?? Date.now();

    // The base actionable set (`status IN ('ready','backlog') AND deleted_at IS
    // NULL`) is defined ONCE in the shared `scrum_ready_eligible` view, so the
    // CLI ranking and the review-ui boundary share a single eligible predicate.
    // The milestone filter stays a WHERE on top of the view (it is per-call, not
    // part of the shared base). Two SQL shapes (with/without that filter) — both
    // routed through the prep() cache so the plan is parsed once per process.
    const candidateRows = (
      options.milestoneId
        ? await this.many(
            `SELECT ${TASK_COLUMNS}
             FROM scrum_tasks
             WHERE id IN (SELECT id FROM scrum_ready_eligible) AND milestone_id = ?
             ORDER BY created_at ASC`,
            options.milestoneId,
          )
        : await this.many(`SELECT ${TASK_COLUMNS}
             FROM scrum_tasks
             WHERE id IN (SELECT id FROM scrum_ready_eligible)
             ORDER BY created_at ASC`)
    ) as ScrumTaskRow[];
    const candidates = await this.hydrateRows(candidateRows);

    // Snapshot active and closed milestone ids in one pass each — both
    // sets feed `computeMilestoneBoost`. Per-invocation lookup keeps the
    // boost calculation O(1) per task without a per-task DB round trip.
    const activeMilestones = new Set((await this.listMilestones('active')).map((m) => m.id));
    const closedMilestones = new Set((await this.listMilestones('closed')).map((m) => m.id));

    // Batch the per-candidate tag lookup into a single IN-query. Bun's sqlite
    // binds parameters positionally, so we expand placeholders to match the
    // candidate count. Per-invocation only — tags mutate between calls.
    const tagBoostByTask = await this.fetchTagBoosts(candidates.map((t) => t.id));

    // Batch the per-candidate latest-escalation lookup. A task
    // with an open `blocker_raised` escalation auto-bubbles up, weighted by the
    // escalation's age. Per-invocation only — escalations mutate between calls.
    const escalationByTask = await this.fetchLatestEscalations(candidates.map((t) => t.id));

    // Memoize unblock_depth within this invocation. The BFS from task `A`
    // and task `B` can both traverse a shared descendant `C`; caching
    // per-root collapses repeated DFS sweeps across the candidate set.
    // Scope is intentionally this single call — task deps can change
    // between invocations.
    const unblockDepthCache = new Map<string, number>();
    // Warm the unblock-depth cache sequentially before the synchronous scoring
    // map below: computeUnblockDepth is async (one dep-graph BFS per root), so
    // it cannot run inside the .map callback. The shared cache collapses the
    // repeated DFS sweeps across the candidate set.
    for (const task of candidates) {
      await this.computeUnblockDepth(task.id, unblockDepthCache);
    }

    const scored: NextReadyRow[] = candidates.map((task) => {
      const unblockDepth = unblockDepthCache.get(task.id) ?? 0;
      const milestoneBoost = computeMilestoneBoost(
        task,
        options.milestoneId,
        activeMilestones,
        closedMilestones,
      );
      const contextHotness = computeContextHotness(task.last_event_at, nowMs);
      const tagBoost = tagBoostByTask.get(task.id) ?? 0;
      const escalation = escalationByTask.get(task.id) ?? null;
      const escalationBoost = computeEscalationBoost(escalation?.ts ?? null, nowMs);
      const score =
        unblockDepth * 10 + milestoneBoost * 5 + contextHotness * 3 + tagBoost + escalationBoost;
      return {
        task,
        score,
        rationale: {
          unblock_depth: unblockDepth,
          milestone_boost: milestoneBoost,
          context_hotness: contextHotness,
          tag_boost: tagBoost,
          escalation_boost: escalationBoost,
          escalation_type: escalation?.type ?? null,
        },
      };
    });

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.task.created_at.localeCompare(b.task.created_at);
    });

    return scored.slice(0, limit);
  }

  // ==========================================================================
  // Decisions
  // ==========================================================================

  /**
   * Upsert a decision row keyed on `id`. On duplicate id the row is
   * replaced in-place: title/topic/content/source_path are overwritten,
   * `content_sha` is recomputed from the new content, and `recorded_at` is
   * bumped to now so list order reflects the latest write. Status defaults
   * to `'accepted'`.
   *
   * Supersession is terminal and has no working-tree-file representation:
   * `superseded_by`/`reason` are set only via `supersedeDecision`, and a
   * decision file body never encodes `'superseded'`. So a re-record (a bare
   * `recordDecision`, `decision record old.md`, or `recover --from-git`)
   * always carries a current-ish status (`'accepted'` by default; never
   * `'superseded'`). The conservative "asserts a status change" signal is
   * therefore: the incoming status is itself `'superseded'`. When an existing
   * row is `'superseded'` and the incoming record does NOT assert
   * `'superseded'`, the pointer/reason/status are preserved rather than
   * clobbered — re-recording the body never silently resurrects a retired
   * decision. Clearing or re-pointing a supersession stays exclusively
   * `supersedeDecision`'s job.
   *
   * Limitation: because the only signal is the incoming status value, a
   * re-record can never DRIVE a transition INTO `'superseded'` (the parser
   * never emits it; supersession carries a pointer the file cannot supply).
   * `supersedeDecision` remains the sole entry point for retiring a decision.
   *
   * Gated write protocol (v21): a decision whose `kind` is in
   * `GATED_DECISION_KINDS` (`adr | glossary | pattern`) is NOT durably accepted
   * on record — it lands as a DRAFT (`status = 'draft'`, `write_status =
   * 'draft'`) and becomes `accepted` only when `approveDecision` resolves its
   * gate. A NON-gated record (no kind, or a kind outside the set) is unchanged:
   * it lands `accepted` immediately with `write_status = null`. The gate state
   * follows the row status through the supersession-preserve branch — a
   * re-record of a superseded row keeps its existing gate columns intact.
   *
   * `content_sha` uses node:crypto sha256 — same std-lib primitive every
   * other prove domain uses; no new dependency.
   */
  async recordDecision(input: RecordDecisionInput): Promise<DecisionRow> {
    const recordedAt = isoNow();
    const contentSha = createHash('sha256').update(input.content).digest('hex');
    // A decision file body never encodes the terminal `'superseded'` status
    // (it has no representation for the supersession pointer), so any re-record
    // arrives with a current-ish status. Treat an incoming non-`'superseded'`
    // status as "asserts no supersession change" — threaded into SQL as a 0/1
    // flag so the ON CONFLICT branch preserves an existing terminal row.
    const incomingStatus = input.status ?? 'accepted';
    const assertsStatus = incomingStatus === 'superseded' ? 1 : 0;
    const kind = input.kind ?? null;
    // A gated-kind record is held as a DRAFT until its write-gate is approved.
    // A non-gated record (no kind / off-set kind) bypasses the gate: it keeps
    // the incoming status (default 'accepted') and a null write_status. A record
    // that asserts a 'superseded' status is never a fresh gated draft — it is a
    // (legacy) supersession-carrying re-record, so the gate columns stay null.
    const gated = kind !== null && (GATED_DECISION_KINDS as readonly string[]).includes(kind);
    const isDraft = gated && assertsStatus === 0;
    const landingStatus = isDraft ? 'draft' : incomingStatus;
    const writeStatus: DecisionWriteStatus | null = isDraft ? 'draft' : null;
    const row: DecisionRow = {
      id: input.id,
      title: input.title,
      topic: input.topic ?? null,
      status: landingStatus,
      content: input.content,
      source_path: input.sourcePath ?? null,
      content_sha: contentSha,
      recorded_at: recordedAt,
      recorded_by_agent: this.actor(input.recordedByAgent),
      // A freshly inserted decision is always current; supersession is set
      // only via `supersedeDecision`. On upsert these are preserved when the
      // existing row is superseded and the incoming record asserts no status
      // change (see ON CONFLICT below).
      superseded_by: null,
      reason: null,
      kind,
      write_status: writeStatus,
      gate_responder: null,
      gate_responded_at: null,
      // Provenance is set ONLY by `promoteLoreToCodex` (which records then
      // stamps it in one transaction). A bare `recordDecision` carries no
      // source Lore — direct authorship, the common case.
      source_lore_id: null,
    };

    // All binds are named ($-prefixed) so the supersession-preserve flag
    // ($assertsStatus) and every column value survive a future reorder of the
    // INSERT column list — no positional `?N` to silently misalign.
    await this.execNamed(
      `INSERT INTO scrum_decisions (id, title, topic, status, content, source_path, content_sha, recorded_at, recorded_by_agent, superseded_by, reason, kind, write_status, gate_responder, gate_responded_at, source_lore_id)
       VALUES ($id, $title, $topic, $status, $content, $source_path, $content_sha, $recorded_at, $recorded_by_agent, $superseded_by, $reason, $kind, $write_status, $gate_responder, $gate_responded_at, $source_lore_id)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         topic = excluded.topic,
         content = excluded.content,
         source_path = excluded.source_path,
         content_sha = excluded.content_sha,
         recorded_at = excluded.recorded_at,
         recorded_by_agent = excluded.recorded_by_agent,
         kind = excluded.kind,
         -- Preserve a terminal supersession across a bare re-record. When the
         -- existing row is 'superseded' and the incoming record asserts no
         -- status ($assertsStatus = 0), keep status/superseded_by/reason and
         -- the gate columns intact; never auto-resurrect. Otherwise adopt the
         -- incoming values (a re-record of a non-superseded row re-enters the
         -- gate per the incoming kind).
         status = CASE
           WHEN scrum_decisions.status = 'superseded' AND $assertsStatus = 0
             THEN scrum_decisions.status
           ELSE excluded.status
         END,
         superseded_by = CASE
           WHEN scrum_decisions.status = 'superseded' AND $assertsStatus = 0
             THEN scrum_decisions.superseded_by
           ELSE excluded.superseded_by
         END,
         reason = CASE
           WHEN scrum_decisions.status = 'superseded' AND $assertsStatus = 0
             THEN scrum_decisions.reason
           ELSE excluded.reason
         END,
         write_status = CASE
           WHEN scrum_decisions.status = 'superseded' AND $assertsStatus = 0
             THEN scrum_decisions.write_status
           ELSE excluded.write_status
         END,
         gate_responder = CASE
           WHEN scrum_decisions.status = 'superseded' AND $assertsStatus = 0
             THEN scrum_decisions.gate_responder
           ELSE excluded.gate_responder
         END,
         gate_responded_at = CASE
           WHEN scrum_decisions.status = 'superseded' AND $assertsStatus = 0
             THEN scrum_decisions.gate_responded_at
           ELSE excluded.gate_responded_at
         END,
         -- Preserve a promotion's provenance across a bare re-record. A plain
         -- recordDecision never carries a source Lore ($source_lore_id IS NULL),
         -- so re-recording a promoted decision's body must not erase the
         -- back-pointer to its origin Lore -- keep the existing one. Only a write
         -- that itself supplies a source_lore_id (the promote path) sets it.
         source_lore_id = CASE
           WHEN $source_lore_id IS NULL
             THEN scrum_decisions.source_lore_id
           ELSE excluded.source_lore_id
         END`,
      {
        id: row.id,
        title: row.title,
        topic: row.topic,
        status: row.status,
        content: row.content,
        source_path: row.source_path,
        content_sha: row.content_sha,
        recorded_at: row.recorded_at,
        recorded_by_agent: row.recorded_by_agent,
        superseded_by: row.superseded_by,
        reason: row.reason,
        kind: row.kind,
        write_status: row.write_status,
        gate_responder: row.gate_responder,
        gate_responded_at: row.gate_responded_at,
        source_lore_id: row.source_lore_id,
        assertsStatus: assertsStatus,
      },
    );

    // Re-fetch so the returned row reflects any preserved supersession rather
    // than the in-memory `row` (whose status/superseded_by/reason may have
    // been overridden by the CASE branches above).
    const persisted = await this.getDecision(row.id);
    if (!persisted) throw new Error(`recordDecision: row '${row.id}' vanished mid-write`);
    return persisted;
  }

  /**
   * Supersede a decision (append-only). Sets the OLD decision's
   * `status` to `'superseded'`, points `superseded_by` at `supersededById`,
   * and records `reason`. Never hard-deletes — the original row stays
   * auditable, so `listDecisions`/`getDecision` keep returning it.
   *
   * Rejects when the decision is missing, the replacement is missing, the
   * replacement is the decision itself, or the decision is already terminal
   * (`status` already `'superseded'`). Returns the updated old row.
   */
  async supersedeDecision(
    id: string,
    supersededById: string,
    reason: string,
  ): Promise<DecisionRow> {
    const existing = await this.getDecision(id);
    if (!existing) throw new Error(`supersedeDecision: unknown decision '${id}'`);
    if (existing.status === 'superseded') {
      throw new Error(`supersedeDecision: decision '${id}' is already superseded`);
    }
    if (id === supersededById) {
      throw new Error(`supersedeDecision: decision '${id}' cannot supersede itself`);
    }
    if (!(await this.getDecision(supersededById))) {
      throw new Error(`supersedeDecision: unknown replacement decision '${supersededById}'`);
    }

    await this.exec(
      "UPDATE scrum_decisions SET status = 'superseded', superseded_by = ?, reason = ? WHERE id = ?",
      supersededById,
      reason,
      id,
    );

    const updated = await this.getDecision(id);
    if (!updated) throw new Error(`supersedeDecision: decision '${id}' vanished mid-update`);
    return updated;
  }

  /** Fetch one decision by id, or null if missing. */
  async getDecision(id: string): Promise<DecisionRow | null> {
    const row = (await this.one(
      `SELECT ${DECISION_COLUMNS} FROM scrum_decisions WHERE id = ?`,
      id,
    )) as DecisionRow | null;
    return row ?? null;
  }

  /**
   * List decisions, newest-first by `recorded_at`. Empty filter returns
   * all rows; `topic` and `status` filters compose with AND. The composed
   * SQL has a small, bounded set of shapes — each routed through `prep()`
   * so the plan cache reuses parsed statements across calls (matches the
   * discipline of `listTasks`).
   */
  async listDecisions(filter: ListDecisionsFilter = {}): Promise<DecisionRow[]> {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter.topic !== undefined) {
      clauses.push('lower(topic) = lower(?)');
      params.push(filter.topic);
    }
    if (filter.status !== undefined) {
      // Status display casing is authored (e.g., `**Status**: Accepted` from the
      // decision-record body becomes stored as `Accepted`), but operator filters
      // read naturally in lowercase. Comparison is case-insensitive on both sides
      // so `--status accepted` matches rows stored as `Accepted`, `ACCEPTED`,
      // or any other case variant without rewriting existing rows.
      clauses.push('lower(status) = lower(?)');
      params.push(filter.status);
    }
    if (filter.kind !== undefined) {
      // Case-insensitive on both sides, matching topic/status — the curation
      // step may author `adr` in any letter case interchangeably.
      clauses.push('lower(kind) = lower(?)');
      params.push(filter.kind);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const sql = `SELECT ${DECISION_COLUMNS} FROM scrum_decisions ${where} ORDER BY recorded_at DESC`;
    return (await this.many(sql, ...params)) as DecisionRow[];
  }

  // ==========================================================================
  // Gated Codex write protocol (v21) — draft → approve | reject
  //
  // A decision recorded under a gated kind (adr | glossary | pattern) lands as a
  // DRAFT and is NOT durably accepted until its write-gate is approved:
  //   - adr / pattern require a HUMAN approve gate — any responder may approve.
  //   - glossary requires a TECH_LEAD REVIEW — the responder must currently hold
  //     a `tech_lead` slot on some team.
  // Approve flips the row to `status = 'accepted'`, `write_status = 'approved'`.
  // Reject sets `write_status = 'rejected'` and leaves the decision blocked (its
  // `status` stays `'draft'` — it never becomes accepted). Re-deciding an
  // already-resolved gate is refused, mirroring `respondGate`'s guard.
  // ==========================================================================

  /**
   * Approve a gated decision's write-gate, accepting it durably. Flips the row
   * to `status = 'accepted'`, `write_status = 'approved'`, and stamps the
   * responder + timestamp. For a `glossary` decision the responder MUST
   * currently hold a `tech_lead` slot on some team (the tech_lead review);
   * `adr`/`pattern` are a plain human gate with no role constraint.
   *
   * Rejects when: the decision is unknown; it is not a gated-kind draft (an
   * untyped/non-gated decision has no write-gate to approve); its gate is
   * already resolved (`approved`/`rejected`); or a `glossary` responder holds no
   * `tech_lead` slot anywhere. None of these mutate the row.
   *
   * Promotion retire (v28): when the approved decision carries a
   * `source_lore_id` (it was lifted via `promoteLoreToCodex`) and that source
   * Lore entry is still LIVE, approval retires the source mechanically —
   * `superseded_by = 'decision:<id>'`, reason `promoted to codex`. The Codex now
   * owns the content, so the source's replacement is determined, not judged;
   * the structural transition fires on approve, never on record (a draft could
   * still be rejected, which leaves the Lore untouched). A source already
   * superseded (e.g. folded into a consolidation between record and approve) is
   * left as-is — its supersession was resolved once, elsewhere.
   */
  async approveDecision(id: string, responder: string): Promise<DecisionRow> {
    const existing = await this.requireGatedDraft(id, 'approveDecision');
    if (existing.kind === TECH_LEAD_REVIEW_KIND && !(await this.holdsTechLeadAnywhere(responder))) {
      throw new Error(
        `approveDecision: glossary decision '${id}' requires a tech_lead review; '${responder}' holds no current tech_lead slot on any team`,
      );
    }
    const respondedAt = isoNow();
    const approve = async () => {
      await this.exec(
        "UPDATE scrum_decisions SET status = 'accepted', write_status = 'approved', gate_responder = ?, gate_responded_at = ? WHERE id = ?",
        responder,
        respondedAt,
        id,
      );
      if (existing.source_lore_id !== null) {
        await this.exec(
          'UPDATE scrum_lores SET superseded_by = ?, reason = ? WHERE id = ? AND superseded_by IS NULL',
          `decision:${id}`,
          'promoted to codex',
          existing.source_lore_id,
        );
      }
      return await this.requireDecision(id, 'approveDecision');
    };
    return await withTx(this.store, approve);
  }

  /**
   * Reject a gated decision's write-gate, blocking it. Sets `write_status =
   * 'rejected'` and stamps the responder + timestamp; the row's `status` stays
   * `'draft'` — a rejected decision NEVER becomes accepted. `reason` is recorded
   * on the row's `reason` column when supplied.
   *
   * Rejects (exit) when the decision is unknown, is not a gated-kind draft, or
   * its gate is already resolved — mirroring `approveDecision`. There is no
   * role constraint on rejection: any responder may reject any gated kind.
   */
  async rejectDecision(
    id: string,
    responder: string,
    reason: string | null = null,
  ): Promise<DecisionRow> {
    await this.requireGatedDraft(id, 'rejectDecision');
    const respondedAt = isoNow();
    await this.exec(
      "UPDATE scrum_decisions SET write_status = 'rejected', gate_responder = ?, gate_responded_at = ?, reason = ? WHERE id = ?",
      responder,
      respondedAt,
      reason,
      id,
    );
    return await this.requireDecision(id, 'rejectDecision');
  }

  /**
   * Load a decision and assert it is a gated-kind DRAFT awaiting a write-gate
   * decision. Throws on an unknown id, a non-gated decision (no write-gate), or
   * an already-resolved gate (`approved`/`rejected`). Shared guard for
   * `approveDecision`/`rejectDecision`, mirroring `respondGate`'s
   * already-resolved check.
   */
  private async requireGatedDraft(id: string, method: string): Promise<DecisionRow> {
    const existing = await this.getDecision(id);
    if (!existing) throw new Error(`${method}: unknown decision '${id}'`);
    if (existing.write_status === null) {
      throw new Error(
        `${method}: decision '${id}' is not gated (kind '${existing.kind ?? 'none'}'); it has no write-gate to resolve`,
      );
    }
    if (existing.write_status !== 'draft') {
      throw new Error(
        `${method}: decision '${id}' write-gate is already resolved ('${existing.write_status}'); it cannot be re-decided`,
      );
    }
    return existing;
  }

  /** Re-fetch a decision after a gate write, asserting it survived. */
  private async requireDecision(id: string, method: string): Promise<DecisionRow> {
    const row = await this.getDecision(id);
    if (!row) throw new Error(`${method}: decision '${id}' vanished mid-update`);
    return row;
  }

  /**
   * Whether `contributorId` is the CURRENT `tech_lead` holder of ANY team — the
   * tech_lead-review check for a `glossary` write-gate. "Current" is the
   * per-(team, tech_lead) latest OPEN interval (the `to_ts IS NULL` row with the
   * greatest `(from_ts, id)`), the same commutative max-fold `getTeamRoster`
   * uses, NOT a bare `to_ts IS NULL` open-row read: a contributor counts only
   * when they are the latest open tech_lead interval on some team, so a
   * concurrent rotation that superseded them (a later open interval) correctly
   * drops them even if their old row's `to_ts` never got stamped on rebase.
   */
  private async holdsTechLeadAnywhere(contributorId: string): Promise<boolean> {
    const row = await this.one(
      `SELECT 1 FROM scrum_team_members m
       WHERE m.role = 'tech_lead' AND m.contributor_id = ? AND m.to_ts IS NULL AND m.id = (
         SELECT m2.id FROM scrum_team_members m2
         WHERE m2.team_slug = m.team_slug AND m2.role = m.role AND m2.to_ts IS NULL
         ORDER BY m2.from_ts DESC, m2.id DESC LIMIT 1
       ) LIMIT 1`,
      contributorId,
    );
    return row !== null && row !== undefined;
  }

  // ==========================================================================
  // Contributors (v12)
  // ==========================================================================

  /**
   * Register a contributor — one row in the registry that backs role rosters,
   * attribution, and PR-comment author matching. The `id` is a CT-UUID minted
   * from `slug` when omitted (see `mintContributorId`); minted once and never
   * changed, so attribution survives a renamed handle or email. `slug` is
   * UNIQUE — re-registering the same slug throws a UNIQUE-constraint error
   * rather than silently overwriting; callers that mean to repair or merge an
   * existing row route through `reconcileContributor` instead.
   *
   * `created_by`/`last_modified_by` are seeded to the same agent and
   * `created_at`/`last_modified_at` to the same instant, mirroring how the
   * on-disk `contributor.md` identity artifact seeds its provenance block.
   */
  async registerContributor(input: RegisterContributorInput): Promise<Contributor> {
    const createdAt = input.createdAt ?? isoNow();
    const createdBy = this.actor(input.createdBy);
    const row: Contributor = {
      id: input.id && input.id.length > 0 ? input.id : mintContributorId(input.slug),
      slug: input.slug,
      status: input.status ?? 'active',
      display_name: input.displayName ?? null,
      github: input.github ?? null,
      email: input.email ?? null,
      created_by: createdBy,
      created_at: createdAt,
      last_modified_by: createdBy,
      last_modified_at: createdAt,
    };
    await this.exec(
      `INSERT INTO scrum_contributors (${CONTRIBUTOR_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.slug,
      row.status,
      row.display_name,
      row.github,
      row.email,
      row.created_by,
      row.created_at,
      row.last_modified_by,
      row.last_modified_at,
    );
    return row;
  }

  /** Fetch one contributor by CT-UUID, or null if missing. */
  async getContributor(id: string): Promise<Contributor | null> {
    const row = (await this.one(
      `SELECT ${CONTRIBUTOR_COLUMNS} FROM scrum_contributors WHERE id = ?`,
      id,
    )) as Contributor | null;
    return row ?? null;
  }

  /** Fetch one contributor by slug (the UNIQUE registry key), or null if missing. */
  async getContributorBySlug(slug: string): Promise<Contributor | null> {
    const row = (await this.one(
      `SELECT ${CONTRIBUTOR_COLUMNS} FROM scrum_contributors WHERE slug = ?`,
      slug,
    )) as Contributor | null;
    return row ?? null;
  }

  /**
   * Reconcile an EXISTING contributor row — the merge half of an idempotent
   * re-register (`registerContributor` throws on a duplicate slug, so repair
   * routes here). Present input fields override the stored values; absent
   * (`undefined`) fields are preserved, so a bare reconcile only bumps the
   * last-touch provenance pair — which makes it the re-emit path for a lost
   * `contributors/<slug>.md` identity artifact. The CT-UUID and the created-*
   * provenance pair never change: a present `id` acts as an identity guard and
   * a mismatch throws, since silently re-keying would orphan all attribution
   * history stamped under the original id.
   */
  async reconcileContributor(input: ReconcileContributorInput): Promise<Contributor> {
    const existing = await this.getContributorBySlug(input.slug);
    if (existing === null) {
      throw new Error(`unknown contributor slug '${input.slug}' — register it first`);
    }
    if (input.id !== undefined && input.id.length > 0 && input.id !== existing.id) {
      throw new Error(
        `slug '${input.slug}' is registered as ${existing.id}; --id ${input.id} conflicts (the CT-UUID is minted once and never changed)`,
      );
    }
    const row: Contributor = {
      ...existing,
      status: input.status ?? existing.status,
      display_name: input.displayName ?? existing.display_name,
      github: input.github ?? existing.github,
      email: input.email ?? existing.email,
      last_modified_by: this.actor(input.modifiedBy),
      last_modified_at: input.modifiedAt ?? isoNow(),
    };
    await this.exec(
      `UPDATE scrum_contributors
         SET status = ?, display_name = ?, github = ?, email = ?,
             last_modified_by = ?, last_modified_at = ?
       WHERE slug = ?`,
      row.status,
      row.display_name,
      row.github,
      row.email,
      row.last_modified_by,
      row.last_modified_at,
      row.slug,
    );
    return row;
  }

  /**
   * List contributors, optionally filtered by `status`, ordered by slug. Empty
   * filter returns all rows (active and inactive) — a retired contributor stays
   * in the registry so past attribution still resolves.
   */
  async listContributors(status?: ContributorStatus): Promise<Contributor[]> {
    if (status !== undefined) {
      return (await this.many(
        `SELECT ${CONTRIBUTOR_COLUMNS} FROM scrum_contributors WHERE status = ? ORDER BY slug ASC`,
        status,
      )) as Contributor[];
    }
    return (await this.many(
      `SELECT ${CONTRIBUTOR_COLUMNS} FROM scrum_contributors ORDER BY slug ASC`,
    )) as Contributor[];
  }

  /**
   * Resolve a worker / event author to a contributor. Tries the `github` key
   * first, then falls back to `email` — github is the stronger identity signal
   * (one handle per account), email is the fallback for authors that carry no
   * handle. Both matches are case-insensitive, since handles and addresses are
   * case-folded in practice. Returns null when neither key matches (or when the
   * key carries neither field). An inactive contributor still resolves — a
   * worker dispatched under a since-retired identity must still attribute.
   */
  async resolveContributor(key: ResolveContributorKey): Promise<Contributor | null> {
    const github = key.github && key.github.length > 0 ? key.github : null;
    if (github !== null) {
      const byGithub = (await this.one(
        `SELECT ${CONTRIBUTOR_COLUMNS} FROM scrum_contributors WHERE lower(github) = lower(?) LIMIT 1`,
        github,
      )) as Contributor | null;
      if (byGithub) return byGithub;
    }

    const email = key.email && key.email.length > 0 ? key.email : null;
    if (email !== null) {
      const byEmail = (await this.one(
        `SELECT ${CONTRIBUTOR_COLUMNS} FROM scrum_contributors WHERE lower(email) = lower(?) LIMIT 1`,
        email,
      )) as Contributor | null;
      if (byEmail) return byEmail;
    }

    return null;
  }

  // ==========================================================================
  // Operator-of-record position history (v13)
  // ==========================================================================

  /**
   * Set (or transfer) the operator-of-record to `contributorId`, appending a new
   * interval to the position history. This is the single role slot — a degenerate
   * one-row roster.
   *
   * Transfer is two writes in ONE transaction: the prior open row is closed by
   * stamping its `to_ts` to the new holder's `from_ts`, then the new open interval
   * is appended. The current holder is NOT "the single open row" (concurrent
   * offline transfers leave two opens that both land on rebase); it is the LATEST
   * OPEN interval — the `to_ts IS NULL` row with the greatest `(from_ts, id)`,
   * derived in `currentOperator` / the `scrum_current_operator` view. That fold
   * over the open rows is why two concurrent transfers converge: both appends
   * survive and every replica deterministically folds them to the same later
   * holder. Setting the SAME contributor still appends a fresh interval (a
   * re-affirmation is a new held interval, not a no-op).
   *
   * `contributorId` must be a registered contributor — an unknown id throws
   * rather than recording an unresolvable holder.
   */
  async setOperatorOfRecord(input: SetOperatorOfRecordInput): Promise<OperatorHistoryRow> {
    if ((await this.getContributor(input.contributorId)) === null) {
      throw new Error(`unknown contributor '${input.contributorId}' — register it first`);
    }
    const fromTs = input.fromTs ?? isoNow();
    const createdBy = this.actor(input.createdBy);

    const id = ulid();
    const append = async () => {
      // Close the prior open interval (if any) at the new holder's from_ts. This
      // no longer maintains a single-open invariant on its own — concurrent
      // offline transfers can leave two opens — but it keeps the history
      // well-formed; the current holder is the LATEST open row (max from_ts), so
      // the read converges even when this close races another writer's append.
      await this.exec('UPDATE scrum_operator_history SET to_ts = ? WHERE to_ts IS NULL', fromTs);
      await this.exec(
        'INSERT INTO scrum_operator_history (id, contributor_id, from_ts, to_ts, created_at, created_by) VALUES (?, ?, ?, NULL, ?, ?)',
        id,
        input.contributorId,
        fromTs,
        isoNow(),
        createdBy,
      );
    };
    await withTx(this.store, append);

    const row = (await this.one(
      `SELECT ${OPERATOR_HISTORY_COLUMNS} FROM scrum_operator_history WHERE id = ?`,
      id,
    )) as OperatorHistoryRow;
    return row;
  }

  /**
   * Resolve the contributor who CURRENTLY holds operator-of-record — the LATEST
   * OPEN interval, i.e. the single max-fold row `WHERE to_ts IS NULL ORDER BY
   * from_ts DESC, id DESC LIMIT 1` over the append-only position history. Returns
   * the `scrum_contributors` row, or null when the role is unset or vacated (no
   * open intervals).
   *
   * Folding the open rows to the greatest `(from_ts, id)` is the commutative
   * derivation that survives concurrent offline transfers: two operators that
   * each append a new open interval both land their rows on rebase, and this fold
   * deterministically picks the later one — so every replica converges to the
   * SAME current operator regardless of push order. The pre-fix read took EVERY
   * `to_ts IS NULL` row and trusted the set-then-append to keep exactly one;
   * concurrent transfers break that, leaving two opens. The fold collapses them
   * by construction. Reads the shared `scrum_current_operator` view (now defined
   * as that fold) so the CLI and the review-ui boundary share ONE current-holder
   * definition; point-in-time-at-an-instant stays the parameterized
   * `operatorOfRecordAt` scan.
   */
  async currentOperator(): Promise<Contributor | null> {
    const holder = (await this.one(
      'SELECT contributor_id FROM scrum_current_operator LIMIT 1',
    )) as {
      contributor_id: string;
    } | null;
    if (holder === null) return null;
    return await this.getContributor(holder.contributor_id);
  }

  /**
   * Resolve the contributor who held operator-of-record AT `at` (an ISO-8601
   * instant) — POINT-IN-TIME attribution, not the current holder. Returns the
   * `scrum_contributors` row whose half-open interval `[from_ts, to_ts)` contains
   * `at`, or null when no holder was in effect at that instant (e.g. `at`
   * predates the first interval, or the role was never set).
   *
   * The historical holder can differ from the current holder — an action stamped
   * before a handoff attributes to whoever held the role then, not now. Intervals
   * never overlap (the set-then-append invariant), so at most one row matches.
   * Ties on a shared boundary instant resolve to the LATER interval: the upper
   * bound is exclusive (`at < to_ts`), the lower inclusive (`from_ts <= at`).
   */
  async operatorOfRecordAt(at: string): Promise<Contributor | null> {
    const interval = (await this.one(
      'SELECT contributor_id FROM scrum_operator_history WHERE from_ts <= ? AND (to_ts IS NULL OR ? < to_ts) ORDER BY from_ts DESC LIMIT 1',
      at,
      at,
    )) as { contributor_id: string } | null;
    if (interval === null) return null;
    return await this.getContributor(interval.contributor_id);
  }

  /**
   * The full operator-of-record position history, oldest interval first. The
   * last row carries `to_ts: null` when a current holder is set. Empty when the
   * role was never set.
   */
  async operatorHistory(): Promise<OperatorHistoryRow[]> {
    return (await this.many(
      `SELECT ${OPERATOR_HISTORY_COLUMNS} FROM scrum_operator_history ORDER BY from_ts ASC, id ASC`,
    )) as OperatorHistoryRow[];
  }

  // ==========================================================================
  // Teams (v14)
  // ==========================================================================

  /**
   * Create a team — one row in the registry, the unit a body of work and the
   * artifacts it owns are organized around. `slug` is the primary key and is
   * UNIQUE — re-registering the same slug throws a UNIQUE-constraint error rather
   * than silently overwriting (a team's fields are edited deliberately, not
   * clobbered by a re-create).
   *
   * `teamType` and `lifetime` are guarded against their closed vocabularies at
   * this boundary (the columns carry no SQL CHECK), so an off-vocabulary value
   * throws here rather than landing as an unrecognized string. `lifetime`
   * defaults to `'persistent'`; `charter` defaults to NULL. A fresh team is
   * always `status = 'active'`.
   *
   * The lifetime↔target consistency rule is enforced here: a
   * `terminates_on_milestone` team MUST carry a `terminatesOnMilestone`, and a
   * `persistent` team MUST NOT. A target may instead be attached after creation
   * with `setTeamTerminatesOn` (the create-then-set flow); creation with a
   * mismatched pair throws rather than landing an inconsistent row.
   */
  async createTeam(input: CreateTeamInput): Promise<Team> {
    const lifetime = input.lifetime ?? 'persistent';
    if (!(TEAM_TYPES as string[]).includes(input.teamType)) {
      throw new Error(
        `createTeam: invalid team_type '${input.teamType}'; expected one of: ${TEAM_TYPES.join(', ')}`,
      );
    }
    if (!(TEAM_LIFETIMES as string[]).includes(lifetime)) {
      throw new Error(
        `createTeam: invalid lifetime '${lifetime}'; expected one of: ${TEAM_LIFETIMES.join(', ')}`,
      );
    }
    const target = input.terminatesOnMilestone ?? null;
    assertLifetimeTargetConsistent('createTeam', lifetime as TeamLifetime, target);
    const row: Team = {
      slug: input.slug,
      team_type: input.teamType as TeamType,
      charter: input.charter ?? null,
      lifetime: lifetime as TeamLifetime,
      terminates_on_milestone: target,
      status: 'active',
      created_at: input.createdAt ?? isoNow(),
    };
    await this.exec(
      `INSERT INTO scrum_teams (${TEAM_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      row.slug,
      row.team_type,
      row.charter,
      row.lifetime,
      row.terminates_on_milestone,
      row.status,
      row.created_at,
    );
    return row;
  }

  /** Fetch one team by slug, or null if missing. */
  async getTeam(slug: string): Promise<Team | null> {
    const row = (await this.one(
      `SELECT ${TEAM_COLUMNS} FROM scrum_teams WHERE slug = ?`,
      slug,
    )) as Team | null;
    return row ?? null;
  }

  /** List every team, ordered by slug. */
  async listTeams(): Promise<Team[]> {
    return (await this.many(`SELECT ${TEAM_COLUMNS} FROM scrum_teams ORDER BY slug ASC`)) as Team[];
  }

  /**
   * Attach (or clear) a team's `terminates_on_milestone` target, enforcing the
   * same lifetime↔target consistency rule as `createTeam`: a
   * `terminates_on_milestone` team MUST carry a target, a `persistent` team MUST
   * NOT. This is the create-then-set half of the ergonomics — a team registered
   * as `terminates_on_milestone` without yet knowing its goal milestone can have
   * the target attached once it is decided. Passing `null` clears the target,
   * which is only valid for a `persistent` team. Throws on an unknown slug and on
   * a rule violation. Returns the updated row.
   */
  async setTeamTerminatesOn(slug: string, milestoneId: string | null): Promise<Team> {
    const existing = await this.getTeam(slug);
    if (existing === null) {
      throw new Error(`setTeamTerminatesOn: unknown team '${slug}'`);
    }
    assertLifetimeTargetConsistent('setTeamTerminatesOn', existing.lifetime, milestoneId);
    await this.exec(
      'UPDATE scrum_teams SET terminates_on_milestone = ? WHERE slug = ?',
      milestoneId,
      slug,
    );
    return { ...existing, terminates_on_milestone: milestoneId };
  }

  // ==========================================================================
  // Team scope globs (v15)
  // ==========================================================================

  /**
   * Replace a team's scope globs (the read and write path-glob sets), inside one
   * transaction. The team's prior scope rows are deleted and the new ones
   * inserted, so this is a full REPLACE, not a merge — passing `{ read: [],
   * write: [] }` clears the team's scopes.
   *
   * Before writing, the WRITE side is validated against the single-writer-per-path
   * rule: across the whole registry, no two teams may declare write globs that
   * could match the same path (see `validateTeamWriteScopes`). The candidate
   * write set for THIS team is the proposed `write` array; every OTHER team's
   * write set is read from the store. On any overlap the method throws with a
   * message naming BOTH conflicting teams and the overlapping globs, and nothing
   * is written. READ globs are never checked — they may overlap freely.
   *
   * The team must exist (the FK target) — an unknown slug throws. Input globs are
   * deduped before write; `kind` values are guarded against the closed
   * `TeamScopeKind` set.
   */
  async setTeamScopes(slug: string, scopes: TeamScopes): Promise<TeamScopes> {
    if ((await this.getTeam(slug)) === null) {
      throw new Error(`setTeamScopes: unknown team '${slug}'`);
    }
    const read = dedupeGlobs(scopes.read);
    const write = dedupeGlobs(scopes.write);

    // Validate the candidate write set against every OTHER team's write set
    // before mutating, so a rejected set leaves the store untouched.
    const conflict = await this.findWriteScopeConflict(slug, write);
    if (conflict !== null) {
      throw new Error(formatWriteScopeConflict(conflict));
    }

    const replace = async () => {
      await this.exec('DELETE FROM scrum_team_scopes WHERE team_slug = ?', slug);
      const insert = await this.prep(
        'INSERT INTO scrum_team_scopes (team_slug, kind, glob) VALUES (?, ?, ?)',
      );
      for (const glob of read) await insert.run(slug, 'read' satisfies TeamScopeKind, glob);
      for (const glob of write) await insert.run(slug, 'write' satisfies TeamScopeKind, glob);
    };
    await withTx(this.store, replace);

    return await this.getTeamScopes(slug);
  }

  /**
   * Fetch a team's scope globs, grouped by side. Returns
   * `{ read: [], write: [] }` for a team with no declared scopes (and also for an
   * unknown slug — the absence reads as "no scopes" rather than an error, matching
   * the unscoped default). Both arrays are sorted for a canonical shape.
   */
  async getTeamScopes(slug: string): Promise<TeamScopes> {
    const rows = (await this.many(
      'SELECT kind, glob FROM scrum_team_scopes WHERE team_slug = ? ORDER BY kind ASC, glob ASC',
      slug,
    )) as Array<{ kind: string; glob: string }>;
    const read: string[] = [];
    const write: string[] = [];
    for (const row of rows) {
      if (row.kind === 'write') write.push(row.glob);
      else read.push(row.glob);
    }
    return { read, write };
  }

  /**
   * Validate the WRITE scopes of every team against the single-writer-per-path
   * rule and return the first cross-team overlap, or null when all write scopes
   * are pairwise disjoint. The load-time check a caller runs over the whole
   * registry; `setTeamScopes` runs the same check scoped to one mutating team.
   *
   * Teams are compared in slug order so the returned conflict is deterministic.
   * READ scopes are never inspected — only write-vs-write overlap matters.
   */
  async validateTeamWriteScopes(): Promise<TeamWriteScopeConflict | null> {
    const teams = (await this.listTeams()).map((t) => t.slug);
    const writeBySlug = new Map<string, string[]>();
    for (const slug of teams) writeBySlug.set(slug, (await this.getTeamScopes(slug)).write);

    for (let i = 0; i < teams.length; i++) {
      for (let j = i + 1; j < teams.length; j++) {
        const slugA = teams[i] as string;
        const slugB = teams[j] as string;
        const conflict = firstGlobOverlap(
          slugA,
          writeBySlug.get(slugA) ?? [],
          slugB,
          writeBySlug.get(slugB) ?? [],
        );
        if (conflict !== null) return conflict;
      }
    }
    return null;
  }

  /**
   * Find the first write-scope overlap between a candidate team's proposed write
   * globs and every OTHER team's stored write globs, or null when the candidate
   * set is disjoint from all of them. The single-team scoping of
   * `validateTeamWriteScopes`, used by `setTeamScopes` to reject a write set
   * before persisting it. The candidate team is excluded from the comparison so a
   * team's existing rows (about to be replaced) never conflict with its own
   * proposed set.
   */
  private async findWriteScopeConflict(
    candidateSlug: string,
    candidateWrite: string[],
  ): Promise<TeamWriteScopeConflict | null> {
    for (const team of await this.listTeams()) {
      if (team.slug === candidateSlug) continue;
      const otherWrite = (await this.getTeamScopes(team.slug)).write;
      const conflict = firstGlobOverlap(candidateSlug, candidateWrite, team.slug, otherWrite);
      if (conflict !== null) return conflict;
    }
    return null;
  }

  // ==========================================================================
  // Team roster — three-role position history (v16)
  // ==========================================================================

  /**
   * Rotate a team's role slot to `contributorId`, appending a new interval to
   * that (team, role) position history. The per-(team, role) generalization of
   * `setOperatorOfRecord`.
   *
   * Rotation is two writes in ONE transaction: the prior open row for THAT
   * (team_slug, role) is closed by stamping its `to_ts` to the new holder's
   * `from_ts`, then the new open interval is appended. The current holder of a
   * slot is NOT "the single open row" but the LATEST OPEN interval — the per-(team,
   * role) `to_ts IS NULL` row with the greatest `(from_ts, id)`, derived in
   * `getTeamRoster` — so two concurrent offline rotations of the same slot
   * converge (both appends land on rebase and every replica folds them to the
   * same later holder) instead of leaving a dual-open hazard. Rotating in the
   * SAME contributor still appends a fresh interval (a re-affirmation is a new
   * held interval, not a no-op).
   *
   * `teamSlug` must be a registered team and `role` must be one of the closed
   * `TeamRole` set — both guarded at this boundary (the columns carry no SQL
   * CHECK / foreign key on `role`). `contributorId` is a soft reference and is
   * NOT validated against the contributor registry, mirroring the operator
   * history.
   *
   * Multi-slot is PERMITTED: when the rotated-in contributor already holds
   * ANOTHER open role on the SAME team, the rotation still completes and a
   * `warning` is returned (never a rejection) — the team-of-one case where one
   * person fills multiple slots. The open-slot check reads the state BEFORE the
   * rotation so re-affirming the same role does not self-trigger the warning.
   */
  async rotateTeamMember(input: RotateTeamMemberInput): Promise<RotateTeamMemberResult> {
    if ((await this.getTeam(input.teamSlug)) === null) {
      throw new Error(`rotateTeamMember: unknown team '${input.teamSlug}'`);
    }
    if (!(TEAM_ROLES as string[]).includes(input.role)) {
      throw new Error(
        `rotateTeamMember: invalid role '${input.role}'; expected one of: ${TEAM_ROLES.join(', ')}`,
      );
    }
    const fromTs = input.fromTs ?? isoNow();
    const reason = input.reason ?? null;

    // Read the multi-slot state BEFORE mutating, so re-affirming the same role
    // is never mistaken for occupying a second slot.
    const otherOpenRoles = (await this.openRolesHeldBy(input.teamSlug, input.contributorId)).filter(
      (role) => role !== input.role,
    );

    const id = ulid();
    const append = async () => {
      // Close the prior open interval for THIS (team, role) at the new holder's
      // from_ts. This keeps the history well-formed but no longer enforces a
      // single-open invariant alone (concurrent offline rotations can leave two
      // opens); the current slot holder is the LATEST open row (max from_ts), so
      // the read converges even when this close races another writer's append.
      await this.exec(
        'UPDATE scrum_team_members SET to_ts = ? WHERE team_slug = ? AND role = ? AND to_ts IS NULL',
        fromTs,
        input.teamSlug,
        input.role,
      );
      await this.exec(
        'INSERT INTO scrum_team_members (id, team_slug, role, contributor_id, from_ts, to_ts, reason, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)',
        id,
        input.teamSlug,
        input.role,
        input.contributorId,
        fromTs,
        reason,
        isoNow(),
      );
    };
    await withTx(this.store, append);

    const row = (await this.one(
      `SELECT ${TEAM_MEMBER_COLUMNS} FROM scrum_team_members WHERE id = ?`,
      id,
    )) as TeamMemberRow;

    const warning =
      otherOpenRoles.length > 0
        ? `${input.contributorId} now holds multiple roles on '${input.teamSlug}': ${[
            input.role,
            ...otherOpenRoles,
          ]
            .sort()
            .join(', ')}`
        : null;
    return { row, warning };
  }

  /**
   * The role slots `contributorId` currently holds on `teamSlug` — every
   * (team, role) whose CURRENT holder (the latest OPEN interval: the `to_ts IS
   * NULL` row with the greatest `(from_ts, id)`, NOT a bare `to_ts IS NULL`)
   * names this contributor. The same commutative max-fold the roster read uses,
   * so the multi-slot warning in `rotateTeamMember` reflects the converged
   * current holders rather than a possibly-dual-open `to_ts` set.
   */
  private async openRolesHeldBy(teamSlug: string, contributorId: string): Promise<TeamRole[]> {
    const rows = (await this.many(
      `SELECT m.role FROM scrum_team_members m
       WHERE m.team_slug = ? AND m.contributor_id = ? AND m.to_ts IS NULL AND m.id = (
         SELECT m2.id FROM scrum_team_members m2
         WHERE m2.team_slug = m.team_slug AND m2.role = m.role AND m2.to_ts IS NULL
         ORDER BY m2.from_ts DESC, m2.id DESC LIMIT 1
       )`,
      teamSlug,
      contributorId,
    )) as Array<{ role: string }>;
    return rows.map((r) => r.role as TeamRole);
  }

  /**
   * A team's roster — the current holder of each of the three role slots, and
   * optionally the full per-role position history. Tolerates an unknown slug:
   * the returned `current` simply maps every role to null (the absence reads as
   * "no holders" rather than an error, matching `getTeamScopes`).
   *
   * Each role in `current` maps to its CURRENT `TeamMemberRow` — the latest OPEN
   * interval for that (team, role): the per-partition max-fold row `to_ts IS NULL`
   * with the greatest `(from_ts, id)` — or null when the slot was never filled or
   * has been vacated (no open intervals). The fold over the open rows (not a bare
   * `to_ts IS NULL` that trusts a single open) is the commutative derivation that
   * survives concurrent offline rotations: two writers that each append a new open
   * interval for the same slot both land their rows on rebase, and the fold picks
   * the later one — so every replica converges to the SAME holder regardless of
   * push order, eliminating the dual-open role-slot hazard by construction. With
   * `includeHistory: true`, `history` carries every interval for the team,
   * oldest-first, grouped by role.
   */
  async getTeamRoster(slug: string, opts: { includeHistory?: boolean } = {}): Promise<TeamRoster> {
    const current = this.emptyRoleMap<TeamMemberRow | null>(null);
    const currentRows = (await this.many(
      `SELECT ${TEAM_MEMBER_COLUMNS} FROM scrum_team_members m
       WHERE m.team_slug = ? AND m.to_ts IS NULL AND m.id = (
         SELECT m2.id FROM scrum_team_members m2
         WHERE m2.team_slug = m.team_slug AND m2.role = m.role AND m2.to_ts IS NULL
         ORDER BY m2.from_ts DESC, m2.id DESC LIMIT 1
       )`,
      slug,
    )) as TeamMemberRow[];
    for (const row of currentRows) current[row.role] = row;

    if (opts.includeHistory !== true) {
      return { slug, current };
    }

    const history = this.emptyRoleMap<TeamMemberRow[]>([]);
    const allRows = (await this.many(
      `SELECT ${TEAM_MEMBER_COLUMNS} FROM scrum_team_members WHERE team_slug = ? ORDER BY from_ts ASC, id ASC`,
      slug,
    )) as TeamMemberRow[];
    for (const row of allRows) history[row.role].push(row);
    return { slug, current, history };
  }

  /** Build a fresh `Record<TeamRole, V>` seeded with `seed` for every role. */
  private emptyRoleMap<V>(seed: V): Record<TeamRole, V> {
    const map = {} as Record<TeamRole, V>;
    for (const role of TEAM_ROLES) {
      map[role] = Array.isArray(seed) ? ([...seed] as V) : seed;
    }
    return map;
  }

  // ==========================================================================
  // Team interface — accepts / exposes, append-only with supersession (v17)
  // ==========================================================================

  /**
   * Add an ask type a team ACCEPTS — one `active` row in the team's accept
   * interface. The team must exist (the FK target) — an unknown slug throws.
   * `askType` must be kebab-case (`^[a-z0-9]+(-[a-z0-9]+)*$`); a non-conforming
   * value throws at this boundary rather than landing as a malformed row.
   *
   * Append-only: the row is added, never replacing or removing a prior entry.
   * Retiring an ask type is an explicit `supersedeTeamAccept`, not a delete.
   */
  async addTeamAccept(
    teamSlug: string,
    askType: string,
    createdAt?: string,
  ): Promise<TeamAcceptRow> {
    if ((await this.getTeam(teamSlug)) === null) {
      throw new Error(`addTeamAccept: unknown team '${teamSlug}'`);
    }
    if (!ASK_TYPE_PATTERN.test(askType)) {
      throw new Error(
        `addTeamAccept: invalid ask_type '${askType}'; expected kebab-case (e.g. 'schema-change')`,
      );
    }
    const id = ulid();
    await this.exec(
      'INSERT INTO scrum_team_accepts (id, team_slug, ask_type, status, superseded_by, reason, created_at) VALUES (?, ?, ?, ?, NULL, NULL, ?)',
      id,
      teamSlug,
      askType,
      'active' satisfies TeamInterfaceStatus,
      createdAt ?? isoNow(),
    );
    return (await this.one(
      `SELECT ${TEAM_ACCEPT_COLUMNS} FROM scrum_team_accepts WHERE id = ?`,
      id,
    )) as TeamAcceptRow;
  }

  /**
   * Add an output a team EXPOSES — one `active` row in the team's expose
   * interface. The team must exist — an unknown slug throws. `name` and
   * `schemaRef` are free text and not format-validated.
   *
   * Append-only: retiring an exposed output is an explicit `supersedeTeamExpose`,
   * never a delete — removing a published interface is a backward-compatibility
   * hazard that must stay auditable.
   */
  async addTeamExpose(teamSlug: string, input: AddTeamExposeInput): Promise<TeamExposeRow> {
    if ((await this.getTeam(teamSlug)) === null) {
      throw new Error(`addTeamExpose: unknown team '${teamSlug}'`);
    }
    const id = ulid();
    await this.exec(
      'INSERT INTO scrum_team_exposes (id, team_slug, name, schema_ref, status, superseded_by, reason, created_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)',
      id,
      teamSlug,
      input.name,
      input.schemaRef,
      'active' satisfies TeamInterfaceStatus,
      input.createdAt ?? isoNow(),
    );
    return (await this.one(
      `SELECT ${TEAM_EXPOSE_COLUMNS} FROM scrum_team_exposes WHERE id = ?`,
      id,
    )) as TeamExposeRow;
  }

  /**
   * Supersede an accept entry in place (append-only). Flips its `status` to
   * `superseded`, records `reason`, and optionally points `superseded_by` at a
   * replacement accept id. Never removes the row — the retired entry stays for
   * audit, mirroring `supersedeCriterion` and `supersedeDecision`. Rejects an
   * unknown id and an already-superseded target.
   */
  async supersedeTeamAccept(
    id: string,
    reason: string,
    supersededBy?: string | null,
  ): Promise<TeamAcceptRow> {
    const target = (await this.one(
      `SELECT ${TEAM_ACCEPT_COLUMNS} FROM scrum_team_accepts WHERE id = ?`,
      id,
    )) as TeamAcceptRow | null;
    if (target === null) {
      throw new Error(`supersedeTeamAccept: unknown accept id '${id}'`);
    }
    if (target.status === 'superseded') {
      throw new Error(`supersedeTeamAccept: accept id '${id}' is already superseded`);
    }
    await this.exec(
      'UPDATE scrum_team_accepts SET status = ?, reason = ?, superseded_by = ? WHERE id = ?',
      'superseded' satisfies TeamInterfaceStatus,
      reason,
      supersededBy ?? null,
      id,
    );
    return (await this.one(
      `SELECT ${TEAM_ACCEPT_COLUMNS} FROM scrum_team_accepts WHERE id = ?`,
      id,
    )) as TeamAcceptRow;
  }

  /**
   * Supersede an expose entry in place (append-only). Flips its `status` to
   * `superseded`, records `reason`, and optionally points `superseded_by` at a
   * replacement expose id. Never removes the row. Rejects an unknown id and an
   * already-superseded target.
   */
  async supersedeTeamExpose(
    id: string,
    reason: string,
    supersededBy?: string | null,
  ): Promise<TeamExposeRow> {
    const target = (await this.one(
      `SELECT ${TEAM_EXPOSE_COLUMNS} FROM scrum_team_exposes WHERE id = ?`,
      id,
    )) as TeamExposeRow | null;
    if (target === null) {
      throw new Error(`supersedeTeamExpose: unknown expose id '${id}'`);
    }
    if (target.status === 'superseded') {
      throw new Error(`supersedeTeamExpose: expose id '${id}' is already superseded`);
    }
    await this.exec(
      'UPDATE scrum_team_exposes SET status = ?, reason = ?, superseded_by = ? WHERE id = ?',
      'superseded' satisfies TeamInterfaceStatus,
      reason,
      supersededBy ?? null,
      id,
    );
    return (await this.one(
      `SELECT ${TEAM_EXPOSE_COLUMNS} FROM scrum_team_exposes WHERE id = ?`,
      id,
    )) as TeamExposeRow;
  }

  /**
   * A team's published interface — its accept and expose entries. By default
   * only `active` entries are returned; `includeSuperseded: true` returns the
   * full history (active and retired) for audit. Both arrays are ordered by id.
   * Tolerates an unknown slug: both arrays are empty (the absence reads as "no
   * interface" rather than an error, matching `getTeamScopes`).
   */
  async getTeamInterface(
    slug: string,
    opts: { includeSuperseded?: boolean } = {},
  ): Promise<TeamInterface> {
    const accepts = await this.listTeamAccepts(slug, opts);
    const exposes = await this.listTeamExposes(slug, opts);
    return { slug, accepts, exposes };
  }

  /**
   * A team's accept entries, ordered by id. Active-only by default;
   * `includeSuperseded: true` includes retired entries. Tolerates an unknown
   * slug (returns an empty array).
   */
  async listTeamAccepts(
    slug: string,
    opts: { includeSuperseded?: boolean } = {},
  ): Promise<TeamAcceptRow[]> {
    const where =
      opts.includeSuperseded === true ? 'team_slug = ?' : "team_slug = ? AND status = 'active'";
    return (await this.many(
      `SELECT ${TEAM_ACCEPT_COLUMNS} FROM scrum_team_accepts WHERE ${where} ORDER BY id ASC`,
      slug,
    )) as TeamAcceptRow[];
  }

  /**
   * A team's expose entries, ordered by id. Active-only by default;
   * `includeSuperseded: true` includes retired entries. Tolerates an unknown
   * slug (returns an empty array).
   */
  async listTeamExposes(
    slug: string,
    opts: { includeSuperseded?: boolean } = {},
  ): Promise<TeamExposeRow[]> {
    const where =
      opts.includeSuperseded === true ? 'team_slug = ?' : "team_slug = ? AND status = 'active'";
    return (await this.many(
      `SELECT ${TEAM_EXPOSE_COLUMNS} FROM scrum_team_exposes WHERE ${where} ORDER BY id ASC`,
      slug,
    )) as TeamExposeRow[];
  }

  // ==========================================================================
  // Cross-team ask protocol (v23)
  // ==========================================================================

  /**
   * File a cross-team ask — record one `'filed'` row in `scrum_asks`. The ask is
   * the request a worker raises when its work is blocked on a sibling team's
   * published interface: `fromTeam` needs `toTeam` to handle `askType`, and
   * `blockingArtifact` stays blocked until it does.
   *
   * Three validations run at this boundary, each throwing a domain error rather
   * than landing a malformed row:
   *   1. `toTeam` must resolve — an unknown target team is rejected.
   *   2. `askType` must be one of `toTeam`'s ACTIVE accepted ask types — a team
   *      can only be asked for what it has published it accepts.
   *   3. `blockingArtifact` must be an existing task id.
   * `fromTeam` is validated too (it is an FK target), but the spec-bearing checks
   * are the three above. The insert and the `ask_filed` audit event ride one
   * transaction, so a failure leaves the store untouched. Returns the new row.
   */
  async fileAsk(input: FileAskInput): Promise<AskRow> {
    if ((await this.getTeam(input.fromTeam)) === null) {
      throw new Error(`fileAsk: unknown from_team '${input.fromTeam}'`);
    }
    if ((await this.getTeam(input.toTeam)) === null) {
      throw new Error(`fileAsk: unknown to_team '${input.toTeam}'`);
    }
    const accepted = (await this.listTeamAccepts(input.toTeam)).map((a) => a.ask_type);
    if (!accepted.includes(input.askType)) {
      throw new Error(
        `fileAsk: ask_type '${input.askType}' is not accepted by to_team '${input.toTeam}'; accepted: ${accepted.length > 0 ? accepted.join(', ') : '(none)'}`,
      );
    }
    if ((await this.getTask(input.blockingArtifact)) === null) {
      throw new Error(`fileAsk: unknown blocking_artifact '${input.blockingArtifact}'`);
    }

    const createdAt = input.createdAt ?? isoNow();
    const id = ulid();
    const tx = async () => {
      await this.exec(
        'INSERT INTO scrum_asks (id, from_team, to_team, ask_type, blocking_artifact, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        id,
        input.fromTeam,
        input.toTeam,
        input.askType,
        input.blockingArtifact,
        'filed' satisfies AskState,
        createdAt,
      );
      // Audit the filing against the blocking artifact's event timeline so the
      // task that triggered the ask carries the cross-team request in its history.
      await this.appendEvent({
        taskId: input.blockingArtifact,
        kind: 'ask_filed',
        ts: createdAt,
        payload: {
          ask_id: id,
          from_team: input.fromTeam,
          to_team: input.toTeam,
          ask_type: input.askType,
        },
      });
    };
    await withTx(this.store, tx);
    return (await this.one(`SELECT ${ASK_COLUMNS} FROM scrum_asks WHERE id = ?`, id)) as AskRow;
  }

  /** Fetch one ask by id, or null if missing. */
  async getAsk(id: string): Promise<AskRow | null> {
    const row = (await this.one(
      `SELECT ${ASK_COLUMNS} FROM scrum_asks WHERE id = ?`,
      id,
    )) as AskRow | null;
    return row ?? null;
  }

  /**
   * Apply a triage verdict to a `filed` ask — the MECHANICAL response step. The
   * driver (a skill, a native Agent-tool subagent, or an interactive gate) makes
   * the accept/reject/counter judgment elsewhere; THIS method spawns no model
   * and invokes no Agent — it applies `input.verdict` deterministically. Each
   * verdict and its effect:
   *
   *   accept  — create exactly ONE child task under the to-team's tree (a
   *             `story` by default, or `epic`), tagged with the to-team slug so
   *             a reader can find which team owns it (teams carry no root-task
   *             anchor, so the tag IS the team linkage). Set the ask's
   *             `mapped_artifact` to the child id, and add a `blocked_by` dep
   *             from the from-team's `blocking_artifact` onto the child — the
   *             blocking artifact stays blocked until the new child completes.
   *             State → `accepted`.
   *   reject  — record `rejected_reason` (the `comment`); mutate NOTHING in the
   *             tree or deps. State → `rejected`.
   *   counter — record `counter_proposal` (the `comment`); mutate NOTHING in the
   *             tree or deps. State → `countered`.
   *
   * Every effect rides ONE transaction (child create + dep + ask update + the
   * `ask_responded` event), so a failure leaves the store untouched. The
   * `ask_responded` event lands on the blocking artifact's timeline, mirroring
   * how `fileAsk` audits `ask_filed` there. Rejects: an unknown id, an
   * off-vocabulary verdict, and a non-`filed` ask (an ask is responded to
   * exactly once). Returns the updated row.
   */
  async respondAsk(input: RespondAskInput): Promise<AskRow> {
    if (!(ASK_VERDICTS as string[]).includes(input.verdict)) {
      throw new Error(
        `respondAsk: invalid verdict '${input.verdict}'; expected one of: ${ASK_VERDICTS.join(', ')}`,
      );
    }
    const existing = await this.getAsk(input.id);
    if (existing === null) {
      throw new Error(`respondAsk: unknown ask id '${input.id}'`);
    }
    if (existing.state !== 'filed') {
      throw new Error(
        `respondAsk: ask ${input.id} is '${existing.state}', not 'filed'; only a filed ask can be responded to`,
      );
    }

    const verdict: AskVerdict = input.verdict;
    const nextState: AskState = ASK_VERDICT_STATE[verdict];
    const respondedAt = input.respondedAt ?? isoNow();
    const comment = input.comment ?? null;
    const childLayer = input.childLayer ?? 'story';

    const apply = async (): Promise<AskRow> => {
      let mappedArtifact: string | null = null;
      let rejectedReason: string | null = null;
      let counterProposal: string | null = null;

      if (verdict === 'accept') {
        // Create exactly one child under the to-team's tree. Teams carry no
        // root-task anchor, so the child is a standalone layered task tagged
        // with the to-team slug (the team linkage the existing model allows).
        const childId =
          input.childId !== undefined && input.childId.length > 0
            ? input.childId
            : `ask-${existing.id}-${childLayer}-${ulid()}`;
        const childTitle =
          input.childTitle !== undefined && input.childTitle.length > 0
            ? input.childTitle
            : `${existing.to_team}: ${existing.ask_type} (ask ${existing.id})`;
        await this.createTask({
          id: childId,
          title: childTitle,
          layer: childLayer,
          tags: [existing.to_team],
          createdByAgent: input.respondedBy ?? null,
          createdAt: respondedAt,
        });
        // The from-team's blocking artifact is blocked_by the new child: it
        // stays blocked until the child completes.
        await this.addDep(existing.blocking_artifact, childId, 'blocked_by');
        mappedArtifact = childId;
      } else if (verdict === 'reject') {
        rejectedReason = comment;
      } else {
        counterProposal = comment;
      }

      await this.exec(
        'UPDATE scrum_asks SET state = ?, mapped_artifact = ?, rejected_reason = ?, counter_proposal = ? WHERE id = ?',
        nextState,
        mappedArtifact,
        rejectedReason,
        counterProposal,
        existing.id,
      );

      // Audit the response against the blocking artifact's event timeline, the
      // same timeline `fileAsk` recorded `ask_filed` on.
      await this.appendEvent({
        taskId: existing.blocking_artifact,
        kind: 'ask_responded',
        ts: respondedAt,
        agent: input.respondedBy ?? null,
        payload: {
          ask_id: existing.id,
          verdict,
          state: nextState,
          mapped_artifact: mappedArtifact,
          rejected_reason: rejectedReason,
          counter_proposal: counterProposal,
        },
      });

      return (await this.one(
        `SELECT ${ASK_COLUMNS} FROM scrum_asks WHERE id = ?`,
        existing.id,
      )) as AskRow;
    };
    return await withTx(this.store, apply);
  }

  /**
   * Poll a filed ask and report its mechanical phase — the read primitive the
   * team-as-workflow-kind sugar composes. A `kind:<team-slug>` workflow step
   * files an ask, the driver triages and responds, and the step then polls THIS
   * method until it reports a TERMINAL phase. The dividing line is the engine
   * boundary: filing and responding are mutations the driver drives; computing
   * "is it answered yet, and if accepted is the child done, and what does the
   * to-team expose" is pure derivation — so it spawns no model and never mutates.
   *
   * The phase derives from the ask's `state` plus, when accepted, the
   * `mapped_artifact` child task's `status`:
   *   - `filed`     → `pending`   (NON-terminal — poll again)
   *   - `accepted`  → `waiting`   when the child is not yet `done` (NON-terminal)
   *   - `accepted`  → `ready`     when the child IS `done`; `outputs` carries the
   *                               to-team's ACTIVE exposes (TERMINAL success)
   *   - `rejected`  → `rejected`  with `reason = rejected_reason` (TERMINAL)
   *   - `countered` → `countered` with `reason = counter_proposal` (TERMINAL)
   *
   * `outputs` is populated ONLY on `ready` — the to-team's exposed outputs are
   * the value the step returns. Reject/counter set a non-null `reason` so the
   * calling script surfaces a terminal result instead of waiting forever.
   * Rejects an unknown ask id (the one error path); every existing ask yields a
   * report.
   */
  async awaitAsk(id: string): Promise<AskAwaitReport> {
    const ask = await this.getAsk(id);
    if (ask === null) {
      throw new Error(`awaitAsk: unknown ask id '${id}'`);
    }

    const base = {
      ask_id: ask.id,
      state: ask.state,
      mapped_artifact: ask.mapped_artifact,
      to_team: ask.to_team,
    };

    if (ask.state === 'filed') {
      return this.buildAwaitReport(base, 'pending', { artifactStatus: null });
    }
    if (ask.state === 'rejected') {
      return this.buildAwaitReport(base, 'rejected', { reason: ask.rejected_reason });
    }
    if (ask.state === 'countered') {
      return this.buildAwaitReport(base, 'countered', { reason: ask.counter_proposal });
    }

    // state === 'accepted': the phase hinges on the mapped child's status. A
    // missing child (soft-deleted out from under the ask) reads as not-done.
    const child = ask.mapped_artifact !== null ? await this.getTask(ask.mapped_artifact) : null;
    const artifactStatus: TaskStatus | null = child?.status ?? null;
    if (artifactStatus !== 'done') {
      return this.buildAwaitReport(base, 'waiting', { artifactStatus });
    }
    // The child is done — expose the to-team's ACTIVE published outputs.
    return this.buildAwaitReport(base, 'ready', {
      artifactStatus,
      outputs: await this.listTeamExposes(ask.to_team),
    });
  }

  /**
   * Assemble an `AskAwaitReport` from a phase plus the variable parts. Centralizes
   * the `terminal` derivation (a phase in `ASK_AWAIT_TERMINAL_PHASES`) and the
   * defaulting of `artifact_status` / `outputs` / `reason`, so `awaitAsk`'s branch
   * arms stay one line each.
   */
  private buildAwaitReport(
    base: Pick<AskAwaitReport, 'ask_id' | 'state' | 'mapped_artifact' | 'to_team'>,
    phase: AskAwaitPhase,
    parts: {
      artifactStatus?: TaskStatus | null;
      outputs?: TeamExposeRow[];
      reason?: string | null;
    },
  ): AskAwaitReport {
    return {
      ...base,
      phase,
      terminal: ASK_AWAIT_TERMINAL_PHASES.includes(phase),
      artifact_status: parts.artifactStatus ?? null,
      outputs: parts.outputs ?? [],
      reason: parts.reason ?? null,
    };
  }

  // ==========================================================================
  // Manifest — cross-team contracts read surface
  // ==========================================================================

  /**
   * The cross-team Manifest — the single both-teams-visible aggregation of every
   * team's published interface contracts. Walks `listTeams()` (slug order) and,
   * per team, reads its ACTIVE accept/expose interface via `getTeamInterface`,
   * collecting one `ManifestTeamEntry` per team into `teams`. A pure read: no
   * Manifest state is persisted and this method never mutates. Tolerates a
   * registry with zero teams — the `teams` array is then empty.
   *
   * The Manifest is the surface a team reads to learn what every OTHER team
   * accepts (the ask types it handles) and exposes (the outputs it publishes),
   * without each team walking the registry itself.
   */
  async getManifest(): Promise<Manifest> {
    // Sequential, not Promise.all: the prepared-statement cache hands every
    // getTeamInterface call the SAME cached Statement per SQL, and the driver's
    // Statement is stateful across bind/execute — running the per-team reads
    // concurrently would interleave their binds and cross-wire the results.
    const teams: ManifestTeamEntry[] = [];
    for (const team of await this.listTeams()) {
      const iface = await this.getTeamInterface(team.slug);
      teams.push({ slug: iface.slug, accepts: iface.accepts, exposes: iface.exposes });
    }
    // SEAM: incorporate cross-team asks here once an inter-agent ask protocol
    // (a capability that lets one team file a request against another team's
    // accepted ask types) exists to source them. Until then there is no ask
    // source to read, so `asks` is the empty declared placeholder, not a
    // fabricated list — the Manifest reader still sees the full contract shape.
    return { teams, asks: [] };
  }

  // ==========================================================================
  // Team lifecycle — terminate / disband (v18)
  // ==========================================================================

  /**
   * Disband a team — the team-LOCAL terminate, all effects in ONE transaction so
   * a half-disbanded team is never observable. The four team-local effects:
   *
   *   1. Release the team's scope: its read and write globs are cleared, so the
   *      single-writer-per-path claim it held is freed for another team.
   *   2. Supersede every ACTIVE expose with the disband `reason` (and no
   *      replacement — `superseded_by` NULL): the team's published outputs are
   *      retired, but the retired rows stay for audit (append-only with
   *      supersession). ACCEPTS are deliberately left active: superseding the
   *      ask types a team handled is a separate policy decision (whether a
   *      disbanded team's accept history should read as retired or as a frozen
   *      record of what it once handled) and is not part of the team-local
   *      disband — leaving them active preserves the interface history without
   *      asserting a retirement reason the disband does not carry.
   *   3. Vacate the roster: every OPEN (team, role) interval is closed by
   *      stamping its `to_ts` to the disband instant, WITHOUT appending a
   *      successor — the slots are emptied, not handed to a new holder.
   *   4. Flip `status` to `inactive` — the terminal lifecycle state.
   *
   * Idempotent guard: terminating an already-`inactive` team throws rather than
   * re-running the effects, so a double-disband is a caught error, not a silent
   * no-op that re-stamps timestamps. Throws on an unknown slug.
   */
  async teamTerminate(slug: string, reason: string): Promise<TeamTerminateResult> {
    const existing = await this.getTeam(slug);
    if (existing === null) {
      throw new Error(`teamTerminate: unknown team '${slug}'`);
    }
    if (existing.status === 'inactive') {
      throw new Error(`teamTerminate: team '${slug}' is already inactive`);
    }
    const at = isoNow();
    const priorScopes = await this.getTeamScopes(slug);
    const scopesCleared = priorScopes.read.length + priorScopes.write.length;
    const activeExposes = await this.listTeamExposes(slug);

    const disband = async () => {
      // 1. Release scope — the seam setTeamScopes left for the disband path.
      await this.setTeamScopes(slug, { read: [], write: [] });

      // 2. Supersede every active expose with the disband reason, no replacement.
      for (const expose of activeExposes) {
        await this.supersedeTeamExpose(expose.id, reason, null);
      }

      // 3. Vacate every open roster slot — close to_ts without a successor.
      const vacated = await this.run(
        'UPDATE scrum_team_members SET to_ts = ? WHERE team_slug = ? AND to_ts IS NULL',
        at,
        slug,
      );

      // 4. Flip status to the terminal inactive state.
      await this.exec(
        'UPDATE scrum_teams SET status = ? WHERE slug = ?',
        'inactive' satisfies TeamStatus,
        slug,
      );

      // Promote the disbanding team's LIVE Lore into the Codex as gated DRAFTS —
      // a disbanding team's durable, generally-applicable learnings are lifted
      // into shared long-term memory before the team goes inactive. Each
      // promotion is a PROPOSAL (a draft awaiting a separate approve gate), never
      // an auto-acceptance. Superseded entries are skipped: their substance
      // already lives in the consolidation or decision that replaced them, so
      // re-promoting a retired source would only mint duplicates of memory the
      // store already keeps. `promoteLoreToCodex` uses a deterministic decision
      // id per Lore, so a re-promotion upserts rather than duplicates — but the
      // disband itself never re-runs (an already-inactive team throws above), so
      // double-promotion cannot happen on this path. The promotion's inner
      // transaction nests as a SAVEPOINT inside this disband transaction.
      for (const lore of await this.listLiveLores(slug)) {
        await this.promoteLoreToCodex({ loreId: lore.id });
      }

      // SEAM: cascade-cancel this team's in-flight epics once a task<->team
      // ownership link exists. A disband should terminate the team's still-open
      // work, but tasks carry no team-ownership column, so there is no edge to
      // follow from a team to the epics it owns; this cascade is intentionally
      // omitted until that link is added.

      return Number(vacated.changes);
    };
    const rosterVacated = await withTx(this.store, disband);

    return {
      slug,
      exposesRetired: activeExposes.length,
      rosterVacated,
      scopesCleared,
    };
  }

  /**
   * Disband every `active` team whose `terminates_on_milestone` names
   * `milestoneId`. The milestone-close trigger: a closing milestone drives the
   * termination of the enabling/terminating-lifetime teams pinned to it. Runs
   * `teamTerminate` per matching team (each its own transaction) and returns the
   * per-team results, ordered by slug. A team already `inactive` is skipped (it
   * was disbanded by an earlier path), so re-closing a milestone is safe.
   */
  async terminateTeamsForMilestone(
    milestoneId: string,
    reason: string,
  ): Promise<TeamTerminateResult[]> {
    const matches = (await this.listTeams()).filter(
      (team) => team.status === 'active' && team.terminates_on_milestone === milestoneId,
    );
    // Sequential, not Promise.all: teamTerminate issues a transaction and the
    // cached prepared statements are stateful, so concurrent runs would
    // interleave. Terminations are few, so the serial cost is negligible.
    const results: TeamTerminateResult[] = [];
    for (const team of matches) {
      results.push(await this.teamTerminate(team.slug, reason));
    }
    return results;
  }

  // ==========================================================================
  // Team Lore — append-only team-scoped wisdom, tech_lead-authored (v19)
  // ==========================================================================

  /**
   * Record one Lore entry for a team — the append-only memory layer carrying a
   * team's accumulated conventions and wisdom. Readable by all; written ONLY by
   * the team's current `tech_lead`. The team must exist (the FK target) — an
   * unknown slug throws (the boundary guard, matching `setTeamScopes`).
   *
   * Authorship guard, read from the team's open `tech_lead` roster slot:
   *   - SEATED tech_lead: `authorContributorId` MUST equal that holder's
   *     `contributor_id`. A mismatch throws WITHOUT writing — the error names the
   *     expected tech_lead so the caller knows who may author.
   *   - NO tech_lead (the slot has never been filled or is currently vacant):
   *     the write is ALLOWED and a `warning` is returned (never a rejection) —
   *     the team-of-one / bootstrapping tolerance, mirroring how a vacant slot is
   *     a warn-not-reject case elsewhere.
   *
   * Append-only: an entry is never updated or deleted — a correction is a fresh
   * `recordLore`, not an edit, so the full history survives.
   */
  async recordLore(input: RecordLoreInput): Promise<RecordLoreResult> {
    if ((await this.getTeam(input.teamSlug)) === null) {
      throw new Error(`recordLore: unknown team '${input.teamSlug}'`);
    }

    // The current tech_lead is the latest-open holder of that role slot (the
    // max-fold over open intervals, via getTeamRoster) — null when the slot has
    // never been filled or has been vacated.
    const techLead = (await this.getTeamRoster(input.teamSlug)).current.tech_lead;
    let warning: string | null = null;
    if (techLead === null) {
      warning = `team '${input.teamSlug}' has no current tech_lead; recording Lore by ${input.authorContributorId} without an authorship check`;
    } else if (techLead.contributor_id !== input.authorContributorId) {
      throw new Error(
        `recordLore: '${input.authorContributorId}' is not the current tech_lead of team '${input.teamSlug}'; only ${techLead.contributor_id} may author Lore`,
      );
    }

    const id = ulid();
    await this.exec(
      'INSERT INTO scrum_lores (id, team_slug, body, author_contributor_id, created_at) VALUES (?, ?, ?, ?, ?)',
      id,
      input.teamSlug,
      input.body,
      input.authorContributorId,
      input.createdAt ?? isoNow(),
    );
    const row = (await this.one(
      `SELECT ${LORE_COLUMNS} FROM scrum_lores WHERE id = ?`,
      id,
    )) as LoreRow;
    return { row, warning };
  }

  /**
   * A team's Lore entries, oldest-first (the order they were recorded). The
   * read surface promotion and milestone-close compaction consume to lift a
   * team's wisdom into shared long-term memory. Tolerates an unknown slug:
   * returns an empty array (the absence reads as "no Lore" rather than an error,
   * matching `getTeamScopes`).
   */
  async listLores(teamSlug: string): Promise<LoreRow[]> {
    return (await this.many(
      `SELECT ${LORE_COLUMNS} FROM scrum_lores WHERE team_slug = ? ORDER BY id ASC`,
      teamSlug,
    )) as LoreRow[];
  }

  /** Fetch a single Lore entry by id, or null when no such entry exists. */
  async getLore(id: string): Promise<LoreRow | null> {
    const row = (await this.one(
      `SELECT ${LORE_COLUMNS} FROM scrum_lores WHERE id = ?`,
      id,
    )) as LoreRow | null;
    return row ?? null;
  }

  /**
   * A team's LIVE Lore entries — the rows no supersession has retired
   * (`superseded_by IS NULL`), oldest-first. The read surface that carries a
   * team's CURRENT wisdom: the team artifact's recent window and the disband
   * Lore→Codex sweep read this, while `listLores` keeps serving the full
   * append-only history (superseded rows included) for audit and provenance.
   */
  async listLiveLores(teamSlug: string): Promise<LoreRow[]> {
    return (await this.many(
      `SELECT ${LORE_COLUMNS} FROM scrum_lores WHERE team_slug = ? AND superseded_by IS NULL ORDER BY id ASC`,
      teamSlug,
    )) as LoreRow[];
  }

  /**
   * Retire one LIVE Lore entry by pointing it at its replacement — the
   * compaction write (v28). Append-only-with-supersession: the row's `body`,
   * author, and timestamp stay immutable; only the `superseded_by` pointer and
   * `reason` land, so the full history survives while the entry leaves every
   * live read surface (`listLiveLores`, the team artifact's recent window).
   *
   * Exactly ONE replacement form must be given:
   *   - `byLoreId` (consolidation) — must name an EXISTING, LIVE Lore entry of
   *     the SAME team, and not the entry itself. Pointing at another team's
   *     entry, a retired entry, or itself throws WITHOUT writing.
   *   - `byDecisionId` (promotion / codex-duplicate retire) — must name an
   *     EXISTING decision whose `status` is `accepted`; a draft could still be
   *     rejected, which would leave a dangling retire, so only an accepted
   *     decision may replace Lore. The pointer is stored in the typed soft-ref
   *     form `lore:<id>` / `decision:<id>`.
   *
   * A supersession is resolved ONCE: an already-superseded entry throws
   * (mirroring the decision write-gate's one-shot rule) — chains grow by
   * superseding the LIVE head, never by re-pointing history. `reason` is
   * required. Authorship follows the Lore layer's rule exactly as `recordLore`:
   * a SEATED tech_lead must author the write (mismatch throws), a vacant seat
   * warns and allows (the bootstrapping tolerance).
   */
  async supersedeLore(input: SupersedeLoreInput): Promise<SupersedeLoreResult> {
    const lore = await this.getLore(input.loreId);
    if (lore === null) {
      throw new Error(`supersedeLore: unknown lore id '${input.loreId}'`);
    }
    if (lore.superseded_by !== null) {
      throw new Error(
        `supersedeLore: lore ${lore.id} is already superseded by '${lore.superseded_by}'; a supersession is resolved once`,
      );
    }
    if (input.reason.trim().length === 0) {
      throw new Error('supersedeLore: a non-empty reason is required');
    }

    const hasLore = input.byLoreId !== undefined;
    const hasDecision = input.byDecisionId !== undefined;
    if (hasLore === hasDecision) {
      throw new Error(
        'supersedeLore: exactly one of byLoreId (consolidation) or byDecisionId (promotion) is required',
      );
    }

    let pointer: string;
    if (input.byLoreId !== undefined) {
      if (input.byLoreId === input.loreId) {
        throw new Error(`supersedeLore: lore ${input.loreId} cannot supersede itself`);
      }
      const replacement = await this.getLore(input.byLoreId);
      if (replacement === null) {
        throw new Error(`supersedeLore: unknown replacement lore id '${input.byLoreId}'`);
      }
      if (replacement.team_slug !== lore.team_slug) {
        throw new Error(
          `supersedeLore: replacement lore ${replacement.id} belongs to team '${replacement.team_slug}', not '${lore.team_slug}'; a consolidation stays within its team`,
        );
      }
      if (replacement.superseded_by !== null) {
        throw new Error(
          `supersedeLore: replacement lore ${replacement.id} is itself superseded; supersede by the live head instead`,
        );
      }
      pointer = `lore:${replacement.id}`;
    } else {
      const decision = await this.getDecision(input.byDecisionId as string);
      if (decision === null) {
        throw new Error(`supersedeLore: unknown replacement decision '${input.byDecisionId}'`);
      }
      if (decision.status !== 'accepted') {
        throw new Error(
          `supersedeLore: replacement decision '${decision.id}' is '${decision.status}', not accepted; only an accepted decision may replace Lore`,
        );
      }
      pointer = `decision:${decision.id}`;
    }

    // Same authorship rule as recordLore: the Lore layer is tech_lead-owned,
    // and retiring an entry changes what every reader sees just as writing one
    // does — so the same seated-tech_lead gate (with the same vacant-seat
    // warn-and-allow tolerance) guards both writes.
    const techLead = (await this.getTeamRoster(lore.team_slug)).current.tech_lead;
    let warning: string | null = null;
    if (techLead === null) {
      warning = `team '${lore.team_slug}' has no current tech_lead; superseding Lore by ${input.authorContributorId} without an authorship check`;
    } else if (techLead.contributor_id !== input.authorContributorId) {
      throw new Error(
        `supersedeLore: '${input.authorContributorId}' is not the current tech_lead of team '${lore.team_slug}'; only ${techLead.contributor_id} may retire Lore`,
      );
    }

    await this.exec(
      'UPDATE scrum_lores SET superseded_by = ?, reason = ? WHERE id = ?',
      pointer,
      input.reason,
      lore.id,
    );
    const row = (await this.one(
      `SELECT ${LORE_COLUMNS} FROM scrum_lores WHERE id = ?`,
      lore.id,
    )) as LoreRow;
    return { row, warning };
  }

  /**
   * Promote one generally-applicable team Lore entry into the Codex
   * (`scrum_decisions`) THROUGH the gated write protocol — the Lore→Codex lift.
   * The promotion PROPOSES: it records a Codex DRAFT (`write_status = 'draft'`,
   * `status = 'draft'`) under a gated `kind` and stamps `source_lore_id` back at
   * the origin Lore. It NEVER auto-approves — accepting the draft is a separate
   * `approveDecision` gate (a human / tech_lead step), so the engine proposes and
   * the model/operator decides. The source Lore is untouched (append-only).
   *
   * `kind` defaults to `pattern` (a gated kind — a generalized team convention);
   * any gated kind keeps the draft. `decisionId` is deterministic
   * (`lore-promotion-<team>-<loreId>` by default) so a re-promotion upserts the
   * same row rather than duplicating. Throws on an unknown `loreId`.
   *
   * Runs in ONE transaction: the `recordDecision` (a single upsert) and the
   * `source_lore_id` stamp are atomic, so a decision is never observed without
   * its provenance. The whole method nests cleanly inside an outer transaction
   * (e.g. the disband path inside `teamTerminate`) — `recordDecision` itself
   * opens no transaction, and this wrapper's transaction becomes a SAVEPOINT.
   */
  async promoteLoreToCodex(input: PromoteLoreToCodexInput): Promise<DecisionRow> {
    const lore = await this.getLore(input.loreId);
    if (lore === null) {
      throw new Error(`promoteLoreToCodex: unknown lore id '${input.loreId}'`);
    }
    const decisionId = input.decisionId ?? `lore-promotion-${lore.team_slug}-${lore.id}`;
    const kind = input.kind ?? PROMOTION_DEFAULT_KIND;
    const title = input.title ?? `Promoted Lore from team ${lore.team_slug}`;
    // The provenance line keeps the origin readable in the decision body itself,
    // in addition to the structured `source_lore_id` column — the model refines
    // the body later; the engine just surfaces a faithful starting point.
    const content = `Promoted from team '${lore.team_slug}' Lore entry ${lore.id} (authored by ${lore.author_contributor_id}).\n\n${lore.body}`;

    const promote = async () => {
      // Record THROUGH the gate: a gated kind lands as a DRAFT, not accepted.
      await this.recordDecision({
        id: decisionId,
        title,
        content,
        kind,
        recordedByAgent: input.recordedByAgent ?? null,
      });
      // Stamp provenance back at the source Lore. A separate UPDATE (rather than
      // a recordDecision arg) keeps the draft/gate semantics of recordDecision
      // untouched — provenance is orthogonal to the write-gate state.
      await this.exec(
        'UPDATE scrum_decisions SET source_lore_id = ? WHERE id = ?',
        lore.id,
        decisionId,
      );
      return await this.requireDecision(decisionId, 'promoteLoreToCodex');
    };
    return await withTx(this.store, promote);
  }

  // ==========================================================================
  // Annotation layer (v20) — per-artifact notes, append-only
  // ==========================================================================

  /**
   * Append one Annotation — a per-artifact note, visible to anyone reading the
   * target. The lightest memory layer: there is no authorship gate (any author
   * may annotate any target) — `author` is recorded, not enforced.
   *
   * `targetKind` MUST be a member of the closed `AnnotationTargetKind` set
   * (`task` | `team` | `decision`) — an unknown kind throws WITHOUT writing,
   * the boundary guard matching `createTeam`'s team_type check. `targetRef` is a
   * SOFT reference: the store does NOT verify the named task / team / decision
   * exists (the ref spans multiple tables by kind, so it carries no FK), exactly
   * as the roster and operator history hold their referents without one.
   *
   * Append-only: an entry is never updated or deleted — a correction is a fresh
   * `addAnnotation`, not an edit, so the full history survives.
   */
  async addAnnotation(input: AddAnnotationInput): Promise<AnnotationRow> {
    if (!(ANNOTATION_TARGET_KINDS as string[]).includes(input.targetKind)) {
      throw new Error(
        `addAnnotation: invalid target_kind '${input.targetKind}'; expected one of: ${ANNOTATION_TARGET_KINDS.join(', ')}`,
      );
    }
    const id = ulid();
    await this.exec(
      'INSERT INTO scrum_annotations (id, target_kind, target_ref, body, author, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      id,
      input.targetKind,
      input.targetRef,
      input.body,
      input.author,
      input.createdAt ?? isoNow(),
    );
    return (await this.one(
      `SELECT ${ANNOTATION_COLUMNS} FROM scrum_annotations WHERE id = ?`,
      id,
    )) as AnnotationRow;
  }

  /**
   * A target's Annotations, oldest-first (the order they were recorded). The
   * read surface anyone consults to see the notes attached to a task, team, or
   * decision. Tolerates a target with no notes: returns an empty array (the
   * absence reads as "no annotations" rather than an error, matching
   * `listLores`).
   */
  async listAnnotations(
    targetKind: AnnotationTargetKind,
    targetRef: string,
  ): Promise<AnnotationRow[]> {
    return (await this.many(
      `SELECT ${ANNOTATION_COLUMNS} FROM scrum_annotations WHERE target_kind = ? AND target_ref = ? ORDER BY id ASC`,
      targetKind,
      targetRef,
    )) as AnnotationRow[];
  }

  // ==========================================================================
  // Escalation protocol (v23) — typed walk-up chain + resolution modes
  // ==========================================================================

  /**
   * Raise one typed escalation at a rung of the walk-up chain. The bottom-rung
   * entry point: a worker raises a `blocked` / `ambiguous` / `conflict` /
   * `missing_context` escalation, which lands `open` at `layer` (default
   * `implementer`) awaiting that layer's receiver.
   *
   * `escalationType` MUST be a member of the closed `EscalationType` set and
   * `layer` a member of the closed `EscalationChain` — both throw WITHOUT
   * writing on an off-vocabulary value (the boundary guard matching
   * `addAnnotation`/`createTeam`). `taskId` is a SOFT reference: the store does
   * NOT verify the task exists (it carries no FK, matching the annotation's
   * `target_ref`). A root escalation carries `walked_up_from = NULL`; the
   * append-on-walk-up path (`resolveEscalation` / `autoBubbleEscalation`) is the
   * only writer that sets it.
   */
  async raiseEscalation(input: RaiseEscalationInput): Promise<EscalationRow> {
    if (!(ESCALATION_TYPES as string[]).includes(input.escalationType)) {
      throw new Error(
        `raiseEscalation: invalid escalation_type '${input.escalationType}'; expected one of: ${ESCALATION_TYPES.join(', ')}`,
      );
    }
    const layer = input.layer ?? 'implementer';
    if (!(ESCALATION_CHAIN as string[]).includes(layer)) {
      throw new Error(
        `raiseEscalation: invalid layer '${layer}'; expected one of: ${ESCALATION_CHAIN.join(', ')}`,
      );
    }
    return await this.insertEscalation({
      taskId: input.taskId,
      escalationType: input.escalationType,
      layer,
      summary: input.summary,
      raisedBy: input.raisedBy ?? null,
      walkedUpFrom: null,
      createdAt: input.createdAt ?? isoNow(),
    });
  }

  /** Fetch one escalation by id, or null when no such row exists. */
  async getEscalation(id: string): Promise<EscalationRow | null> {
    const row = (await this.one(
      `SELECT ${ESCALATION_COLUMNS} FROM scrum_escalations WHERE id = ?`,
      id,
    )) as EscalationRowRaw | null;
    return row ? decodeEscalation(row) : null;
  }

  /**
   * A task's escalations, oldest-first (raise order). The read surface a driver
   * consults to see the full escalation history — every rung, open and closed —
   * for a task. Tolerates a task with no escalations: returns an empty array.
   */
  async listEscalationsForTask(taskId: string): Promise<EscalationRow[]> {
    return (
      (await this.many(
        `SELECT ${ESCALATION_COLUMNS} FROM scrum_escalations WHERE task_id = ? ORDER BY id ASC`,
        taskId,
      )) as EscalationRowRaw[]
    ).map(decodeEscalation);
  }

  /**
   * Every currently-`open` escalation across all tasks, oldest-first — the
   * driver's worklist of escalations awaiting a receiver's resolution.
   */
  async listOpenEscalationRows(): Promise<EscalationRow[]> {
    return (
      (await this.many(
        `SELECT ${ESCALATION_COLUMNS} FROM scrum_escalations WHERE state = 'open' ORDER BY id ASC`,
      )) as EscalationRowRaw[]
    ).map(decodeEscalation);
  }

  /**
   * Reconstruct the full walk-up chain a single escalation climbed, bottom rung
   * first. Follows `walked_up_from` from any row in the chain back to the root
   * (`null`), then returns the rows root-first. The list reads as the escalation's
   * journey up the ladder: each entry is one rung, with its closing state and
   * resolution. A visited-set guards against an accidental self-link cycle.
   */
  async getEscalationChain(id: string): Promise<EscalationRow[]> {
    // Walk DOWN to the root via walked_up_from, collecting the rung at each hop.
    const chainDown: EscalationRow[] = [];
    const visited = new Set<string>();
    let cursor: string | null = id;
    while (cursor !== null && !visited.has(cursor)) {
      visited.add(cursor);
      const row = await this.getEscalation(cursor);
      if (row === null) break;
      chainDown.push(row);
      cursor = row.walked_up_from;
    }
    // chainDown is top-rung-first (we started at `id` and walked toward the root);
    // reverse so the caller reads it root-first (bottom rung → top).
    return chainDown.reverse();
  }

  /**
   * Apply a receiver's resolution to an `open` escalation. The receiver at the
   * escalation's current layer chooses exactly one `EscalationResolutionMode`,
   * and this method transitions the row accordingly — the per-receiver half of
   * the protocol. Runs in ONE transaction so a `re_escalate` never leaves the
   * closed row without its walked-up successor (or vice versa).
   *
   *   resolve      — the receiver answered it. The row → `resolved`. No walk-up.
   *   re_decompose — the escalation needs the work re-decomposed. The row →
   *                  `resolved` (it is discharged at THIS layer) and the result's
   *                  `reDecomposeTriggered` is set — the signal the driver reads
   *                  to force re-decomposition. No walk-up.
   *   re_escalate  — the receiver cannot resolve at this layer. The row →
   *                  `re_escalated` AND a fresh `open` row is appended at the next
   *                  rung (`nextEscalationLayer`) carrying `walked_up_from = <this
   *                  row id>`. Advances EXACTLY one rung. REJECTED when the current
   *                  layer is already `human` (the top — nowhere higher to walk).
   *
   * Throws WITHOUT writing on: an unknown id, a row that is not `open` (already
   * terminal — every transition is one-shot), an off-vocabulary `mode`, or a
   * `re_escalate` at the top of the chain.
   */
  async resolveEscalation(input: ResolveEscalationInput): Promise<ResolveEscalationResult> {
    if (!(ESCALATION_RESOLUTION_MODES as string[]).includes(input.mode)) {
      throw new Error(
        `resolveEscalation: invalid mode '${input.mode}'; expected one of: ${ESCALATION_RESOLUTION_MODES.join(', ')}`,
      );
    }
    const existing = await this.getEscalation(input.id);
    if (existing === null) {
      throw new Error(`resolveEscalation: unknown escalation id '${input.id}'`);
    }
    if (existing.state !== 'open') {
      throw new Error(
        `resolveEscalation: escalation ${input.id} is '${existing.state}', not 'open'; only an open escalation can be resolved`,
      );
    }

    const mode = input.mode as EscalationResolutionMode;
    const resolvedAt = input.resolvedAt ?? isoNow();
    const resolvedBy = input.resolvedBy ?? null;
    const note = input.note ?? null;

    // A re_escalate at the top rung has nowhere higher to walk — reject BEFORE
    // mutating, so the row stays open.
    const nextLayer = nextEscalationLayer(existing.layer);
    if (mode === 're_escalate' && nextLayer === null) {
      throw new Error(
        `resolveEscalation: escalation ${input.id} is already at the top of the chain ('${existing.layer}'); cannot re_escalate past 'human'`,
      );
    }

    const apply = async (): Promise<ResolveEscalationResult> => {
      // `resolve` and `re_decompose` both DISCHARGE the row → `resolved`; only the
      // result flag differs. `re_escalate` closes it → `re_escalated`.
      const closedState: EscalationState = mode === 're_escalate' ? 're_escalated' : 'resolved';
      await this.closeEscalationRow(existing.id, closedState, mode, note, resolvedBy, resolvedAt);

      let walkedUpTo: EscalationRow | null = null;
      if (mode === 're_escalate' && nextLayer !== null) {
        walkedUpTo = await this.insertEscalation({
          taskId: existing.task_id,
          escalationType: existing.escalation_type,
          layer: nextLayer,
          summary: existing.summary,
          raisedBy: resolvedBy,
          walkedUpFrom: existing.id,
          createdAt: resolvedAt,
        });
      }

      const row = await this.requireEscalation(existing.id, 'resolveEscalation');
      return { row, walkedUpTo, reDecomposeTriggered: mode === 're_decompose' };
    };
    return await withTx(this.store, apply);
  }

  /**
   * Bubble an aged `open` escalation one rung up by the staleness floor — the
   * engine's escalation-of-last-resort when no receiver acted. Identical
   * append-on-walk-up mechanics to a `re_escalate`, but the closing state is
   * `auto_bubbled` (the row was advanced by the clock, not by a receiver) and no
   * `resolution_mode` is recorded. The closed row is stamped with
   * `attributes = { auto_bubbled: true, linked_escalation: <new id> }` — the
   * marker plus a forward pointer to the fresh row, the inverse of that row's
   * `walked_up_from` back-pointer. REJECTED at the top of the chain (nowhere
   * higher) and on a non-`open` row. Returns the freshly-appended `open` row at
   * the next rung.
   *
   * The new row is also surfaced to the `alerts` / `nextReady` ranking via a
   * `blocker_raised` event on the owning task — the SAME signal a hand-raised
   * escalation emits — so a clock-driven bubble shows up everywhere a manual
   * escalation would. The event is appended ONLY when the owning task exists in
   * the store, preserving the escalation's soft-reference semantics (an
   * escalation may name a task the store does not track).
   */
  async autoBubbleEscalation(id: string, bubbledAt?: string): Promise<EscalationRow> {
    const existing = await this.getEscalation(id);
    if (existing === null) {
      throw new Error(`autoBubbleEscalation: unknown escalation id '${id}'`);
    }
    if (existing.state !== 'open') {
      throw new Error(
        `autoBubbleEscalation: escalation ${id} is '${existing.state}', not 'open'; only an open escalation can be auto-bubbled`,
      );
    }
    const nextLayer = nextEscalationLayer(existing.layer);
    if (nextLayer === null) {
      throw new Error(
        `autoBubbleEscalation: escalation ${id} is already at the top of the chain ('${existing.layer}'); cannot bubble past 'human'`,
      );
    }
    const ts = bubbledAt ?? isoNow();
    const bubble = async (): Promise<EscalationRow> => {
      await this.closeEscalationRow(existing.id, 'auto_bubbled', null, null, null, ts);
      const bubbled = await this.insertEscalation({
        taskId: existing.task_id,
        escalationType: existing.escalation_type,
        layer: nextLayer,
        summary: existing.summary,
        raisedBy: null,
        walkedUpFrom: existing.id,
        createdAt: ts,
      });
      // Stamp the closed row with the marker + forward pointer to the new rung.
      await this.setEscalationAttributes(existing.id, {
        auto_bubbled: true,
        linked_escalation: bubbled.id,
      });
      await this.surfaceEscalationEvent(bubbled, ts);
      return bubbled;
    };
    return await withTx(this.store, bubble);
  }

  /**
   * Write the JSON `attributes` marker onto one escalation row. NULL clears it.
   * The single low-level attributes writer — used by the staleness auto-bubble
   * to stamp `{ auto_bubbled, linked_escalation }` on the closed row.
   */
  private async setEscalationAttributes(
    id: string,
    attributes: EscalationAttributes | null,
  ): Promise<void> {
    await this.exec(
      'UPDATE scrum_escalations SET attributes = ? WHERE id = ?',
      attributes === null ? null : JSON.stringify(attributes),
      id,
    );
  }

  /**
   * Surface an auto-bubbled escalation into the `alerts` / `nextReady` ranking by
   * appending a `blocker_raised` event on the owning task — the same event the
   * hand-raise path emits, so a clock-driven bubble ranks identically. Appended
   * ONLY when the task exists (escalation `task_id` is a soft reference); a
   * bubble naming an untracked task still advances the chain, it just carries no
   * event surface.
   */
  private async surfaceEscalationEvent(row: EscalationRow, ts: string): Promise<void> {
    if (!(await this.getTask(row.task_id))) return;
    const payload: EscalationPayload = {
      escalation_type: row.escalation_type,
      summary: row.summary,
    };
    await this.appendEvent({ taskId: row.task_id, kind: 'blocker_raised', payload, ts });
  }

  /**
   * Insert one `open` escalation row and return it. The single low-level writer
   * shared by `raiseEscalation` (root row) and the walk-up paths
   * (`resolveEscalation` / `autoBubbleEscalation`, which pass `walkedUpFrom`).
   * Closed-enum guarding is the caller's job — this writes what it is given.
   */
  private async insertEscalation(args: {
    taskId: string;
    escalationType: EscalationType;
    layer: EscalationLayer;
    summary: string;
    raisedBy: string | null;
    walkedUpFrom: string | null;
    createdAt: string;
  }): Promise<EscalationRow> {
    const id = ulid();
    await this.exec(
      `INSERT INTO scrum_escalations
         (id, task_id, escalation_type, layer, state, summary, raised_by, walked_up_from, created_at)
       VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
      id,
      args.taskId,
      args.escalationType,
      args.layer,
      args.summary,
      args.raisedBy,
      args.walkedUpFrom,
      args.createdAt,
    );
    return await this.requireEscalation(id, 'insertEscalation');
  }

  /**
   * Flip an escalation row out of `open` into a terminal state, stamping the
   * resolution provenance. The single low-level closer shared by every walk-up
   * and resolution path.
   */
  private async closeEscalationRow(
    id: string,
    state: EscalationState,
    mode: EscalationResolutionMode | null,
    note: string | null,
    resolvedBy: string | null,
    resolvedAt: string,
  ): Promise<void> {
    await this.exec(
      `UPDATE scrum_escalations
         SET state = ?, resolution_mode = ?, resolution_note = ?, resolved_by = ?, resolved_at = ?
       WHERE id = ?`,
      state,
      mode,
      note,
      resolvedBy,
      resolvedAt,
      id,
    );
  }

  /** Fetch an escalation by id or throw — the post-write read-back guard. */
  private async requireEscalation(id: string, ctx: string): Promise<EscalationRow> {
    const row = await this.getEscalation(id);
    if (row === null) {
      throw new Error(`${ctx}: escalation ${id} vanished after write`);
    }
    return row;
  }

  // ==========================================================================
  // Internals
  // ==========================================================================

  /**
   * Transitive closure of `blocks` edges starting at `taskId`. Depth-first
   * with a visited set to handle accidental cycles safely. Returns the
   * count of *distinct* descendants (excludes the root).
   *
   * When `cache` is supplied, results are memoized by root. The cache is
   * expected to be invocation-scoped (see `nextReady`) — dependency edges
   * can change between calls, so we never cache across invocations.
   */
  private async computeUnblockDepth(taskId: string, cache?: Map<string, number>): Promise<number> {
    const cached = cache?.get(taskId);
    if (cached !== undefined) return cached;

    const visited = new Set<string>([taskId]);
    const stack = [taskId];
    let count = 0;
    const stmt = await this.prep(
      "SELECT to_task_id FROM scrum_deps WHERE from_task_id = ? AND kind = 'blocks'",
    );
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined) break;
      const children = (await stmt.all(current)) as Array<{ to_task_id: string }>;
      for (const child of children) {
        if (!visited.has(child.to_task_id)) {
          visited.add(child.to_task_id);
          stack.push(child.to_task_id);
          count++;
        }
      }
    }

    cache?.set(taskId, count);
    return count;
  }

  /**
   * Batch-load net tag scores for a set of task ids in a single grouped
   * query. Each priority tag contributes +1, each defer tag contributes -1;
   * neutral tags contribute 0. Net scores can be negative — tasks with only
   * defer tags must still appear in the returned map so callers see the
   * suppression instead of treating them as neutral. Tasks with no scored
   * tags at all are absent (callers treat missing as 0).
   */
  private async fetchTagBoosts(taskIds: string[]): Promise<Map<string, number>> {
    const boosts = new Map<string, number>();
    if (taskIds.length === 0) return boosts;

    // SQL-side scoring keeps the boost calculation in one round-trip per
    // candidate set instead of streaming every (task_id, tag) row back to
    // JS. One prepared statement per distinct candidate-count — Bun's
    // sqlite requires a fixed placeholder count per statement. In practice
    // `nextReady` caps the candidate set at the `ready`/`backlog` row
    // count, so the number of cached shapes stays bounded.
    const placeholders = taskIds.map(() => '?').join(', ');
    const priorityList = [...PRIORITY_TAGS].map((t) => `'${t}'`).join(', ');
    const deferList = [...DEFER_TAGS].map((t) => `'${t}'`).join(', ');
    const sql = `
      SELECT task_id,
             SUM(CASE WHEN tag IN (${priorityList}) THEN 1
                      WHEN tag IN (${deferList}) THEN -1
                      ELSE 0 END) AS boost
      FROM scrum_tags
      WHERE task_id IN (${placeholders})
      GROUP BY task_id
      HAVING boost <> 0
    `;
    const rows = (await this.many(sql, ...taskIds)) as Array<{ task_id: string; boost: number }>;

    for (const { task_id, boost } of rows) {
      boosts.set(task_id, boost);
    }
    return boosts;
  }

  /**
   * Latest `blocker_raised` escalation per task in `taskIds`, as a
   * `taskId -> { type, ts }` map. Tasks with no escalation (or an untyped
   * payload) are absent. One IN-query per distinct candidate count, reduced in
   * JS by overwriting earlier rows with later ones (rows arrive `ts`-ascending,
   * so the last write per task wins). Per-invocation only — escalations mutate
   * between calls (mirrors `fetchTagBoosts`).
   */
  private async fetchLatestEscalations(
    taskIds: string[],
  ): Promise<Map<string, { type: EscalationType; ts: string }>> {
    const out = new Map<string, { type: EscalationType; ts: string }>();
    if (taskIds.length === 0) return out;
    const placeholders = taskIds.map(() => '?').join(', ');
    const rows = (await this.many(
      `SELECT task_id, ts, payload_json FROM scrum_events WHERE kind = 'blocker_raised' AND task_id IN (${placeholders}) ORDER BY ts ASC, id ASC`,
      ...taskIds,
    )) as Array<{ task_id: string; ts: string; payload_json: string }>;
    for (const row of rows) {
      const type = parseEscalationType(row.payload_json);
      if (type !== null) out.set(row.task_id, { type, ts: row.ts });
    }
    return out;
  }

  /**
   * Open escalations across all non-terminal, non-deleted tasks — the latest
   * `blocker_raised` per task, newest-first. Backs the `alerts` stale-escalation
   * surface: a `done`/`cancelled` task's escalation is resolved and
   * excluded. `age_days` is computed by the caller against its clock.
   */
  async listOpenEscalations(): Promise<
    Array<{
      task_id: string;
      title: string;
      escalation_type: EscalationType;
      ts: string;
    }>
  > {
    const rows =
      (await this.many(`SELECT e.task_id AS task_id, e.ts AS ts, e.payload_json AS payload_json, t.title AS title
       FROM scrum_events e
       INNER JOIN scrum_tasks t ON t.id = e.task_id
       WHERE e.kind = 'blocker_raised' AND t.deleted_at IS NULL
         AND t.status NOT IN ('done', 'cancelled')
       ORDER BY e.ts ASC, e.id ASC`)) as Array<{
        task_id: string;
        ts: string;
        payload_json: string;
        title: string;
      }>;
    // Reduce to the latest escalation per task (later rows overwrite earlier).
    const latest = new Map<
      string,
      { task_id: string; title: string; type: EscalationType; ts: string }
    >();
    for (const row of rows) {
      const type = parseEscalationType(row.payload_json);
      if (type !== null) {
        latest.set(row.task_id, { task_id: row.task_id, title: row.title, type, ts: row.ts });
      }
    }
    return [...latest.values()]
      .sort((a, b) => b.ts.localeCompare(a.ts))
      .map((e) => ({ task_id: e.task_id, title: e.title, escalation_type: e.type, ts: e.ts }));
  }

  /**
   * Open gate-kind acceptance criteria awaiting a human verdict, across all
   * non-terminal, non-deleted tasks. A pending gate is an `active`,
   * `verifies_by: 'gate'` criterion whose persisted verdict is `gate_pending`
   * (the seed state; `approved`/`rejected` are resolved and excluded). Backs
   * the `alerts` pending-gate surface so an out-of-turn driver sees gates the
   * in-turn `AskUserQuestion` path and the `scrum gate respond` CLI would
   * otherwise be the only way to discover. A `done`/`cancelled` task's gates
   * are no longer actionable and are excluded — same terminal-status filter as
   * `listOpenEscalations`. Ordered by task id then criterion id for a stable
   * report.
   */
  async listPendingGates(): Promise<
    Array<{
      task_id: string;
      title: string;
      criterion_id: string;
      criterion_text: string;
    }>
  > {
    const tasks = (await this.listTasks()).filter(
      (t) => t.status !== 'done' && t.status !== 'cancelled',
    );
    const pending: Array<{
      task_id: string;
      title: string;
      criterion_id: string;
      criterion_text: string;
    }> = [];
    for (const task of tasks) {
      for (const criterion of task.acceptance?.criteria ?? []) {
        if (criterion.verifies_by !== 'gate') continue;
        if (criterion.status !== 'active') continue;
        const verdict = criterion.gate?.verdict ?? 'gate_pending';
        if (verdict !== 'gate_pending') continue;
        pending.push({
          task_id: task.id,
          title: task.title,
          criterion_id: criterion.id,
          criterion_text: criterion.text,
        });
      }
    }
    pending.sort(
      (a, b) => a.task_id.localeCompare(b.task_id) || a.criterion_id.localeCompare(b.criterion_id),
    );
    return pending;
  }

  /**
   * Resolve a lazily-cached prepared statement. The cache holds the async
   * `prepare()` promise keyed by SQL text, so a given SQL string is prepared
   * exactly once per process even when hot paths (nextReady walks the graph N
   * times) hit it repeatedly: the first call seeds the promise, later callers
   * await the same one. Always `await` the result before binding/executing —
   * the driver's `prepare()` is async (the await-prepare rule).
   */
  private prep(sql: string): Promise<Statement> {
    const cached = this.statements.get(sql);
    if (cached) return cached;
    const stmt = this.store.getDb().prepare(sql);
    this.statements.set(sql, stmt);
    return stmt;
  }

  /** Prepare (cached) + execute a write. */
  private async exec(sql: string, ...params: SqlParam[]): Promise<void> {
    const stmt = await this.prep(sql);
    await stmt.run(...params);
  }

  /**
   * Prepare (cached) + execute a write bound by NAMED parameters (`$name`).
   * The driver binds a single object argument by key, so a long INSERT whose
   * column list may be reordered stays aligned with its values — no positional
   * `?N` to silently misplace. Distinct from `exec`'s positional rest-args.
   */
  private async execNamed(sql: string, params: Record<string, SqlParam>): Promise<void> {
    const stmt = await this.prep(sql);
    await stmt.run(params);
  }

  /**
   * Prepare (cached) + execute a write, returning the driver run info
   * (`changes`, `lastInsertRowid`) for callers that read the new row id or the
   * affected-row count.
   */
  private async run(
    sql: string,
    ...params: SqlParam[]
  ): Promise<{ changes: number; lastInsertRowid: number }> {
    const stmt = await this.prep(sql);
    return stmt.run(...params);
  }

  /**
   * Prepare (cached) + fetch the first row, or `null` when there is no match.
   * Returns `null` (not `undefined`) so the many `const row = ... as X | null`
   * decode sites and their `row === null` / `!row` guards read coherently — the
   * driver yields `undefined` for an empty result, which would otherwise slip
   * past a strict `=== null` check.
   */
  private async one<T>(sql: string, ...params: SqlParam[]): Promise<T | null> {
    const stmt = await this.prep(sql);
    const row = await stmt.get(...params);
    return (row ?? null) as T | null;
  }

  /** Prepare (cached) + fetch all rows. */
  private async many<T>(sql: string, ...params: SqlParam[]): Promise<T[]> {
    const stmt = await this.prep(sql);
    return (await stmt.all(...params)) as T[];
  }
}

// ---------------------------------------------------------------------------
// Module helpers
// ---------------------------------------------------------------------------

function isoNow(): string {
  return new Date().toISOString();
}

/**
 * Mint a CT-UUID for a contributor — a stable, prefixed id minted once at
 * registration and never changed, so attribution survives a renamed handle or
 * email. The shape is `ct-<slug>-<uuid>`: the `ct-` prefix namespaces it as a
 * contributor id, the slugified handle keeps it human-legible at a glance, and
 * a `crypto.randomUUID()` tail guarantees global uniqueness even across
 * identical slugs. When the slug carries no alphanumerics, the prefix stands in
 * so the id is still well-formed.
 */
function mintContributorId(slug: string): string {
  const normalized = slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
  const uuid = randomUUID();
  return normalized.length > 0 ? `ct-${normalized}-${uuid}` : `ct-${uuid}`;
}

/**
 * The executing-worker/run context for a row write (v11). The orchestrator
 * exports these in the dispatch env so a leaf worker's writes carry attribution
 * without threading the ids through every call site; a bare CLI edit outside a
 * run leaves both NULL. An explicit per-write override (e.g. a test, or a
 * caller that already knows the ids) wins over the env.
 */
function resolveRunContext(override?: {
  workerId?: string | null;
  runId?: string | null;
}): { workerId: string | null; runId: string | null } {
  const workerId =
    override?.workerId !== undefined ? override.workerId : (process.env.PROVE_WORKER_ID ?? null);
  const runId =
    override?.runId !== undefined ? override.runId : (process.env.PROVE_RUN_SLUG ?? null);
  return {
    workerId: workerId && workerId.length > 0 ? workerId : null,
    runId: runId && runId.length > 0 ? runId : null,
  };
}

/**
 * Assemble the reusable per-artifact provenance block from a decoded task's
 * stored columns plus the domain schema version. Single source of the
 * `Provenance` shape so consumers read one view instead of re-collecting the
 * five fields ad hoc.
 */
function taskProvenance(row: ScrumTaskRow): Provenance {
  return {
    created_by: row.created_by_agent,
    created_at: row.created_at,
    last_modified_by: row.last_modified_by,
    last_modified_at: row.last_modified_at,
    worker_id: row.worker_id,
    run_id: row.run_id,
    schema_version: SCRUM_SCHEMA_VERSION,
  };
}

/**
 * Decode a raw `scrum_tasks` SELECT row into the public `ScrumTask`. The
 * `acceptance` object is reconstructed UPSTREAM (in `hydrateRows`, from the
 * normalized criteria + head-verdict tables joined onto the row's
 * `acceptance_policy_json`) and passed in; this function only transforms
 * `bounds_json` (TEXT|NULL) → `bounds` and assembles the provenance block, with
 * every other column passing through unchanged.
 *
 * The `bounds_json` column has no SQL-level guarantee of valid JSON
 * (`validateBounds` only runs on writes through the store API). `decodeTask` is
 * on the hot read path of getTask/listTasks/getChildren/listTasksForTag/
 * nextReady, so a single corrupt row must NOT throw and brick every task read.
 * `safeParseJson` degrades a poisoned column to `null` (with a stderr warning)
 * instead — the task still reads, just without its bounds.
 */
function decodeTask(row: ScrumTaskRow, acceptance: Acceptance | null): ScrumTask {
  const { acceptance_policy_json: _policy, bounds_json, ...rest } = row;
  return {
    ...rest,
    acceptance,
    bounds: safeParseJson<TaskBounds>(bounds_json, row.id, 'bounds_json'),
    provenance: taskProvenance(row),
  };
}

/**
 * Reassemble a task's `Acceptance` object from its normalized parts: the
 * criterion DEFINITION rows (ordered by the minted `ord`), the latest verdict
 * per criterion (the criterion-head view), and the task-level `policy` (the
 * `acceptance_policy_json` column). Returns `null` when the task carries no
 * criteria AND no policy — the "no acceptance" shape every read expects.
 *
 * The head verdict folds back into the in-memory criterion the same way the
 * blob used to carry it: a `gate`-channel head becomes `gate: {verdict,
 * responder, comment, responded_at}`; a `verification`-channel head becomes
 * `verification: {verdict, reason, verified_by, verified_at}`. A gate-kind
 * criterion with no verdict row reads `gate: {verdict: 'gate_pending'}` (a
 * fresh gate always starts pending and resolvable), exactly as
 * `withGateStatesSeeded` seeded the blob.
 */
function reconstructAcceptance(
  criterionRows: AcceptanceCriterionRow[],
  heads: Map<string, CriterionHeadRow>,
  policyJson: string | null,
  taskId: string,
): Acceptance | null {
  const policy = safeParseJson<AcceptancePolicy>(policyJson, taskId, 'acceptance_policy_json');
  if (criterionRows.length === 0) return policy ? { criteria: [], policy } : null;

  const criteria = criterionRows
    .slice()
    .sort((a, b) => a.ord.localeCompare(b.ord))
    .map((row) => decodeCriterion(row, heads.get(row.id)));
  return policy ? { criteria, policy } : { criteria };
}

/**
 * Decode one criterion DEFINITION row plus its head verdict (if any) into the
 * public `AcceptanceCriterion`. Optional fields stay absent (not null/undefined
 * on the shape) so the reconstructed object round-trips byte-for-byte against
 * what the authoring path wrote — `scope`/`timeout` are only set when present.
 */
function decodeCriterion(
  row: AcceptanceCriterionRow,
  head: CriterionHeadRow | undefined,
): AcceptanceCriterion {
  const criterion: AcceptanceCriterion = {
    id: row.criterion_id,
    text: row.text,
    verifies_by: row.verifies_by,
    check: row.check_payload,
    status: row.status,
    idempotent: row.idempotent !== 0,
    superseded_by: row.superseded_by,
    reason: row.reason,
    inherited_from: row.inherited_from,
  };
  if (row.scope !== null) criterion.scope = row.scope as AcceptanceScope;
  if (row.timeout !== null) criterion.timeout = row.timeout;

  if (row.verifies_by === 'gate') {
    criterion.gate =
      head && head.channel === 'gate'
        ? {
            verdict: head.verdict as GateVerdict,
            responder: head.by_whom,
            comment: head.comment,
            responded_at: head.at,
          }
        : { verdict: 'gate_pending' };
  } else if (head && head.channel === 'verification') {
    criterion.verification = {
      verdict: head.verdict as VerificationVerdict,
      reason: head.reason,
      verified_by: head.by_whom,
      verified_at: head.at,
    };
  }
  return criterion;
}

/**
 * Parse a nullable JSON column without throwing. NULL → `null`. On a parse
 * failure, emit a one-line stderr warning naming the task and field, then
 * return `null` so a single corrupt row cannot crash every task read.
 */
function safeParseJson<T>(raw: string | null, taskId: string, field: string): T | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    process.stderr.write(`scrum: task '${taskId}' has corrupt ${field}; treating as null\n`);
    return null;
  }
}

/**
 * Raw `scrum_escalations` row shape — identical to `EscalationRow` except the
 * v25 `attributes` column arrives as a JSON string|null. `decodeEscalation` is
 * the sole bridge to the public `EscalationRow`, parsing `attributes` into
 * `EscalationAttributes | null`.
 */
type EscalationRowRaw = Omit<EscalationRow, 'attributes'> & { attributes: string | null };

/**
 * Decode a raw escalation row into the public `EscalationRow`, parsing the JSON
 * `attributes` column. A corrupt `attributes` value degrades to `null` (with a
 * stderr warning) rather than throwing, so one poisoned row cannot brick every
 * escalation read — mirroring `decodeTask`'s tolerance for its JSON columns.
 */
function decodeEscalation(row: EscalationRowRaw): EscalationRow {
  const { attributes, ...rest } = row;
  return { ...rest, attributes: parseEscalationAttributes(attributes, row.id) };
}

function parseEscalationAttributes(
  raw: string | null,
  escalationId: string,
): EscalationAttributes | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as EscalationAttributes;
  } catch {
    process.stderr.write(
      `scrum: escalation '${escalationId}' has corrupt attributes; treating as null\n`,
    );
    return null;
  }
}

/**
 * Acceptance freeze guard. While a worker is in-flight on a
 * task (`status === 'in_progress'`), its acceptance criteria are frozen —
 * `addCriterion`/`supersedeCriterion` reject so the goalposts cannot move under
 * a running worker. Every other status is amendable; interrupt the worker
 * (transition off `in_progress`) before editing criteria. Applies to all
 * layers, not just stories — any in-flight task's criteria are load-bearing.
 */
function assertAcceptanceUnfrozen(task: ScrumTask, method: string): void {
  if (task.status === 'in_progress') {
    throw new Error(
      `${method}: acceptance criteria are frozen while task '${task.id}' is in_progress; interrupt the worker (move it off in_progress) before amending criteria`,
    );
  }
}

/**
 * Dedupe a glob array, dropping empty entries, preserving the canonical sorted
 * order the store guarantees on read. A blank glob is meaningless on either
 * scope side, so it is filtered rather than stored.
 */
function dedupeGlobs(globs: string[]): string[] {
  return [...new Set(globs.filter((g) => g.length > 0))].sort();
}

/**
 * The first overlapping (globA, globB) pair between two teams' write-glob sets,
 * or null when every pair is disjoint. Globs are compared in sorted order so the
 * returned conflict is deterministic. Team slugs are ordered (`teamA <= teamB`)
 * on the result for stable reporting.
 */
function firstGlobOverlap(
  slugA: string,
  writeA: string[],
  slugB: string,
  writeB: string[],
): TeamWriteScopeConflict | null {
  for (const globA of [...writeA].sort()) {
    for (const globB of [...writeB].sort()) {
      if (globsOverlap(globA, globB)) {
        return slugA <= slugB
          ? { teamA: slugA, teamB: slugB, globA, globB }
          : { teamA: slugB, teamB: slugA, globA: globB, globB: globA };
      }
    }
  }
  return null;
}

/**
 * Render a write-scope conflict into an actionable error message naming both
 * conflicting teams and the overlapping globs — the single-writer-per-path
 * violation surfaced to the operator.
 */
function formatWriteScopeConflict(conflict: TeamWriteScopeConflict): string {
  const globs =
    conflict.globA === conflict.globB
      ? `glob '${conflict.globA}'`
      : `globs '${conflict.globA}' and '${conflict.globB}'`;
  return `write-scope overlap: team '${conflict.teamA}' and team '${conflict.teamB}' both claim ${globs} — write scopes must be disjoint (single writer per path)`;
}

/**
 * Enforce the team lifetime↔target consistency rule (v18): a
 * `terminates_on_milestone` team MUST carry a `terminates_on_milestone` target,
 * and a `persistent` team MUST NOT. The target is the concrete milestone a
 * terminating-lifetime team disbands on, so a terminating team with no target
 * can never be triggered (a dead lifetime), and a persistent team with a target
 * would be silently disbanded by the milestone-close trigger despite declaring
 * itself permanent. Both are rejected at the store boundary. Throws with a
 * `${method}:`-prefixed message matching the surrounding enum-guard style.
 */
function assertLifetimeTargetConsistent(
  method: string,
  lifetime: TeamLifetime,
  target: string | null,
): void {
  if (lifetime === 'terminates_on_milestone' && target === null) {
    throw new Error(
      `${method}: a 'terminates_on_milestone' team requires a terminates_on_milestone target`,
    );
  }
  if (lifetime === 'persistent' && target !== null) {
    throw new Error(
      `${method}: a 'persistent' team must not carry a terminates_on_milestone target`,
    );
  }
}

/** Closed top-level key set for `TaskBounds`. */
const BOUNDS_TOP_LEVEL_KEYS = new Set(['read', 'write', 'tools', 'budgets']);

/**
 * Validate a `TaskBounds` shape on write (createTask / setBounds). Rejects
 * unknown top-level keys so a typo (`reads`, `tool`) fails loud rather than
 * landing silently-ignored bounds; every recognized sub-field is optional, so
 * `{}` and any subset of `{ read, write, tools, budgets }` pass. The contents
 * of the sub-fields are NOT deeply type-checked — the column is
 * forward-compatible JSON, and the plan-side run-state schema re-validates the
 * forwarded shape on load. Mirrors `validateAcceptance`'s write-time guard.
 */
function validateBounds(bounds: TaskBounds): void {
  if (typeof bounds !== 'object' || bounds === null || Array.isArray(bounds)) {
    throw new Error('bounds must be a JSON object');
  }
  const unknown = Object.keys(bounds).filter((k) => !BOUNDS_TOP_LEVEL_KEYS.has(k));
  if (unknown.length > 0) {
    throw new Error(
      `bounds: unknown top-level key(s) '${unknown.join(', ')}'; expected a subset of: read, write, tools, budgets`,
    );
  }
}

/**
 * Whether a criterion's scope descends to inheriting children. `descendants`
 * and `both` copy down; `self` does not. An absent scope is the copy-down
 * default (`both`), so pre-scope criteria keep inheriting as before.
 */
function copiesDown(scope: AcceptanceScope | undefined): boolean {
  return scope === undefined || scope === 'descendants' || scope === 'both';
}

/**
 * Whether a criterion is a goalpost on the task it is authored on. `self` and
 * `both` apply to the task itself; `descendants` does NOT — a `descendants`
 * criterion is a goalpost the parent declares FOR its subtree, satisfied on the
 * children that inherited it, never evaluated against the parent. An absent
 * scope defaults to `both` (the legacy copy-down default also applied to self),
 * so pre-scope criteria stay goalposts on their own task exactly as before.
 * Dual of `copiesDown`.
 */
function appliesToSelf(scope: AcceptanceScope | undefined): boolean {
  return scope === undefined || scope === 'self' || scope === 'both';
}

/**
 * Build a `pending` (unverified) `CriterionResult` — the criterion could not be
 * decided in this call (delegated to the driver, or missing the git/run context
 * a heavy kind needs). Not `ok`, but not a confirmed failure either; the reason
 * names why it is unresolved.
 */
function pendingResult(
  criterion: AcceptanceCriterion,
  kind: AcceptanceCriterion['verifies_by'],
  reason: string,
): CriterionResult {
  return { id: criterion.id, kind, ok: false, pending: true, reason };
}

/**
 * Return a copy of `acceptance` with every `gate`-kind criterion guaranteed to
 * carry a gate state. A gate-kind criterion missing a `gate` field is seeded
 * `{ verdict: 'gate_pending' }` — a fresh gate always starts pending and
 * resolvable; an already-stated gate (any verdict) is left untouched. Non-gate
 * criteria never carry gate state — a stray `gate` on them is stripped so the
 * field maps 1:1 to the gate kind. Idempotent: re-seeding a seeded object is a
 * no-op. Does not mutate the input.
 */
function withGateStatesSeeded(acceptance: Acceptance): Acceptance {
  const criteria = acceptance.criteria.map((c) => {
    if (c.verifies_by === 'gate') {
      return c.gate ? c : { ...c, gate: { verdict: 'gate_pending' as GateVerdict } };
    }
    if (c.gate === undefined) return c;
    const { gate: _drop, ...rest } = c;
    return rest;
  });
  return acceptance.policy ? { criteria, policy: acceptance.policy } : { criteria };
}

/**
 * Whether a single acceptance criterion currently counts as satisfied from the
 * store's mechanical vantage. Only `gate`-kind is decided here: an `approved`
 * verdict satisfies, `gate_pending`/`rejected` do not. The other three kinds
 * are decided by their downstream channels (validators / assert evaluator /
 * validation-agent), so this returns false for them — the store does not run a
 * shell, evaluate an expression, or call a model.
 */
export function criterionSatisfied(criterion: AcceptanceCriterion): boolean {
  if (criterion.verifies_by !== 'gate') return false;
  return (criterion.gate?.verdict ?? 'gate_pending') === 'approved';
}

/**
 * Enforce the acceptance write-time invariants:
 *
 *   - scope is a closed enum — any criterion carrying a `scope` outside
 *     `descendants | self | both` is rejected so an unknown value cannot land
 *     silently and break copy-down gating. Absent scope is the legal default.
 *   - policy invariant — a `parallel` eval_order or a `failed_only`
 *     rerun_policy is only valid when every criterion is `idempotent: true`.
 *     Non-idempotent criteria cannot be safely re-run or run concurrently, so
 *     the policy is rejected at write time. No policy (the default sequential /
 *     re-run-all behavior) always passes.
 */
function validateAcceptance(acceptance: Acceptance): void {
  const badScope = acceptance.criteria.find(
    (c) => c.scope !== undefined && !ACCEPTANCE_SCOPES.includes(c.scope),
  );
  if (badScope) {
    throw new Error(
      `acceptance criterion '${badScope.id}' has invalid scope '${badScope.scope}'; expected one of: ${ACCEPTANCE_SCOPES.join(', ')}`,
    );
  }

  // Closed-enum guard on the persisted gate verdict: a criterion carrying a
  // `gate.verdict` outside `gate_pending | approved | rejected` is rejected so
  // an unknown verdict cannot land silently and corrupt satisfaction reads.
  const badGate = acceptance.criteria.find(
    (c) => c.gate !== undefined && !(GATE_VERDICTS as string[]).includes(c.gate.verdict),
  );
  if (badGate) {
    throw new Error(
      `acceptance criterion '${badGate.id}' has invalid gate verdict '${badGate.gate?.verdict}'; expected one of: ${GATE_VERDICTS.join(', ')}`,
    );
  }

  // Closed-enum guard on the recorded verification verdict: a criterion carrying
  // a `verification.verdict` outside `pending | verified | failed` is rejected
  // so an unknown verdict cannot land silently and corrupt the close-floor read.
  const badVerification = acceptance.criteria.find(
    (c) =>
      c.verification !== undefined &&
      !(VERIFICATION_VERDICTS as string[]).includes(c.verification.verdict),
  );
  if (badVerification) {
    throw new Error(
      `acceptance criterion '${badVerification.id}' has invalid verification verdict '${badVerification.verification?.verdict}'; expected one of: ${VERIFICATION_VERDICTS.join(', ')}`,
    );
  }

  const policy = acceptance.policy;
  if (!policy) return;
  const needsIdempotent = policy.eval_order === 'parallel' || policy.rerun_policy === 'failed_only';
  if (!needsIdempotent) return;
  const offender = acceptance.criteria.find((c) => !c.idempotent);
  if (offender) {
    throw new Error(
      `acceptance policy '${policy.eval_order}/${policy.rerun_policy}' requires every criterion to be idempotent; criterion '${offender.id}' is not`,
    );
  }
}

/**
 * Fold a parent's children's DERIVED statuses into the parent's rolled-up
 * status. Precedence (see `derivedStatus`): in_progress > blocked > done >
 * review > ready > accepted > proposed > backlog. `done` requires a non-empty
 * non-cancelled quorum where every non-cancelled child is done, so an
 * all-cancelled subtree rolls up to backlog rather than done. The review states
 * `accepted`/`proposed` sit just above `backlog`, in lifecycle order, so a
 * subtree mid-decomposition-review surfaces that progress. Invariant: callers
 * only invoke this for a parent with ≥1 live child.
 */
export function foldChildStatuses(childStatuses: TaskStatus[]): TaskStatus {
  const anyOf = (s: TaskStatus): boolean => childStatuses.includes(s);
  if (anyOf('in_progress')) return 'in_progress';
  if (anyOf('blocked')) return 'blocked';

  const nonCancelled = childStatuses.filter((s) => s !== 'cancelled');
  if (nonCancelled.length > 0 && nonCancelled.every((s) => s === 'done')) return 'done';

  if (anyOf('review')) return 'review';
  if (anyOf('ready')) return 'ready';
  if (anyOf('accepted')) return 'accepted';
  if (anyOf('proposed')) return 'proposed';
  return 'backlog';
}

/**
 * Resolve a `(from, to, kind)` edge to its canonical `blocks` endpoints.
 * `blocks` passes through unchanged; `blocked_by` is the inverse, so the
 * endpoints swap ("X blocked_by Y" === "Y blocks X"). The kind is dropped
 * by callers since canonical storage is always `blocks`.
 */
function normalizeDepEdge(
  fromTaskId: string,
  toTaskId: string,
  kind: DepKind,
): [from: string, to: string] {
  return kind === 'blocked_by' ? [toTaskId, fromTaskId] : [fromTaskId, toTaskId];
}

function decodeEvent(row: {
  id: string;
  task_id: string;
  ts: string;
  kind: string;
  agent: string | null;
  payload_json: string;
}): ScrumEvent {
  return {
    id: row.id,
    task_id: row.task_id,
    ts: row.ts,
    kind: row.kind as EventKind,
    agent: row.agent,
    payload: JSON.parse(row.payload_json) as unknown,
  };
}

/**
 * Weighted milestone boost for `nextReady`. Three tiers:
 *   1.0 — task matches the explicit filter milestone, OR the task's
 *         milestone is in the active set (operator has promoted it).
 *   0.5 — task is bound to a non-closed milestone (planned). Partial
 *         credit so milestone-bound work outranks fully unlinked work
 *         even before activation.
 *   0   — task is unlinked, OR its milestone is closed (terminal).
 *
 * `closedMilestones` is required so we can score "closed" without a
 * per-task DB lookup; callers (see `nextReady`) snapshot both sets once
 * per invocation. A milestone id present in neither set is treated as
 * planned — matches `MilestoneStatus = 'planned' | 'active' | 'closed'`.
 */
function computeMilestoneBoost(
  task: ScrumTask,
  filterMilestoneId: string | undefined,
  activeMilestones: Set<string>,
  closedMilestones: Set<string>,
): number {
  if (task.milestone_id === null) return 0;
  if (filterMilestoneId !== undefined) {
    return task.milestone_id === filterMilestoneId ? 1 : 0;
  }
  if (activeMilestones.has(task.milestone_id)) return 1;
  if (closedMilestones.has(task.milestone_id)) return 0;
  return 0.5;
}

/**
 * Hotness = exp(-hoursSinceLastEvent / 24). Brand-new events score ~1,
 * decays to ~0.37 after 24h, ~0.018 after 4 days. Null `last_event_at`
 * yields 0 (never touched = cold).
 */
function computeContextHotness(lastEventAt: string | null, nowMs: number): number {
  if (!lastEventAt) return 0;
  const eventMs = Date.parse(lastEventAt);
  if (Number.isNaN(eventMs)) return 0;
  const hours = Math.max(0, (nowMs - eventMs) / (1000 * 60 * 60));
  return Math.exp(-hours / 24);
}

// ---------------------------------------------------------------------------
// Structured escalation typing
// ---------------------------------------------------------------------------

/** Boost cap (days) and per-day weight for the staleness auto-bubble. */
const ESCALATION_BASE_BOOST = 5;
const ESCALATION_AGE_CAP_DAYS = 30;
const ESCALATION_PER_DAY = 0.5;

/**
 * Validate a `blocker_raised` event payload as a typed `EscalationPayload`.
 * Requires `escalation_type` in the closed set and a string
 * `summary`; `blocking_task_id`, when present, must be a string or null.
 * Throws a domain error on any violation so a malformed escalation fails at
 * `appendEvent` rather than persisting as an untyped row.
 */
function validateEscalationPayload(payload: unknown): asserts payload is EscalationPayload {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error("appendEvent: 'blocker_raised' payload must be an EscalationPayload object");
  }
  const p = payload as Record<string, unknown>;
  if (!(ESCALATION_TYPES as string[]).includes(p.escalation_type as string)) {
    throw new Error(
      `appendEvent: escalation_type must be one of: ${ESCALATION_TYPES.join(', ')} (got '${String(p.escalation_type)}')`,
    );
  }
  if (typeof p.summary !== 'string' || p.summary.length === 0) {
    throw new Error("appendEvent: escalation payload requires a non-empty 'summary' string");
  }
  if (
    p.blocking_task_id !== undefined &&
    p.blocking_task_id !== null &&
    typeof p.blocking_task_id !== 'string'
  ) {
    throw new Error("appendEvent: escalation 'blocking_task_id' must be a string or null");
  }
}

/**
 * Extract the `escalation_type` from a stored `blocker_raised` payload JSON,
 * or null when the JSON is malformed or untyped. Read-path counterpart to
 * `validateEscalationPayload` — tolerant (never throws) so one bad row cannot
 * brick `nextReady`/`alerts`.
 */
function parseEscalationType(payloadJson: string): EscalationType | null {
  try {
    const p = JSON.parse(payloadJson) as Record<string, unknown>;
    const t = p?.escalation_type;
    return (ESCALATION_TYPES as string[]).includes(t as string) ? (t as EscalationType) : null;
  } catch {
    return null;
  }
}

/**
 * Staleness auto-bubble boost for an open escalation. Returns 0
 * when there is no escalation; otherwise a base boost that grows linearly with
 * the escalation's age, capped at `ESCALATION_AGE_CAP_DAYS`, so an unresolved
 * escalation ranks progressively higher in `nextReady` the longer it sits.
 */
function computeEscalationBoost(escalatedAt: string | null, nowMs: number): number {
  if (!escalatedAt) return 0;
  const ms = Date.parse(escalatedAt);
  if (Number.isNaN(ms)) return ESCALATION_BASE_BOOST;
  const ageDays = Math.max(0, (nowMs - ms) / (24 * 60 * 60 * 1000));
  return ESCALATION_BASE_BOOST + Math.min(ageDays, ESCALATION_AGE_CAP_DAYS) * ESCALATION_PER_DAY;
}
