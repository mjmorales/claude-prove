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

import type { Database, Statement } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join } from 'node:path';
import { type Store, type StoreOptions, openStore, runMigrations } from '@claude-prove/store';
import { listEntries } from '../acb/reasoning-log-store';
import { type AssertContext, type CriterionVerification, verifyCriterion } from './assert-grammar';
import {
  type BashVerifyResult,
  prepareAgentWorktree,
  verifyBashCriterion,
} from './criterion-verify';
import { globsOverlap } from './glob-overlap';
import { SCRUM_SCHEMA_VERSION, ensureScrumSchemaRegistered } from './schemas';
import type {
  Acceptance,
  AcceptanceCriterion,
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
  VerificationRecord,
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

// ---------------------------------------------------------------------------
// Public openers
// ---------------------------------------------------------------------------

/**
 * Open a scrum store: resolves the unified prove.db, runs every pending
 * migration, and returns the wrapped `ScrumStore`. Pass `{ path: ':memory:' }`
 * in tests for isolation.
 */
export function openScrumStore(opts: StoreOptions = {}): ScrumStore {
  ensureScrumSchemaRegistered();
  const store = openStore(opts);
  runMigrations(store);
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
  /** Containing task id (the tree). Validated to exist, like `milestoneId`. */
  parentId?: string | null;
  /** Containment tier; NULL = flat. */
  layer?: TaskLayer | null;
  /**
   * Acceptance criteria authored at create time (v5). Validated for the
   * idempotent/policy invariant before insert. When omitted, the task's
   * `acceptance_json` stays NULL unless `parentId` carries inheritable
   * criteria (see `inheritAcceptance`).
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
 * Lookup key for `resolveContributor` (v12) — the executing worker / event
 * author to map onto a contributor. Resolution tries `github` first, then falls
 * back to `email`. At least one must be present; both absent resolves to null.
 */
export interface ResolveContributorKey {
  github?: string | null;
  email?: string | null;
}

// ---------------------------------------------------------------------------
// Allowed status transitions — rejected at runtime by updateTaskStatus
// ---------------------------------------------------------------------------

/**
 * Allowed forward transitions. Terminal statuses (`done`, `cancelled`)
 * reject every outgoing edge. Keep in sync with the task lifecycle contract.
 */
const ALLOWED_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  backlog: ['ready', 'in_progress', 'cancelled'],
  ready: ['in_progress', 'blocked', 'cancelled', 'backlog'],
  in_progress: ['review', 'blocked', 'done', 'cancelled', 'ready'],
  review: ['in_progress', 'done', 'cancelled'],
  blocked: ['ready', 'in_progress', 'cancelled'],
  done: [],
  cancelled: [],
};

/**
 * Canonical `scrum_tasks` column list, in declaration order. Every SELECT
 * routes through this so the v3 `parent_id`/`layer`, v5 `acceptance_json`,
 * v6 `bounds_json`, and v11 `worker_id`/`run_id` columns stay in lockstep with
 * the `ScrumTaskRow` shape. Raw rows carry `acceptance_json`/`bounds_json:
 * string | null`; `decodeTask` turns them into the decoded
 * `ScrumTask.acceptance`/`.bounds` fields and assembles the `provenance` block
 * at the public boundary.
 */
const TASK_COLUMNS =
  'id, title, description, status, milestone_id, parent_id, layer, acceptance_json, bounds_json, terminal_reason, terminal_detail, created_by_agent, created_at, last_event_at, last_modified_by, last_modified_at, worker_id, run_id, deleted_at';

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
const LORE_COLUMNS = 'id, team_slug, body, author_contributor_id, created_at';

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
 * Raw `scrum_tasks` SELECT shape — identical to `ScrumTask` except the v5
 * acceptance and v6 bounds columns arrive as their on-disk JSON strings and the
 * derived `provenance` block is absent (assembled by `decodeTask`).
 * `decodeTask` is the sole bridge from this to the public `ScrumTask`.
 */
type ScrumTaskRow = Omit<ScrumTask, 'acceptance' | 'bounds' | 'provenance'> & {
  acceptance_json: string | null;
  bounds_json: string | null;
};

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
  private readonly db: Database;
  private readonly statements: Map<string, Statement> = new Map();

  constructor(store: Store) {
    this.store = store;
    this.db = store.getDb();
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
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
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
  createTask(input: CreateTaskInput): ScrumTask {
    const createdAt = input.createdAt ?? isoNow();
    const status: TaskStatus = input.status ?? 'backlog';
    const milestoneId = input.milestoneId ?? null;
    const parentId = input.parentId ?? null;

    if (milestoneId !== null) {
      const exists = this.getMilestone(milestoneId);
      if (!exists) {
        throw new Error(`createTask: unknown milestone_id '${milestoneId}'`);
      }
    }

    if (parentId !== null) {
      const parent = this.getTask(parentId);
      if (!parent) {
        throw new Error(`createTask: unknown parent_id '${parentId}'`);
      }
    }

    // Resolve acceptance: explicit input wins; otherwise inherit the parent's
    // shared_acceptance criteria (independent copies tagged `inherited_from`).
    // Validated for the idempotent/policy invariant before insert.
    const authored = input.acceptance ?? null;
    let acceptance: Acceptance | null = authored;
    if (authored === null && parentId !== null) {
      const inherited = this.inheritAcceptance(parentId);
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

    const row: ScrumTask = {
      id: input.id,
      title: input.title,
      description: input.description ?? null,
      status,
      milestone_id: milestoneId,
      parent_id: parentId,
      layer: input.layer ?? null,
      acceptance,
      bounds,
      terminal_reason: null,
      terminal_detail: null,
      created_by_agent: input.createdByAgent ?? null,
      created_at: createdAt,
      last_event_at: createdAt,
      // Seed last-touch provenance (v9) to the creation event so a fresh task
      // already reads coherently before its first mutation.
      last_modified_by: input.createdByAgent ?? null,
      last_modified_at: createdAt,
      worker_id: workerId,
      run_id: runId,
      deleted_at: null,
      provenance: {
        created_by: input.createdByAgent ?? null,
        created_at: createdAt,
        last_modified_by: input.createdByAgent ?? null,
        last_modified_at: createdAt,
        worker_id: workerId,
        run_id: runId,
        schema_version: SCRUM_SCHEMA_VERSION,
      },
    };

    const tx = this.db.transaction(() => {
      this.prep(
        'INSERT INTO scrum_tasks (id, title, description, status, milestone_id, parent_id, layer, acceptance_json, bounds_json, created_by_agent, created_at, last_event_at, last_modified_by, last_modified_at, worker_id, run_id, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)',
      ).run(
        row.id,
        row.title,
        row.description,
        row.status,
        row.milestone_id,
        row.parent_id,
        row.layer,
        acceptance === null ? null : JSON.stringify(acceptance),
        bounds === null ? null : JSON.stringify(bounds),
        row.created_by_agent,
        row.created_at,
        row.last_event_at,
        row.last_modified_by,
        row.last_modified_at,
        row.worker_id,
        row.run_id,
      );

      if (input.tags && input.tags.length > 0) {
        const stmt = this.prep('INSERT INTO scrum_tags (task_id, tag, added_at) VALUES (?, ?, ?)');
        for (const tag of input.tags) {
          stmt.run(row.id, tag, createdAt);
        }
      }

      this.prep(
        'INSERT INTO scrum_events (task_id, ts, kind, agent, payload_json) VALUES (?, ?, ?, ?, ?)',
      ).run(
        row.id,
        createdAt,
        'task_created',
        row.created_by_agent,
        JSON.stringify({ title: row.title }),
      );
    });
    tx();

    return row;
  }

  /** Fetch one task by id, or null if missing or soft-deleted. */
  getTask(id: string): ScrumTask | null {
    const row = this.prep(
      `SELECT ${TASK_COLUMNS} FROM scrum_tasks WHERE id = ? AND deleted_at IS NULL`,
    ).get(id) as ScrumTaskRow | null;
    return row ? decodeTask(row) : null;
  }

  /**
   * Fetch one task by id ignoring the soft-delete filter, or null if no row
   * physically exists. Unlike `getTask`, a soft-deleted row is still returned.
   * Used to distinguish "never existed" from "soft-deleted" so a unique
   * sentinel (see `ensureOrphanTask`) can be revived rather than re-inserted
   * into a PK conflict.
   */
  getTaskIncludingDeleted(id: string): ScrumTask | null {
    const row = this.prep(`SELECT ${TASK_COLUMNS} FROM scrum_tasks WHERE id = ?`).get(
      id,
    ) as ScrumTaskRow | null;
    return row ? decodeTask(row) : null;
  }

  /** Clear `deleted_at`, reviving a soft-deleted task. No-op on a live row. */
  undeleteTask(id: string): void {
    this.prep('UPDATE scrum_tasks SET deleted_at = NULL WHERE id = ?').run(id);
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
  listTasks(options: ListTasksOptions = {}): ScrumTask[] {
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
    return (this.prep(sql).all(...params) as ScrumTaskRow[]).map(decodeTask);
  }

  /**
   * Update a task's status. Rejects invalid transitions (see
   * `ALLOWED_TRANSITIONS`) and unknown task ids. Appends a
   * `status_changed` event inside the same transaction and bumps
   * `last_event_at`.
   */
  updateTaskStatus(id: string, next: TaskStatus, agent?: string | null): ScrumTask {
    const task = this.getTask(id);
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
      this.assertStoryAcceptanceFloor(task, next);
      if (next === 'done') this.assertStorySynthesisFloor(task);
    }

    const ts = isoNow();
    const { workerId, runId } = resolveRunContext();
    const tx = this.db.transaction(() => {
      this.prep(
        'UPDATE scrum_tasks SET status = ?, last_event_at = ?, last_modified_by = ?, last_modified_at = ?, worker_id = ?, run_id = ? WHERE id = ?',
      ).run(next, ts, agent ?? null, ts, workerId, runId, id);
      this.prep(
        'INSERT INTO scrum_events (task_id, ts, kind, agent, payload_json) VALUES (?, ?, ?, ?, ?)',
      ).run(
        id,
        ts,
        'status_changed',
        agent ?? null,
        JSON.stringify({ from: task.status, to: next }),
      );
    });
    tx();

    const updated = this.getTask(id);
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
  updateTaskMilestone(
    id: string,
    nextMilestoneId: string | null,
    agent?: string | null,
  ): ScrumTask {
    const task = this.getTask(id);
    if (!task) throw new Error(`updateTaskMilestone: unknown task '${id}'`);

    if (nextMilestoneId !== null) {
      const target = this.getMilestone(nextMilestoneId);
      if (!target) {
        throw new Error(`updateTaskMilestone: unknown milestone_id '${nextMilestoneId}'`);
      }
    }

    if (task.milestone_id === nextMilestoneId) {
      return task;
    }

    const ts = isoNow();
    const { workerId, runId } = resolveRunContext();
    const tx = this.db.transaction(() => {
      this.prep(
        'UPDATE scrum_tasks SET milestone_id = ?, last_event_at = ?, last_modified_by = ?, last_modified_at = ?, worker_id = ?, run_id = ? WHERE id = ?',
      ).run(nextMilestoneId, ts, agent ?? null, ts, workerId, runId, id);
      this.prep(
        'INSERT INTO scrum_events (task_id, ts, kind, agent, payload_json) VALUES (?, ?, ?, ?, ?)',
      ).run(
        id,
        ts,
        'milestone_changed',
        agent ?? null,
        JSON.stringify({ from: task.milestone_id, to: nextMilestoneId }),
      );
    });
    tx();

    const updated = this.getTask(id);
    if (!updated) throw new Error(`updateTaskMilestone: task '${id}' vanished mid-update`);
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
  softDeleteTask(id: string): void {
    const task = this.getTask(id);
    if (!task) throw new Error(`softDeleteTask: unknown task '${id}'`);

    const ts = isoNow();
    const { workerId, runId } = resolveRunContext();
    const tx = this.db.transaction(() => {
      this.prep(
        'UPDATE scrum_tasks SET deleted_at = ?, last_modified_by = NULL, last_modified_at = ?, worker_id = ?, run_id = ? WHERE id = ?',
      ).run(ts, ts, workerId, runId, id);
      this.prep(
        'INSERT INTO scrum_events (task_id, ts, kind, agent, payload_json) VALUES (?, ?, ?, ?, ?)',
      ).run(id, ts, 'task_deleted', null, JSON.stringify({ status: task.status }));
    });
    tx();
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
  cancelTask(
    id: string,
    opts: { reason?: string; detail?: string | null; agent?: string | null } = {},
  ): ScrumTask {
    const task = this.getTask(id);
    if (!task) throw new Error(`cancelTask: unknown task '${id}'`);
    if (task.status === 'done' || task.status === 'cancelled') {
      throw new Error(`cancelTask: task '${id}' is already terminal ('${task.status}')`);
    }
    this.transaction(() => {
      this.cancelOne(id, opts.reason ?? 'cancelled', opts.detail ?? null, opts.agent ?? null);
    });
    return this.requireTask(id, 'cancelTask');
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
  cancelTaskCascade(
    rootId: string,
    opts: { reason?: string; detail?: string | null; agent?: string | null } = {},
  ): { cancelled: string[] } {
    const root = this.getTask(rootId);
    if (!root) throw new Error(`cancelTaskCascade: unknown task '${rootId}'`);

    const cancelled: string[] = [];
    const agent = opts.agent ?? null;
    const childDetail = `parent '${rootId}' cancelled`;

    this.transaction(() => {
      if (this.cancelOne(rootId, opts.reason ?? 'cancelled', opts.detail ?? null, agent)) {
        cancelled.push(rootId);
      }
      const visited = new Set<string>([rootId]);
      const stack = this.getChildren(rootId).map((c) => c.id);
      while (stack.length > 0) {
        const id = stack.pop();
        if (id === undefined || visited.has(id)) continue;
        visited.add(id);
        if (this.cancelOne(id, 'parent_cancelled', childDetail, agent)) {
          cancelled.push(id);
        }
        for (const child of this.getChildren(id)) stack.push(child.id);
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
  private cancelOne(
    id: string,
    reason: string,
    detail: string | null,
    agent: string | null,
  ): boolean {
    const task = this.getTask(id);
    if (!task) return false;
    if (task.status === 'done' || task.status === 'cancelled') return false;

    const ts = isoNow();
    const { workerId, runId } = resolveRunContext();
    this.prep(
      'UPDATE scrum_tasks SET status = ?, terminal_reason = ?, terminal_detail = ?, last_event_at = ?, last_modified_by = ?, last_modified_at = ?, worker_id = ?, run_id = ? WHERE id = ?',
    ).run('cancelled', reason, detail, ts, agent, ts, workerId, runId, id);
    this.prep(
      'INSERT INTO scrum_events (task_id, ts, kind, agent, payload_json) VALUES (?, ?, ?, ?, ?)',
    ).run(
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
    return true;
  }

  // ==========================================================================
  // Story-layer transition floors (v7)
  // ==========================================================================

  /**
   * Reject a `layer=story` transition INTO `ready`/`in_progress`/`done` when
   * the story has zero APPLICABLE active acceptance criteria, and additionally
   * reject `→ done` when any applicable criterion is unsatisfied. A story with
   * no goalposts cannot be started or closed; superseded criteria do not count.
   * Other target statuses (`blocked`, `review`, `cancelled`, `backlog`) pass —
   * a story may be parked or abandoned without criteria. Invariant: only
   * called for `task.layer === 'story'`.
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
   *     (which has the run context + git) and RECORDED onto the criterion's
   *     `verification`; this floor READS that record. An unsatisfied (`failed`)
   *     or never-recorded (`pending`/absent) verdict blocks the close.
   */
  private assertStoryAcceptanceFloor(task: ScrumTask, next: TaskStatus): void {
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
        `updateTaskStatus: story '${task.id}' cannot close — unsatisfied acceptance criteria: ${detail}. Approve gate criteria (\`scrum gate respond\`) and record heavy-kind verdicts at the orchestrator validation gate before '${next}'.`,
      );
    }
  }

  /**
   * Reject a `layer=story` -> `done` transition when the story's most-recent
   * linked run carries no `synthesis` reasoning-log entry.
   * The synthesis entry is the worker's hand-off-of-record; closing a story
   * without it loses the episode's outcome.
   *
   * Boundary: the floor applies only once a worker has run — a story with NO
   * linked runs has no episode to synthesize and passes. The orchestrator
   * always links a run before dispatch, so the only way to reach `done` with
   * no run is a manually-driven story, which the floor intentionally does not
   * gate. Invariant: only called for `task.layer === 'story'`.
   */
  private assertStorySynthesisFloor(task: ScrumTask): void {
    const runs = this.listRunsForTask(task.id);
    if (runs.length === 0) return;

    // listRunsForTask is ordered by linked_at ASC — the last entry is the
    // most-recent worker.
    const latest = runs[runs.length - 1];
    if (!latest) return;
    const runDir = this.resolveRunDir(latest.run_path);

    let hasSynthesis = false;
    try {
      hasSynthesis = listEntries(runDir).some((e) => e.type === 'synthesis');
    } catch {
      // A malformed entry file makes the synthesis status unknowable; treat as
      // absent so the floor fails closed rather than waving the story through.
      hasSynthesis = false;
    }

    if (!hasSynthesis) {
      throw new Error(
        `updateTaskStatus: story '${task.id}' cannot close — its most-recent run (${latest.run_path}) has no synthesis reasoning-log entry. The worker must write one before the story reaches 'done'.`,
      );
    }
  }

  /**
   * Resolve a stored `run_path` to an absolute run directory for reasoning-log
   * reads. Absolute paths pass through; relative paths resolve against the
   * workspace root derived from the store's db path
   * (`<root>/.prove/prove.db`). A `:memory:` store has no root, so relative
   * paths resolve against cwd — tests linking real run dirs use absolute paths.
   */
  private resolveRunDir(runPath: string): string {
    if (isAbsolute(runPath)) return runPath;
    const dbPath = this.store.path;
    const root = dbPath === ':memory:' ? process.cwd() : dirname(dirname(dbPath));
    return join(root, runPath);
  }

  // ==========================================================================
  // Containment tree (v3) — parent_id hierarchy + derived status rollup
  // ==========================================================================

  /**
   * Direct children of `taskId` via `parent_id`, ordered by `created_at` ASC.
   * Excludes soft-deleted rows. Returns `[]` for a leaf or unknown id —
   * callers treat both the same.
   */
  getChildren(taskId: string): ScrumTask[] {
    return (
      this.prep(
        `SELECT ${TASK_COLUMNS} FROM scrum_tasks WHERE parent_id = ? AND deleted_at IS NULL ORDER BY created_at ASC`,
      ).all(taskId) as ScrumTaskRow[]
    ).map(decodeTask);
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
   *   backlog     — otherwise (incl. all-cancelled subtree)
   *
   * Cancelled children are excluded from the `done` quorum so a fully
   * cancelled subtree never reads as done. Recursion is invocation-scoped;
   * a `visited` set guards a malformed `parent_id` cycle (returns the
   * authored status for the re-entered node rather than recursing forever).
   */
  derivedStatus(taskId: string): TaskStatus {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`derivedStatus: unknown task '${taskId}'`);
    return this.rollupStatus(task, new Set<string>());
  }

  /**
   * Post-order fold backing `derivedStatus`. `visited` carries the ancestor
   * chain on the current DFS path; re-entering a node (a parent_id cycle)
   * short-circuits to its authored status instead of recursing.
   */
  private rollupStatus(task: ScrumTask, visited: Set<string>): TaskStatus {
    if (visited.has(task.id)) return task.status;
    visited.add(task.id);

    const children = this.getChildren(task.id);
    if (children.length === 0) {
      visited.delete(task.id);
      return task.status;
    }

    const childStatuses = children.map((child) => this.rollupStatus(child, visited));
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
  setAcceptance(taskId: string, acceptance: Acceptance | null): ScrumTask {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`setAcceptance: unknown task '${taskId}'`);
    const seeded = acceptance === null ? null : withGateStatesSeeded(acceptance);
    if (seeded !== null) validateAcceptance(seeded);
    this.writeAcceptance(taskId, seeded);
    return this.requireTask(taskId, 'setAcceptance');
  }

  /**
   * Append one criterion to a task's acceptance list. Creates
   * the acceptance object if the task had none. Rejects a duplicate criterion
   * id and re-validates the idempotent/policy invariant against any existing
   * policy. Append-only — existing criteria are never mutated or removed.
   */
  addCriterion(taskId: string, criterion: AcceptanceCriterion): ScrumTask {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`addCriterion: unknown task '${taskId}'`);
    assertAcceptanceUnfrozen(task, 'addCriterion');
    const current = task.acceptance;
    const criteria = current ? [...current.criteria] : [];
    if (criteria.some((c) => c.id === criterion.id)) {
      throw new Error(`addCriterion: duplicate criterion id '${criterion.id}' on task '${taskId}'`);
    }
    criteria.push(criterion);
    const next: Acceptance = withGateStatesSeeded(
      current?.policy ? { criteria, policy: current.policy } : { criteria },
    );
    validateAcceptance(next);
    this.writeAcceptance(taskId, next);
    return this.requireTask(taskId, 'addCriterion');
  }

  /**
   * Supersede a criterion in place (append-only). Flips
   * its `status` to `'superseded'`, records `reason`, and optionally points
   * `superseded_by` at a replacement criterion id. Never removes the row —
   * the retired criterion stays in the array for audit, mirroring
   * `supersedeDecision`. Rejects unknown task/criterion ids and an
   * already-superseded criterion.
   */
  supersedeCriterion(
    taskId: string,
    criterionId: string,
    reason: string,
    supersededBy?: string | null,
  ): ScrumTask {
    const task = this.getTask(taskId);
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

    const criteria = task.acceptance.criteria.map((c) =>
      c.id === criterionId
        ? { ...c, status: 'superseded' as const, reason, superseded_by: supersededBy ?? null }
        : c,
    );
    const next: Acceptance = task.acceptance.policy
      ? { criteria, policy: task.acceptance.policy }
      : { criteria };
    this.writeAcceptance(taskId, next);
    return this.requireTask(taskId, 'supersedeCriterion');
  }

  /**
   * Resolve a `gate`-kind criterion's persisted verdict — the mechanical half of
   * the human approve/reject decision. Transitions the criterion's `gate.verdict`
   * from `gate_pending` to `approved` or `rejected`, stamps the human `responder`
   * (the verification contributor of record) and optional `comment`, and appends
   * a `gate_responded` event so the responder is recorded in the append-only
   * audit log. The state round-trips through `acceptance_json` — no DB migration.
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
  respondGate(
    taskId: string,
    criterionId: string,
    verdict: 'approved' | 'rejected',
    opts: { responder: string; comment?: string | null } = { responder: '' },
  ): ScrumTask {
    if (verdict !== 'approved' && verdict !== 'rejected') {
      throw new Error(
        `respondGate: invalid verdict '${verdict}'; expected one of: approved, rejected`,
      );
    }
    const task = this.getTask(taskId);
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
    const gate = { verdict, responder, comment, responded_at: respondedAt };
    const criteria = task.acceptance.criteria.map((c) =>
      c.id === criterionId ? { ...c, gate } : c,
    );
    const next: Acceptance = task.acceptance.policy
      ? { criteria, policy: task.acceptance.policy }
      : { criteria };

    // Single transaction: persist the verdict AND record the human responder as
    // the verification contributor in the append-only event log.
    this.transaction(() => {
      this.writeAcceptance(taskId, next);
      this.appendEvent({
        taskId,
        kind: 'gate_responded',
        agent: responder,
        payload: { criterion_id: criterionId, verdict, responder, comment },
      });
    });
    return this.requireTask(taskId, 'respondGate');
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
    const task = this.getTask(taskId);
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
        if (opts.record) this.recordCriterionVerdict(taskId, criterion.id, verification.ok, reason);
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
        if (opts.record) this.recordCriterionVerdict(taskId, criterion.id, run.ok, reason);
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
   * field (append-style in-place, like `respondGate` for `gate`). The
   * orchestrator validation gate calls this for `assert`/`bash`/`agent`
   * outcomes so the close floor can later read `verified`/`failed` without
   * re-running the check. `ok` maps to `verified`/`failed`; `verified_by`/`_at`
   * are stamped from the run env. Rejects unknown task/criterion ids and a
   * `gate`-kind criterion (whose verdict lives in `gate.verdict`).
   */
  recordCriterionVerdict(
    taskId: string,
    criterionId: string,
    ok: boolean,
    reason: string | null = null,
  ): ScrumTask {
    const task = this.getTask(taskId);
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
    const verification: VerificationRecord = {
      verdict: ok ? 'verified' : 'failed',
      reason: reason && reason.length > 0 ? reason : null,
      verified_by: workerId,
      verified_at: isoNow(),
    };
    const criteria = task.acceptance.criteria.map((c) =>
      c.id === criterionId ? { ...c, verification } : c,
    );
    const next: Acceptance = task.acceptance.policy
      ? { criteria, policy: task.acceptance.policy }
      : { criteria };
    this.writeAcceptance(taskId, next);
    return this.requireTask(taskId, 'recordCriterionVerdict');
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
  inheritAcceptance(parentId: string): AcceptanceCriterion[] {
    const parent = this.getTask(parentId);
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
   * Persist an acceptance object (or NULL) to `scrum_tasks.acceptance_json`.
   * Bumps last-touch provenance (v9): `last_modified_at = now()`,
   * `last_modified_by = NULL` — these editors carry no agent, so the pair
   * honestly records an unattributed most-recent write. Still stamps the
   * executing-worker/run attribution (v11) from the run env so the write's
   * unit and run are recorded even when the agent is not.
   */
  private writeAcceptance(taskId: string, acceptance: Acceptance | null): void {
    const { workerId, runId } = resolveRunContext();
    this.prep(
      'UPDATE scrum_tasks SET acceptance_json = ?, last_modified_by = NULL, last_modified_at = ?, worker_id = ?, run_id = ? WHERE id = ?',
    ).run(
      acceptance === null ? null : JSON.stringify(acceptance),
      isoNow(),
      workerId,
      runId,
      taskId,
    );
  }

  /** Re-fetch a task that must exist after a same-method write. */
  private requireTask(taskId: string, method: string): ScrumTask {
    const updated = this.getTask(taskId);
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
  setBounds(taskId: string, bounds: TaskBounds | null): ScrumTask {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`setBounds: unknown task '${taskId}'`);
    if (bounds !== null) validateBounds(bounds);
    // Bump last-touch provenance (v9); no agent flows here, so by = NULL. Still
    // stamps the executing-worker/run attribution (v11) from the run env.
    const { workerId, runId } = resolveRunContext();
    this.prep(
      'UPDATE scrum_tasks SET bounds_json = ?, last_modified_by = NULL, last_modified_at = ?, worker_id = ?, run_id = ? WHERE id = ?',
    ).run(bounds === null ? null : JSON.stringify(bounds), isoNow(), workerId, runId, taskId);
    return this.requireTask(taskId, 'setBounds');
  }

  // ==========================================================================
  // Milestones
  // ==========================================================================

  createMilestone(input: CreateMilestoneInput): ScrumMilestone {
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
    this.prep(
      'INSERT INTO scrum_milestones (id, title, description, target_state, status, initiative, created_at, closed_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)',
    ).run(
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
  listMilestones(status?: MilestoneStatus, initiative?: string): ScrumMilestone[] {
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
    return this.prep(sql).all(...params) as ScrumMilestone[];
  }

  getMilestone(id: string): ScrumMilestone | null {
    const row = this.prep(`SELECT ${MILESTONE_COLUMNS} FROM scrum_milestones WHERE id = ?`).get(
      id,
    ) as ScrumMilestone | null;
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
  setMilestoneStatus(id: string, status: 'planned' | 'active'): ScrumMilestone {
    const existing = this.getMilestone(id);
    if (!existing) throw new Error(`setMilestoneStatus: unknown milestone '${id}'`);
    if (existing.status === 'closed') {
      throw new Error(`setMilestoneStatus: cannot re-open closed milestone '${id}'`);
    }
    this.prep('UPDATE scrum_milestones SET status = ? WHERE id = ?').run(status, id);
    const updated = this.getMilestone(id);
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
  closeMilestone(id: string): ScrumMilestone {
    const existing = this.getMilestone(id);
    if (!existing) throw new Error(`closeMilestone: unknown milestone '${id}'`);
    const closedAt = isoNow();
    const close = this.db.transaction(() => {
      this.prep('UPDATE scrum_milestones SET status = ?, closed_at = ? WHERE id = ?').run(
        'closed',
        closedAt,
        id,
      );
      this.terminateTeamsForMilestone(id, `milestone '${id}' closed`);
    });
    close();
    return { ...existing, status: 'closed', closed_at: closedAt };
  }

  // ==========================================================================
  // Tags
  // ==========================================================================

  /** Upsert-style: no-op if the `(task_id, tag)` pair already exists. */
  addTag(taskId: string, tag: string, addedAt?: string): void {
    if (!this.getTask(taskId)) throw new Error(`addTag: unknown task '${taskId}'`);
    this.prep('INSERT OR IGNORE INTO scrum_tags (task_id, tag, added_at) VALUES (?, ?, ?)').run(
      taskId,
      tag,
      addedAt ?? isoNow(),
    );
  }

  /** Idempotent: removing a non-existent `(task_id, tag)` pair is a no-op. */
  removeTag(taskId: string, tag: string): void {
    this.prep('DELETE FROM scrum_tags WHERE task_id = ? AND tag = ?').run(taskId, tag);
  }

  listTagsForTask(taskId: string): ScrumTag[] {
    return this.prep(
      'SELECT task_id, tag, added_at FROM scrum_tags WHERE task_id = ? ORDER BY tag ASC',
    ).all(taskId) as ScrumTag[];
  }

  listTasksForTag(tag: string): ScrumTask[] {
    return (
      this.prep(
        `SELECT t.id, t.title, t.description, t.status, t.milestone_id, t.parent_id, t.layer, t.acceptance_json, t.bounds_json, t.terminal_reason, t.terminal_detail, t.created_by_agent, t.created_at, t.last_event_at, t.last_modified_by, t.last_modified_at, t.worker_id, t.run_id, t.deleted_at
       FROM scrum_tasks t
       INNER JOIN scrum_tags g ON g.task_id = t.id
       WHERE g.tag = ? AND t.deleted_at IS NULL
       ORDER BY t.created_at ASC`,
      ).all(tag) as ScrumTaskRow[]
    ).map(decodeTask);
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
  addDep(fromTaskId: string, toTaskId: string, kind: DepKind): void {
    const [from, to] = normalizeDepEdge(fromTaskId, toTaskId, kind);
    if (from === to) {
      throw new Error(`addDep: self-dependency rejected for task '${fromTaskId}'`);
    }
    if (!this.getTask(from)) throw new Error(`addDep: unknown from_task '${from}'`);
    if (!this.getTask(to)) throw new Error(`addDep: unknown to_task '${to}'`);
    this.prep(
      'INSERT OR IGNORE INTO scrum_deps (from_task_id, to_task_id, kind) VALUES (?, ?, ?)',
    ).run(from, to, 'blocks');
  }

  removeDep(fromTaskId: string, toTaskId: string, kind: DepKind): void {
    const [from, to] = normalizeDepEdge(fromTaskId, toTaskId, kind);
    this.prep(
      "DELETE FROM scrum_deps WHERE from_task_id = ? AND to_task_id = ? AND kind = 'blocks'",
    ).run(from, to);
  }

  /** Tasks that *block* `taskId`. SELECT is keyed off `idx_scrum_deps_to_task`. */
  getBlockedBy(taskId: string): ScrumDep[] {
    return this.prep(
      "SELECT from_task_id, to_task_id, kind FROM scrum_deps WHERE to_task_id = ? AND kind = 'blocks'",
    ).all(taskId) as ScrumDep[];
  }

  /** Tasks that `taskId` blocks. */
  getBlocking(taskId: string): ScrumDep[] {
    return this.prep(
      "SELECT from_task_id, to_task_id, kind FROM scrum_deps WHERE from_task_id = ? AND kind = 'blocks'",
    ).all(taskId) as ScrumDep[];
  }

  // ==========================================================================
  // Events
  // ==========================================================================

  /**
   * Append an event. Rejects unknown task ids up front so the caller sees
   * a domain error rather than an opaque FK violation. Returns the new
   * row id.
   */
  appendEvent(input: AppendEventInput): number {
    if (!this.getTask(input.taskId)) {
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

    const tx = this.db.transaction(() => {
      const result = this.prep(
        'INSERT INTO scrum_events (task_id, ts, kind, agent, payload_json) VALUES (?, ?, ?, ?, ?)',
      ).run(input.taskId, ts, input.kind, input.agent ?? null, JSON.stringify(payload));
      this.prep('UPDATE scrum_tasks SET last_event_at = ? WHERE id = ?').run(ts, input.taskId);
      return Number(result.lastInsertRowid);
    });
    return tx();
  }

  /** Events for one task, newest-first (matches `idx_scrum_events_task_ts`). */
  listEventsForTask(taskId: string, limit = 100): ScrumEvent[] {
    const rows = this.prep(
      'SELECT id, task_id, ts, kind, agent, payload_json FROM scrum_events WHERE task_id = ? ORDER BY ts DESC, id DESC LIMIT ?',
    ).all(taskId, limit) as Array<{
      id: number;
      task_id: string;
      ts: string;
      kind: string;
      agent: string | null;
      payload_json: string;
    }>;
    return rows.map((r) => decodeEvent(r));
  }

  /** Cross-task recent events. Used by the UI feed. */
  listRecentEvents(limit = 50): ScrumEvent[] {
    const rows = this.db
      .prepare(
        'SELECT id, task_id, ts, kind, agent, payload_json FROM scrum_events ORDER BY ts DESC, id DESC LIMIT ?',
      )
      .all(limit) as Array<{
      id: number;
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

  linkRun(input: LinkRunInput): void {
    if (!this.getTask(input.taskId)) {
      throw new Error(`linkRun: unknown task '${input.taskId}'`);
    }
    this.prep(
      'INSERT OR REPLACE INTO scrum_run_links (task_id, run_path, branch, slug, linked_at) VALUES (?, ?, ?, ?, ?)',
    ).run(
      input.taskId,
      input.runPath,
      input.branch ?? null,
      input.slug ?? null,
      input.linkedAt ?? isoNow(),
    );
  }

  unlinkRun(taskId: string, runPath: string): void {
    this.prep('DELETE FROM scrum_run_links WHERE task_id = ? AND run_path = ?').run(
      taskId,
      runPath,
    );
  }

  listRunsForTask(taskId: string): ScrumRunLink[] {
    return this.prep(
      'SELECT task_id, run_path, branch, slug, linked_at FROM scrum_run_links WHERE task_id = ? ORDER BY linked_at ASC',
    ).all(taskId) as ScrumRunLink[];
  }

  /** Reverse lookup: which task owns `runPath`? Null if none. */
  getTaskForRun(runPath: string): ScrumTask | null {
    const link = this.prep('SELECT task_id FROM scrum_run_links WHERE run_path = ? LIMIT 1').get(
      runPath,
    ) as { task_id: string } | null;
    if (!link) return null;
    return this.getTask(link.task_id);
  }

  // ==========================================================================
  // Context bundles
  // ==========================================================================

  saveContextBundle(taskId: string, bundle: unknown, rebuiltAt?: string): void {
    if (!this.getTask(taskId)) {
      throw new Error(`saveContextBundle: unknown task '${taskId}'`);
    }
    this.prep(
      `INSERT INTO scrum_context_bundles (task_id, rebuilt_at, bundle_json) VALUES (?, ?, ?)
       ON CONFLICT(task_id) DO UPDATE SET rebuilt_at = excluded.rebuilt_at, bundle_json = excluded.bundle_json`,
    ).run(taskId, rebuiltAt ?? isoNow(), JSON.stringify(bundle));
  }

  loadContextBundle(taskId: string): ScrumContextBundle | null {
    const row = this.prep(
      'SELECT task_id, rebuilt_at, bundle_json FROM scrum_context_bundles WHERE task_id = ?',
    ).get(taskId) as { task_id: string; rebuilt_at: string; bundle_json: string } | null;
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
  nextReady(options: NextReadyOptions = {}): NextReadyRow[] {
    const limit = options.limit ?? 10;
    const nowMs = options.nowMs ?? Date.now();

    // Two SQL shapes (with/without milestone filter) — both routed through
    // the prep() cache so the plan is parsed once per process.
    const candidateRows = (
      options.milestoneId
        ? this.prep(
            `SELECT ${TASK_COLUMNS}
             FROM scrum_tasks
             WHERE deleted_at IS NULL AND status IN ('ready', 'backlog') AND milestone_id = ?
             ORDER BY created_at ASC`,
          ).all(options.milestoneId)
        : this.prep(
            `SELECT ${TASK_COLUMNS}
             FROM scrum_tasks
             WHERE deleted_at IS NULL AND status IN ('ready', 'backlog')
             ORDER BY created_at ASC`,
          ).all()
    ) as ScrumTaskRow[];
    const candidates = candidateRows.map(decodeTask);

    // Snapshot active and closed milestone ids in one pass each — both
    // sets feed `computeMilestoneBoost`. Per-invocation lookup keeps the
    // boost calculation O(1) per task without a per-task DB round trip.
    const activeMilestones = new Set(this.listMilestones('active').map((m) => m.id));
    const closedMilestones = new Set(this.listMilestones('closed').map((m) => m.id));

    // Batch the per-candidate tag lookup into a single IN-query. Bun's sqlite
    // binds parameters positionally, so we expand placeholders to match the
    // candidate count. Per-invocation only — tags mutate between calls.
    const tagBoostByTask = this.fetchTagBoosts(candidates.map((t) => t.id));

    // Batch the per-candidate latest-escalation lookup. A task
    // with an open `blocker_raised` escalation auto-bubbles up, weighted by the
    // escalation's age. Per-invocation only — escalations mutate between calls.
    const escalationByTask = this.fetchLatestEscalations(candidates.map((t) => t.id));

    // Memoize unblock_depth within this invocation. The BFS from task `A`
    // and task `B` can both traverse a shared descendant `C`; caching
    // per-root collapses repeated DFS sweeps across the candidate set.
    // Scope is intentionally this single call — task deps can change
    // between invocations.
    const unblockDepthCache = new Map<string, number>();

    const scored: NextReadyRow[] = candidates.map((task) => {
      const unblockDepth = this.computeUnblockDepth(task.id, unblockDepthCache);
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
  recordDecision(input: RecordDecisionInput): DecisionRow {
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
      recorded_by_agent: input.recordedByAgent ?? null,
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
    this.prep(
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
    ).run({
      $id: row.id,
      $title: row.title,
      $topic: row.topic,
      $status: row.status,
      $content: row.content,
      $source_path: row.source_path,
      $content_sha: row.content_sha,
      $recorded_at: row.recorded_at,
      $recorded_by_agent: row.recorded_by_agent,
      $superseded_by: row.superseded_by,
      $reason: row.reason,
      $kind: row.kind,
      $write_status: row.write_status,
      $gate_responder: row.gate_responder,
      $gate_responded_at: row.gate_responded_at,
      $source_lore_id: row.source_lore_id,
      $assertsStatus: assertsStatus,
    });

    // Re-fetch so the returned row reflects any preserved supersession rather
    // than the in-memory `row` (whose status/superseded_by/reason may have
    // been overridden by the CASE branches above).
    const persisted = this.getDecision(row.id);
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
  supersedeDecision(id: string, supersededById: string, reason: string): DecisionRow {
    const existing = this.getDecision(id);
    if (!existing) throw new Error(`supersedeDecision: unknown decision '${id}'`);
    if (existing.status === 'superseded') {
      throw new Error(`supersedeDecision: decision '${id}' is already superseded`);
    }
    if (id === supersededById) {
      throw new Error(`supersedeDecision: decision '${id}' cannot supersede itself`);
    }
    if (!this.getDecision(supersededById)) {
      throw new Error(`supersedeDecision: unknown replacement decision '${supersededById}'`);
    }

    this.prep(
      "UPDATE scrum_decisions SET status = 'superseded', superseded_by = ?, reason = ? WHERE id = ?",
    ).run(supersededById, reason, id);

    const updated = this.getDecision(id);
    if (!updated) throw new Error(`supersedeDecision: decision '${id}' vanished mid-update`);
    return updated;
  }

  /** Fetch one decision by id, or null if missing. */
  getDecision(id: string): DecisionRow | null {
    const row = this.prep(`SELECT ${DECISION_COLUMNS} FROM scrum_decisions WHERE id = ?`).get(
      id,
    ) as DecisionRow | null;
    return row ?? null;
  }

  /**
   * List decisions, newest-first by `recorded_at`. Empty filter returns
   * all rows; `topic` and `status` filters compose with AND. The composed
   * SQL has a small, bounded set of shapes — each routed through `prep()`
   * so the plan cache reuses parsed statements across calls (matches the
   * discipline of `listTasks`).
   */
  listDecisions(filter: ListDecisionsFilter = {}): DecisionRow[] {
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
    return this.prep(sql).all(...params) as DecisionRow[];
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
   */
  approveDecision(id: string, responder: string): DecisionRow {
    const existing = this.requireGatedDraft(id, 'approveDecision');
    if (existing.kind === TECH_LEAD_REVIEW_KIND && !this.holdsTechLeadAnywhere(responder)) {
      throw new Error(
        `approveDecision: glossary decision '${id}' requires a tech_lead review; '${responder}' holds no current tech_lead slot on any team`,
      );
    }
    const respondedAt = isoNow();
    this.prep(
      "UPDATE scrum_decisions SET status = 'accepted', write_status = 'approved', gate_responder = ?, gate_responded_at = ? WHERE id = ?",
    ).run(responder, respondedAt, id);
    return this.requireDecision(id, 'approveDecision');
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
  rejectDecision(id: string, responder: string, reason: string | null = null): DecisionRow {
    this.requireGatedDraft(id, 'rejectDecision');
    const respondedAt = isoNow();
    this.prep(
      "UPDATE scrum_decisions SET write_status = 'rejected', gate_responder = ?, gate_responded_at = ?, reason = ? WHERE id = ?",
    ).run(responder, respondedAt, reason, id);
    return this.requireDecision(id, 'rejectDecision');
  }

  /**
   * Load a decision and assert it is a gated-kind DRAFT awaiting a write-gate
   * decision. Throws on an unknown id, a non-gated decision (no write-gate), or
   * an already-resolved gate (`approved`/`rejected`). Shared guard for
   * `approveDecision`/`rejectDecision`, mirroring `respondGate`'s
   * already-resolved check.
   */
  private requireGatedDraft(id: string, method: string): DecisionRow {
    const existing = this.getDecision(id);
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
  private requireDecision(id: string, method: string): DecisionRow {
    const row = this.getDecision(id);
    if (!row) throw new Error(`${method}: decision '${id}' vanished mid-update`);
    return row;
  }

  /**
   * Whether `contributorId` currently holds an open `tech_lead` slot on ANY
   * team — the tech_lead-review check for a `glossary` write-gate. Reads the
   * open (`to_ts IS NULL`) tech_lead rows across every team, matching how
   * `getTeamRoster` reads the open slot for a single team.
   */
  private holdsTechLeadAnywhere(contributorId: string): boolean {
    const row = this.prep(
      "SELECT 1 FROM scrum_team_members WHERE role = 'tech_lead' AND contributor_id = ? AND to_ts IS NULL LIMIT 1",
    ).get(contributorId);
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
   * rather than silently overwriting (a contributor's keys are edited
   * deliberately, not clobbered by a re-register).
   *
   * `created_by`/`last_modified_by` are seeded to the same agent and
   * `created_at`/`last_modified_at` to the same instant, mirroring how the
   * on-disk `contributor.md` identity artifact seeds its provenance block.
   */
  registerContributor(input: RegisterContributorInput): Contributor {
    const createdAt = input.createdAt ?? isoNow();
    const createdBy = input.createdBy ?? process.env.PROVE_AGENT ?? null;
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
    this.prep(
      `INSERT INTO scrum_contributors (${CONTRIBUTOR_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
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
  getContributor(id: string): Contributor | null {
    const row = this.prep(`SELECT ${CONTRIBUTOR_COLUMNS} FROM scrum_contributors WHERE id = ?`).get(
      id,
    ) as Contributor | null;
    return row ?? null;
  }

  /**
   * List contributors, optionally filtered by `status`, ordered by slug. Empty
   * filter returns all rows (active and inactive) — a retired contributor stays
   * in the registry so past attribution still resolves.
   */
  listContributors(status?: ContributorStatus): Contributor[] {
    if (status !== undefined) {
      return this.prep(
        `SELECT ${CONTRIBUTOR_COLUMNS} FROM scrum_contributors WHERE status = ? ORDER BY slug ASC`,
      ).all(status) as Contributor[];
    }
    return this.prep(
      `SELECT ${CONTRIBUTOR_COLUMNS} FROM scrum_contributors ORDER BY slug ASC`,
    ).all() as Contributor[];
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
  resolveContributor(key: ResolveContributorKey): Contributor | null {
    const github = key.github && key.github.length > 0 ? key.github : null;
    if (github !== null) {
      const byGithub = this.prep(
        `SELECT ${CONTRIBUTOR_COLUMNS} FROM scrum_contributors WHERE lower(github) = lower(?) LIMIT 1`,
      ).get(github) as Contributor | null;
      if (byGithub) return byGithub;
    }

    const email = key.email && key.email.length > 0 ? key.email : null;
    if (email !== null) {
      const byEmail = this.prep(
        `SELECT ${CONTRIBUTOR_COLUMNS} FROM scrum_contributors WHERE lower(email) = lower(?) LIMIT 1`,
      ).get(email) as Contributor | null;
      if (byEmail) return byEmail;
    }

    return null;
  }

  // ==========================================================================
  // Operator-of-record position history (v13)
  // ==========================================================================

  /**
   * Set (or transfer) the operator-of-record to `contributorId`, appending a new
   * open interval to the position history. This is the single role slot — a
   * degenerate one-row roster.
   *
   * Transfer is two writes in ONE transaction: the prior open row (`to_ts IS
   * NULL`) is closed by stamping its `to_ts` to the new holder's `from_ts`, then
   * the new open row is appended. The invariant "at most one open row" holds
   * across the transaction; a reader never sees zero or two open rows. Setting
   * the SAME contributor still appends a fresh interval (a re-affirmation is a
   * new held interval, not a no-op).
   *
   * `contributorId` must be a registered contributor — an unknown id throws
   * rather than recording an unresolvable holder.
   */
  setOperatorOfRecord(input: SetOperatorOfRecordInput): OperatorHistoryRow {
    if (this.getContributor(input.contributorId) === null) {
      throw new Error(`unknown contributor '${input.contributorId}' — register it first`);
    }
    const fromTs = input.fromTs ?? isoNow();
    const createdBy = input.createdBy ?? process.env.PROVE_AGENT ?? null;

    const append = this.db.transaction(() => {
      // Close the current open interval (if any) at the new holder's from_ts.
      this.prep('UPDATE scrum_operator_history SET to_ts = ? WHERE to_ts IS NULL').run(fromTs);
      const result = this.prep(
        'INSERT INTO scrum_operator_history (contributor_id, from_ts, to_ts, created_at, created_by) VALUES (?, ?, NULL, ?, ?)',
      ).run(input.contributorId, fromTs, isoNow(), createdBy);
      return Number(result.lastInsertRowid);
    });
    const id = append();

    const row = this.prep(
      `SELECT ${OPERATOR_HISTORY_COLUMNS} FROM scrum_operator_history WHERE id = ?`,
    ).get(id) as OperatorHistoryRow;
    return row;
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
  operatorOfRecordAt(at: string): Contributor | null {
    const interval = this.prep(
      'SELECT contributor_id FROM scrum_operator_history WHERE from_ts <= ? AND (to_ts IS NULL OR ? < to_ts) ORDER BY from_ts DESC LIMIT 1',
    ).get(at, at) as { contributor_id: string } | null;
    if (interval === null) return null;
    return this.getContributor(interval.contributor_id);
  }

  /**
   * The full operator-of-record position history, oldest interval first. The
   * last row carries `to_ts: null` when a current holder is set. Empty when the
   * role was never set.
   */
  operatorHistory(): OperatorHistoryRow[] {
    return this.prep(
      `SELECT ${OPERATOR_HISTORY_COLUMNS} FROM scrum_operator_history ORDER BY from_ts ASC, id ASC`,
    ).all() as OperatorHistoryRow[];
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
  createTeam(input: CreateTeamInput): Team {
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
    this.prep(`INSERT INTO scrum_teams (${TEAM_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
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
  getTeam(slug: string): Team | null {
    const row = this.prep(`SELECT ${TEAM_COLUMNS} FROM scrum_teams WHERE slug = ?`).get(
      slug,
    ) as Team | null;
    return row ?? null;
  }

  /** List every team, ordered by slug. */
  listTeams(): Team[] {
    return this.prep(`SELECT ${TEAM_COLUMNS} FROM scrum_teams ORDER BY slug ASC`).all() as Team[];
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
  setTeamTerminatesOn(slug: string, milestoneId: string | null): Team {
    const existing = this.getTeam(slug);
    if (existing === null) {
      throw new Error(`setTeamTerminatesOn: unknown team '${slug}'`);
    }
    assertLifetimeTargetConsistent('setTeamTerminatesOn', existing.lifetime, milestoneId);
    this.prep('UPDATE scrum_teams SET terminates_on_milestone = ? WHERE slug = ?').run(
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
  setTeamScopes(slug: string, scopes: TeamScopes): TeamScopes {
    if (this.getTeam(slug) === null) {
      throw new Error(`setTeamScopes: unknown team '${slug}'`);
    }
    const read = dedupeGlobs(scopes.read);
    const write = dedupeGlobs(scopes.write);

    // Validate the candidate write set against every OTHER team's write set
    // before mutating, so a rejected set leaves the store untouched.
    const conflict = this.findWriteScopeConflict(slug, write);
    if (conflict !== null) {
      throw new Error(formatWriteScopeConflict(conflict));
    }

    const replace = this.db.transaction(() => {
      this.prep('DELETE FROM scrum_team_scopes WHERE team_slug = ?').run(slug);
      const insert = this.prep(
        'INSERT INTO scrum_team_scopes (team_slug, kind, glob) VALUES (?, ?, ?)',
      );
      for (const glob of read) insert.run(slug, 'read' satisfies TeamScopeKind, glob);
      for (const glob of write) insert.run(slug, 'write' satisfies TeamScopeKind, glob);
    });
    replace();

    return this.getTeamScopes(slug);
  }

  /**
   * Fetch a team's scope globs, grouped by side. Returns
   * `{ read: [], write: [] }` for a team with no declared scopes (and also for an
   * unknown slug — the absence reads as "no scopes" rather than an error, matching
   * the unscoped default). Both arrays are sorted for a canonical shape.
   */
  getTeamScopes(slug: string): TeamScopes {
    const rows = this.prep(
      'SELECT kind, glob FROM scrum_team_scopes WHERE team_slug = ? ORDER BY kind ASC, glob ASC',
    ).all(slug) as Array<{ kind: string; glob: string }>;
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
  validateTeamWriteScopes(): TeamWriteScopeConflict | null {
    const teams = this.listTeams().map((t) => t.slug);
    const writeBySlug = new Map<string, string[]>();
    for (const slug of teams) writeBySlug.set(slug, this.getTeamScopes(slug).write);

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
  private findWriteScopeConflict(
    candidateSlug: string,
    candidateWrite: string[],
  ): TeamWriteScopeConflict | null {
    for (const team of this.listTeams()) {
      if (team.slug === candidateSlug) continue;
      const otherWrite = this.getTeamScopes(team.slug).write;
      const conflict = firstGlobOverlap(candidateSlug, candidateWrite, team.slug, otherWrite);
      if (conflict !== null) return conflict;
    }
    return null;
  }

  // ==========================================================================
  // Team roster — three-role position history (v16)
  // ==========================================================================

  /**
   * Rotate a team's role slot to `contributorId`, appending a new open interval
   * to that (team, role) position history. The per-(team, role) generalization
   * of `setOperatorOfRecord`.
   *
   * Rotation is two writes in ONE transaction: the prior open row for THAT
   * (team_slug, role) (`to_ts IS NULL`) is closed by stamping its `to_ts` to the
   * new holder's `from_ts`, then the new open row is appended. The invariant
   * "at most one open row per (team, role)" holds across the transaction; a
   * reader never sees zero or two open rows for a slot. Rotating in the SAME
   * contributor still appends a fresh interval (a re-affirmation is a new held
   * interval, not a no-op).
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
  rotateTeamMember(input: RotateTeamMemberInput): RotateTeamMemberResult {
    if (this.getTeam(input.teamSlug) === null) {
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
    const otherOpenRoles = this.openRolesHeldBy(input.teamSlug, input.contributorId).filter(
      (role) => role !== input.role,
    );

    const append = this.db.transaction(() => {
      // Close the current open interval for THIS (team, role) at the new
      // holder's from_ts.
      this.prep(
        'UPDATE scrum_team_members SET to_ts = ? WHERE team_slug = ? AND role = ? AND to_ts IS NULL',
      ).run(fromTs, input.teamSlug, input.role);
      const result = this.prep(
        'INSERT INTO scrum_team_members (team_slug, role, contributor_id, from_ts, to_ts, reason, created_at) VALUES (?, ?, ?, ?, NULL, ?, ?)',
      ).run(input.teamSlug, input.role, input.contributorId, fromTs, reason, isoNow());
      return Number(result.lastInsertRowid);
    });
    const id = append();

    const row = this.prep(`SELECT ${TEAM_MEMBER_COLUMNS} FROM scrum_team_members WHERE id = ?`).get(
      id,
    ) as TeamMemberRow;

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
   * The role slots `contributorId` currently holds open on `teamSlug` — every
   * (team, role) whose open row (`to_ts IS NULL`) names this contributor.
   * Backs the multi-slot warning in `rotateTeamMember`.
   */
  private openRolesHeldBy(teamSlug: string, contributorId: string): TeamRole[] {
    const rows = this.prep(
      'SELECT role FROM scrum_team_members WHERE team_slug = ? AND contributor_id = ? AND to_ts IS NULL',
    ).all(teamSlug, contributorId) as Array<{ role: string }>;
    return rows.map((r) => r.role as TeamRole);
  }

  /**
   * A team's roster — the open (current) holder of each of the three role slots,
   * and optionally the full per-role position history. Tolerates an unknown slug:
   * the returned `current` simply maps every role to null (the absence reads as
   * "no holders" rather than an error, matching `getTeamScopes`).
   *
   * Each role in `current` maps to its single open `TeamMemberRow` (`to_ts IS
   * NULL`) or null when that slot has never been filled. With
   * `includeHistory: true`, `history` carries every interval for the team,
   * oldest-first, grouped by role.
   */
  getTeamRoster(slug: string, opts: { includeHistory?: boolean } = {}): TeamRoster {
    const current = this.emptyRoleMap<TeamMemberRow | null>(null);
    const openRows = this.prep(
      `SELECT ${TEAM_MEMBER_COLUMNS} FROM scrum_team_members WHERE team_slug = ? AND to_ts IS NULL`,
    ).all(slug) as TeamMemberRow[];
    for (const row of openRows) current[row.role] = row;

    if (opts.includeHistory !== true) {
      return { slug, current };
    }

    const history = this.emptyRoleMap<TeamMemberRow[]>([]);
    const allRows = this.prep(
      `SELECT ${TEAM_MEMBER_COLUMNS} FROM scrum_team_members WHERE team_slug = ? ORDER BY from_ts ASC, id ASC`,
    ).all(slug) as TeamMemberRow[];
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
  addTeamAccept(teamSlug: string, askType: string, createdAt?: string): TeamAcceptRow {
    if (this.getTeam(teamSlug) === null) {
      throw new Error(`addTeamAccept: unknown team '${teamSlug}'`);
    }
    if (!ASK_TYPE_PATTERN.test(askType)) {
      throw new Error(
        `addTeamAccept: invalid ask_type '${askType}'; expected kebab-case (e.g. 'schema-change')`,
      );
    }
    const result = this.prep(
      'INSERT INTO scrum_team_accepts (team_slug, ask_type, status, superseded_by, reason, created_at) VALUES (?, ?, ?, NULL, NULL, ?)',
    ).run(teamSlug, askType, 'active' satisfies TeamInterfaceStatus, createdAt ?? isoNow());
    return this.prep(`SELECT ${TEAM_ACCEPT_COLUMNS} FROM scrum_team_accepts WHERE id = ?`).get(
      Number(result.lastInsertRowid),
    ) as TeamAcceptRow;
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
  addTeamExpose(teamSlug: string, input: AddTeamExposeInput): TeamExposeRow {
    if (this.getTeam(teamSlug) === null) {
      throw new Error(`addTeamExpose: unknown team '${teamSlug}'`);
    }
    const result = this.prep(
      'INSERT INTO scrum_team_exposes (team_slug, name, schema_ref, status, superseded_by, reason, created_at) VALUES (?, ?, ?, ?, NULL, NULL, ?)',
    ).run(
      teamSlug,
      input.name,
      input.schemaRef,
      'active' satisfies TeamInterfaceStatus,
      input.createdAt ?? isoNow(),
    );
    return this.prep(`SELECT ${TEAM_EXPOSE_COLUMNS} FROM scrum_team_exposes WHERE id = ?`).get(
      Number(result.lastInsertRowid),
    ) as TeamExposeRow;
  }

  /**
   * Supersede an accept entry in place (append-only). Flips its `status` to
   * `superseded`, records `reason`, and optionally points `superseded_by` at a
   * replacement accept id. Never removes the row — the retired entry stays for
   * audit, mirroring `supersedeCriterion` and `supersedeDecision`. Rejects an
   * unknown id and an already-superseded target.
   */
  supersedeTeamAccept(id: number, reason: string, supersededBy?: number | null): TeamAcceptRow {
    const target = this.prep(
      `SELECT ${TEAM_ACCEPT_COLUMNS} FROM scrum_team_accepts WHERE id = ?`,
    ).get(id) as TeamAcceptRow | null;
    if (target === null) {
      throw new Error(`supersedeTeamAccept: unknown accept id '${id}'`);
    }
    if (target.status === 'superseded') {
      throw new Error(`supersedeTeamAccept: accept id '${id}' is already superseded`);
    }
    this.prep(
      'UPDATE scrum_team_accepts SET status = ?, reason = ?, superseded_by = ? WHERE id = ?',
    ).run('superseded' satisfies TeamInterfaceStatus, reason, supersededBy ?? null, id);
    return this.prep(`SELECT ${TEAM_ACCEPT_COLUMNS} FROM scrum_team_accepts WHERE id = ?`).get(
      id,
    ) as TeamAcceptRow;
  }

  /**
   * Supersede an expose entry in place (append-only). Flips its `status` to
   * `superseded`, records `reason`, and optionally points `superseded_by` at a
   * replacement expose id. Never removes the row. Rejects an unknown id and an
   * already-superseded target.
   */
  supersedeTeamExpose(id: number, reason: string, supersededBy?: number | null): TeamExposeRow {
    const target = this.prep(
      `SELECT ${TEAM_EXPOSE_COLUMNS} FROM scrum_team_exposes WHERE id = ?`,
    ).get(id) as TeamExposeRow | null;
    if (target === null) {
      throw new Error(`supersedeTeamExpose: unknown expose id '${id}'`);
    }
    if (target.status === 'superseded') {
      throw new Error(`supersedeTeamExpose: expose id '${id}' is already superseded`);
    }
    this.prep(
      'UPDATE scrum_team_exposes SET status = ?, reason = ?, superseded_by = ? WHERE id = ?',
    ).run('superseded' satisfies TeamInterfaceStatus, reason, supersededBy ?? null, id);
    return this.prep(`SELECT ${TEAM_EXPOSE_COLUMNS} FROM scrum_team_exposes WHERE id = ?`).get(
      id,
    ) as TeamExposeRow;
  }

  /**
   * A team's published interface — its accept and expose entries. By default
   * only `active` entries are returned; `includeSuperseded: true` returns the
   * full history (active and retired) for audit. Both arrays are ordered by id.
   * Tolerates an unknown slug: both arrays are empty (the absence reads as "no
   * interface" rather than an error, matching `getTeamScopes`).
   */
  getTeamInterface(slug: string, opts: { includeSuperseded?: boolean } = {}): TeamInterface {
    const accepts = this.listTeamAccepts(slug, opts);
    const exposes = this.listTeamExposes(slug, opts);
    return { slug, accepts, exposes };
  }

  /**
   * A team's accept entries, ordered by id. Active-only by default;
   * `includeSuperseded: true` includes retired entries. Tolerates an unknown
   * slug (returns an empty array).
   */
  listTeamAccepts(slug: string, opts: { includeSuperseded?: boolean } = {}): TeamAcceptRow[] {
    const where =
      opts.includeSuperseded === true ? 'team_slug = ?' : "team_slug = ? AND status = 'active'";
    return this.prep(
      `SELECT ${TEAM_ACCEPT_COLUMNS} FROM scrum_team_accepts WHERE ${where} ORDER BY id ASC`,
    ).all(slug) as TeamAcceptRow[];
  }

  /**
   * A team's expose entries, ordered by id. Active-only by default;
   * `includeSuperseded: true` includes retired entries. Tolerates an unknown
   * slug (returns an empty array).
   */
  listTeamExposes(slug: string, opts: { includeSuperseded?: boolean } = {}): TeamExposeRow[] {
    const where =
      opts.includeSuperseded === true ? 'team_slug = ?' : "team_slug = ? AND status = 'active'";
    return this.prep(
      `SELECT ${TEAM_EXPOSE_COLUMNS} FROM scrum_team_exposes WHERE ${where} ORDER BY id ASC`,
    ).all(slug) as TeamExposeRow[];
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
  fileAsk(input: FileAskInput): AskRow {
    if (this.getTeam(input.fromTeam) === null) {
      throw new Error(`fileAsk: unknown from_team '${input.fromTeam}'`);
    }
    if (this.getTeam(input.toTeam) === null) {
      throw new Error(`fileAsk: unknown to_team '${input.toTeam}'`);
    }
    const accepted = this.listTeamAccepts(input.toTeam).map((a) => a.ask_type);
    if (!accepted.includes(input.askType)) {
      throw new Error(
        `fileAsk: ask_type '${input.askType}' is not accepted by to_team '${input.toTeam}'; accepted: ${accepted.length > 0 ? accepted.join(', ') : '(none)'}`,
      );
    }
    if (this.getTask(input.blockingArtifact) === null) {
      throw new Error(`fileAsk: unknown blocking_artifact '${input.blockingArtifact}'`);
    }

    const createdAt = input.createdAt ?? isoNow();
    const tx = this.db.transaction(() => {
      const result = this.prep(
        'INSERT INTO scrum_asks (from_team, to_team, ask_type, blocking_artifact, state, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(
        input.fromTeam,
        input.toTeam,
        input.askType,
        input.blockingArtifact,
        'filed' satisfies AskState,
        createdAt,
      );
      const id = Number(result.lastInsertRowid);
      // Audit the filing against the blocking artifact's event timeline so the
      // task that triggered the ask carries the cross-team request in its history.
      this.appendEvent({
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
      return id;
    });
    const askId = tx();
    return this.prep(`SELECT ${ASK_COLUMNS} FROM scrum_asks WHERE id = ?`).get(askId) as AskRow;
  }

  /** Fetch one ask by id, or null if missing. */
  getAsk(id: number): AskRow | null {
    const row = this.prep(`SELECT ${ASK_COLUMNS} FROM scrum_asks WHERE id = ?`).get(
      id,
    ) as AskRow | null;
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
  respondAsk(input: RespondAskInput): AskRow {
    if (!(ASK_VERDICTS as string[]).includes(input.verdict)) {
      throw new Error(
        `respondAsk: invalid verdict '${input.verdict}'; expected one of: ${ASK_VERDICTS.join(', ')}`,
      );
    }
    const existing = this.getAsk(input.id);
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

    const apply = this.db.transaction((): AskRow => {
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
            : `ask-${existing.id}-${childLayer}-${randomUUID().slice(0, 8)}`;
        const childTitle =
          input.childTitle !== undefined && input.childTitle.length > 0
            ? input.childTitle
            : `${existing.to_team}: ${existing.ask_type} (ask ${existing.id})`;
        this.createTask({
          id: childId,
          title: childTitle,
          layer: childLayer,
          tags: [existing.to_team],
          createdByAgent: input.respondedBy ?? null,
          createdAt: respondedAt,
        });
        // The from-team's blocking artifact is blocked_by the new child: it
        // stays blocked until the child completes.
        this.addDep(existing.blocking_artifact, childId, 'blocked_by');
        mappedArtifact = childId;
      } else if (verdict === 'reject') {
        rejectedReason = comment;
      } else {
        counterProposal = comment;
      }

      this.prep(
        'UPDATE scrum_asks SET state = ?, mapped_artifact = ?, rejected_reason = ?, counter_proposal = ? WHERE id = ?',
      ).run(nextState, mappedArtifact, rejectedReason, counterProposal, existing.id);

      // Audit the response against the blocking artifact's event timeline, the
      // same timeline `fileAsk` recorded `ask_filed` on.
      this.appendEvent({
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

      return this.prep(`SELECT ${ASK_COLUMNS} FROM scrum_asks WHERE id = ?`).get(
        existing.id,
      ) as AskRow;
    });
    return apply();
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
  awaitAsk(id: number): AskAwaitReport {
    const ask = this.getAsk(id);
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
    const child = ask.mapped_artifact !== null ? this.getTask(ask.mapped_artifact) : null;
    const artifactStatus: TaskStatus | null = child?.status ?? null;
    if (artifactStatus !== 'done') {
      return this.buildAwaitReport(base, 'waiting', { artifactStatus });
    }
    // The child is done — expose the to-team's ACTIVE published outputs.
    return this.buildAwaitReport(base, 'ready', {
      artifactStatus,
      outputs: this.listTeamExposes(ask.to_team),
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
  getManifest(): Manifest {
    const teams: ManifestTeamEntry[] = this.listTeams().map((team) => {
      const iface = this.getTeamInterface(team.slug);
      return { slug: iface.slug, accepts: iface.accepts, exposes: iface.exposes };
    });
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
  teamTerminate(slug: string, reason: string): TeamTerminateResult {
    const existing = this.getTeam(slug);
    if (existing === null) {
      throw new Error(`teamTerminate: unknown team '${slug}'`);
    }
    if (existing.status === 'inactive') {
      throw new Error(`teamTerminate: team '${slug}' is already inactive`);
    }
    const at = isoNow();
    const priorScopes = this.getTeamScopes(slug);
    const scopesCleared = priorScopes.read.length + priorScopes.write.length;
    const activeExposes = this.listTeamExposes(slug);

    const disband = this.db.transaction(() => {
      // 1. Release scope — the seam setTeamScopes left for the disband path.
      this.setTeamScopes(slug, { read: [], write: [] });

      // 2. Supersede every active expose with the disband reason, no replacement.
      for (const expose of activeExposes) {
        this.supersedeTeamExpose(expose.id, reason, null);
      }

      // 3. Vacate every open roster slot — close to_ts without a successor.
      const vacated = this.prep(
        'UPDATE scrum_team_members SET to_ts = ? WHERE team_slug = ? AND to_ts IS NULL',
      ).run(at, slug);

      // 4. Flip status to the terminal inactive state.
      this.prep('UPDATE scrum_teams SET status = ? WHERE slug = ?').run(
        'inactive' satisfies TeamStatus,
        slug,
      );

      // Promote the disbanding team's Lore into the Codex as gated DRAFTS — a
      // disbanding team's durable, generally-applicable learnings are lifted into
      // shared long-term memory before the team goes inactive. Each promotion is
      // a PROPOSAL (a draft awaiting a separate approve gate), never an
      // auto-acceptance. `promoteLoreToCodex` uses a deterministic decision id
      // per Lore, so a re-promotion upserts rather than duplicates — but the
      // disband itself never re-runs (an already-inactive team throws above), so
      // double-promotion cannot happen on this path. The promotion's inner
      // transaction nests as a SAVEPOINT inside this disband transaction.
      for (const lore of this.listLores(slug)) {
        this.promoteLoreToCodex({ loreId: lore.id });
      }

      // SEAM: cascade-cancel this team's in-flight epics once a task<->team
      // ownership link exists. A disband should terminate the team's still-open
      // work, but tasks carry no team-ownership column, so there is no edge to
      // follow from a team to the epics it owns; this cascade is intentionally
      // omitted until that link is added.

      return Number(vacated.changes);
    });
    const rosterVacated = disband();

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
  terminateTeamsForMilestone(milestoneId: string, reason: string): TeamTerminateResult[] {
    const matches = this.listTeams().filter(
      (team) => team.status === 'active' && team.terminates_on_milestone === milestoneId,
    );
    return matches.map((team) => this.teamTerminate(team.slug, reason));
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
  recordLore(input: RecordLoreInput): RecordLoreResult {
    if (this.getTeam(input.teamSlug) === null) {
      throw new Error(`recordLore: unknown team '${input.teamSlug}'`);
    }

    // The current tech_lead is the open (to_ts IS NULL) holder of that role
    // slot — null when the slot has never been filled or is currently vacant.
    const techLead = this.getTeamRoster(input.teamSlug).current.tech_lead;
    let warning: string | null = null;
    if (techLead === null) {
      warning = `team '${input.teamSlug}' has no current tech_lead; recording Lore by ${input.authorContributorId} without an authorship check`;
    } else if (techLead.contributor_id !== input.authorContributorId) {
      throw new Error(
        `recordLore: '${input.authorContributorId}' is not the current tech_lead of team '${input.teamSlug}'; only ${techLead.contributor_id} may author Lore`,
      );
    }

    const result = this.prep(
      'INSERT INTO scrum_lores (team_slug, body, author_contributor_id, created_at) VALUES (?, ?, ?, ?)',
    ).run(input.teamSlug, input.body, input.authorContributorId, input.createdAt ?? isoNow());
    const row = this.prep(`SELECT ${LORE_COLUMNS} FROM scrum_lores WHERE id = ?`).get(
      Number(result.lastInsertRowid),
    ) as LoreRow;
    return { row, warning };
  }

  /**
   * A team's Lore entries, oldest-first (the order they were recorded). The
   * read surface promotion and milestone-close compaction consume to lift a
   * team's wisdom into shared long-term memory. Tolerates an unknown slug:
   * returns an empty array (the absence reads as "no Lore" rather than an error,
   * matching `getTeamScopes`).
   */
  listLores(teamSlug: string): LoreRow[] {
    return this.prep(
      `SELECT ${LORE_COLUMNS} FROM scrum_lores WHERE team_slug = ? ORDER BY id ASC`,
    ).all(teamSlug) as LoreRow[];
  }

  /** Fetch a single Lore entry by id, or null when no such entry exists. */
  getLore(id: number): LoreRow | null {
    const row = this.prep(`SELECT ${LORE_COLUMNS} FROM scrum_lores WHERE id = ?`).get(
      id,
    ) as LoreRow | null;
    return row ?? null;
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
  promoteLoreToCodex(input: PromoteLoreToCodexInput): DecisionRow {
    const lore = this.getLore(input.loreId);
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

    const promote = this.db.transaction(() => {
      // Record THROUGH the gate: a gated kind lands as a DRAFT, not accepted.
      this.recordDecision({
        id: decisionId,
        title,
        content,
        kind,
        recordedByAgent: input.recordedByAgent ?? null,
      });
      // Stamp provenance back at the source Lore. A separate UPDATE (rather than
      // a recordDecision arg) keeps the draft/gate semantics of recordDecision
      // untouched — provenance is orthogonal to the write-gate state.
      this.prep('UPDATE scrum_decisions SET source_lore_id = ? WHERE id = ?').run(
        lore.id,
        decisionId,
      );
      return this.requireDecision(decisionId, 'promoteLoreToCodex');
    });
    return promote();
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
  addAnnotation(input: AddAnnotationInput): AnnotationRow {
    if (!(ANNOTATION_TARGET_KINDS as string[]).includes(input.targetKind)) {
      throw new Error(
        `addAnnotation: invalid target_kind '${input.targetKind}'; expected one of: ${ANNOTATION_TARGET_KINDS.join(', ')}`,
      );
    }
    const result = this.prep(
      'INSERT INTO scrum_annotations (target_kind, target_ref, body, author, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(input.targetKind, input.targetRef, input.body, input.author, input.createdAt ?? isoNow());
    return this.prep(`SELECT ${ANNOTATION_COLUMNS} FROM scrum_annotations WHERE id = ?`).get(
      Number(result.lastInsertRowid),
    ) as AnnotationRow;
  }

  /**
   * A target's Annotations, oldest-first (the order they were recorded). The
   * read surface anyone consults to see the notes attached to a task, team, or
   * decision. Tolerates a target with no notes: returns an empty array (the
   * absence reads as "no annotations" rather than an error, matching
   * `listLores`).
   */
  listAnnotations(targetKind: AnnotationTargetKind, targetRef: string): AnnotationRow[] {
    return this.prep(
      `SELECT ${ANNOTATION_COLUMNS} FROM scrum_annotations WHERE target_kind = ? AND target_ref = ? ORDER BY id ASC`,
    ).all(targetKind, targetRef) as AnnotationRow[];
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
  raiseEscalation(input: RaiseEscalationInput): EscalationRow {
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
    return this.insertEscalation({
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
  getEscalation(id: number): EscalationRow | null {
    const row = this.prep(`SELECT ${ESCALATION_COLUMNS} FROM scrum_escalations WHERE id = ?`).get(
      id,
    ) as EscalationRowRaw | null;
    return row ? decodeEscalation(row) : null;
  }

  /**
   * A task's escalations, oldest-first (raise order). The read surface a driver
   * consults to see the full escalation history — every rung, open and closed —
   * for a task. Tolerates a task with no escalations: returns an empty array.
   */
  listEscalationsForTask(taskId: string): EscalationRow[] {
    return (
      this.prep(
        `SELECT ${ESCALATION_COLUMNS} FROM scrum_escalations WHERE task_id = ? ORDER BY id ASC`,
      ).all(taskId) as EscalationRowRaw[]
    ).map(decodeEscalation);
  }

  /**
   * Every currently-`open` escalation across all tasks, oldest-first — the
   * driver's worklist of escalations awaiting a receiver's resolution.
   */
  listOpenEscalationRows(): EscalationRow[] {
    return (
      this.prep(
        `SELECT ${ESCALATION_COLUMNS} FROM scrum_escalations WHERE state = 'open' ORDER BY id ASC`,
      ).all() as EscalationRowRaw[]
    ).map(decodeEscalation);
  }

  /**
   * Reconstruct the full walk-up chain a single escalation climbed, bottom rung
   * first. Follows `walked_up_from` from any row in the chain back to the root
   * (`null`), then returns the rows root-first. The list reads as the escalation's
   * journey up the ladder: each entry is one rung, with its closing state and
   * resolution. A visited-set guards against an accidental self-link cycle.
   */
  getEscalationChain(id: number): EscalationRow[] {
    // Walk DOWN to the root via walked_up_from, collecting the rung at each hop.
    const chainDown: EscalationRow[] = [];
    const visited = new Set<number>();
    let cursor: number | null = id;
    while (cursor !== null && !visited.has(cursor)) {
      visited.add(cursor);
      const row = this.getEscalation(cursor);
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
  resolveEscalation(input: ResolveEscalationInput): ResolveEscalationResult {
    if (!(ESCALATION_RESOLUTION_MODES as string[]).includes(input.mode)) {
      throw new Error(
        `resolveEscalation: invalid mode '${input.mode}'; expected one of: ${ESCALATION_RESOLUTION_MODES.join(', ')}`,
      );
    }
    const existing = this.getEscalation(input.id);
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

    const apply = this.db.transaction((): ResolveEscalationResult => {
      // `resolve` and `re_decompose` both DISCHARGE the row → `resolved`; only the
      // result flag differs. `re_escalate` closes it → `re_escalated`.
      const closedState: EscalationState = mode === 're_escalate' ? 're_escalated' : 'resolved';
      this.closeEscalationRow(existing.id, closedState, mode, note, resolvedBy, resolvedAt);

      let walkedUpTo: EscalationRow | null = null;
      if (mode === 're_escalate' && nextLayer !== null) {
        walkedUpTo = this.insertEscalation({
          taskId: existing.task_id,
          escalationType: existing.escalation_type,
          layer: nextLayer,
          summary: existing.summary,
          raisedBy: resolvedBy,
          walkedUpFrom: existing.id,
          createdAt: resolvedAt,
        });
      }

      const row = this.requireEscalation(existing.id, 'resolveEscalation');
      return { row, walkedUpTo, reDecomposeTriggered: mode === 're_decompose' };
    });
    return apply();
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
  autoBubbleEscalation(id: number, bubbledAt?: string): EscalationRow {
    const existing = this.getEscalation(id);
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
    const bubble = this.db.transaction((): EscalationRow => {
      this.closeEscalationRow(existing.id, 'auto_bubbled', null, null, null, ts);
      const bubbled = this.insertEscalation({
        taskId: existing.task_id,
        escalationType: existing.escalation_type,
        layer: nextLayer,
        summary: existing.summary,
        raisedBy: null,
        walkedUpFrom: existing.id,
        createdAt: ts,
      });
      // Stamp the closed row with the marker + forward pointer to the new rung.
      this.setEscalationAttributes(existing.id, {
        auto_bubbled: true,
        linked_escalation: bubbled.id,
      });
      this.surfaceEscalationEvent(bubbled, ts);
      return bubbled;
    });
    return bubble();
  }

  /**
   * Write the JSON `attributes` marker onto one escalation row. NULL clears it.
   * The single low-level attributes writer — used by the staleness auto-bubble
   * to stamp `{ auto_bubbled, linked_escalation }` on the closed row.
   */
  private setEscalationAttributes(id: number, attributes: EscalationAttributes | null): void {
    this.prep('UPDATE scrum_escalations SET attributes = ? WHERE id = ?').run(
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
  private surfaceEscalationEvent(row: EscalationRow, ts: string): void {
    if (!this.getTask(row.task_id)) return;
    const payload: EscalationPayload = {
      escalation_type: row.escalation_type,
      summary: row.summary,
    };
    this.appendEvent({ taskId: row.task_id, kind: 'blocker_raised', payload, ts });
  }

  /**
   * Insert one `open` escalation row and return it. The single low-level writer
   * shared by `raiseEscalation` (root row) and the walk-up paths
   * (`resolveEscalation` / `autoBubbleEscalation`, which pass `walkedUpFrom`).
   * Closed-enum guarding is the caller's job — this writes what it is given.
   */
  private insertEscalation(args: {
    taskId: string;
    escalationType: EscalationType;
    layer: EscalationLayer;
    summary: string;
    raisedBy: string | null;
    walkedUpFrom: number | null;
    createdAt: string;
  }): EscalationRow {
    const result = this.prep(
      `INSERT INTO scrum_escalations
         (task_id, escalation_type, layer, state, summary, raised_by, walked_up_from, created_at)
       VALUES (?, ?, ?, 'open', ?, ?, ?, ?)`,
    ).run(
      args.taskId,
      args.escalationType,
      args.layer,
      args.summary,
      args.raisedBy,
      args.walkedUpFrom,
      args.createdAt,
    );
    return this.requireEscalation(Number(result.lastInsertRowid), 'insertEscalation');
  }

  /**
   * Flip an escalation row out of `open` into a terminal state, stamping the
   * resolution provenance. The single low-level closer shared by every walk-up
   * and resolution path.
   */
  private closeEscalationRow(
    id: number,
    state: EscalationState,
    mode: EscalationResolutionMode | null,
    note: string | null,
    resolvedBy: string | null,
    resolvedAt: string,
  ): void {
    this.prep(
      `UPDATE scrum_escalations
         SET state = ?, resolution_mode = ?, resolution_note = ?, resolved_by = ?, resolved_at = ?
       WHERE id = ?`,
    ).run(state, mode, note, resolvedBy, resolvedAt, id);
  }

  /** Fetch an escalation by id or throw — the post-write read-back guard. */
  private requireEscalation(id: number, ctx: string): EscalationRow {
    const row = this.getEscalation(id);
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
  private computeUnblockDepth(taskId: string, cache?: Map<string, number>): number {
    const cached = cache?.get(taskId);
    if (cached !== undefined) return cached;

    const visited = new Set<string>([taskId]);
    const stack = [taskId];
    let count = 0;
    const stmt = this.prep(
      "SELECT to_task_id FROM scrum_deps WHERE from_task_id = ? AND kind = 'blocks'",
    );
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined) break;
      const children = stmt.all(current) as Array<{ to_task_id: string }>;
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
  private fetchTagBoosts(taskIds: string[]): Map<string, number> {
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
    const rows = this.prep(sql).all(...taskIds) as Array<{ task_id: string; boost: number }>;

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
  private fetchLatestEscalations(
    taskIds: string[],
  ): Map<string, { type: EscalationType; ts: string }> {
    const out = new Map<string, { type: EscalationType; ts: string }>();
    if (taskIds.length === 0) return out;
    const placeholders = taskIds.map(() => '?').join(', ');
    const rows = this.prep(
      `SELECT task_id, ts, payload_json FROM scrum_events WHERE kind = 'blocker_raised' AND task_id IN (${placeholders}) ORDER BY ts ASC, id ASC`,
    ).all(...taskIds) as Array<{ task_id: string; ts: string; payload_json: string }>;
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
  listOpenEscalations(): Array<{
    task_id: string;
    title: string;
    escalation_type: EscalationType;
    ts: string;
  }> {
    const rows = this.prep(
      `SELECT e.task_id AS task_id, e.ts AS ts, e.payload_json AS payload_json, t.title AS title
       FROM scrum_events e
       INNER JOIN scrum_tasks t ON t.id = e.task_id
       WHERE e.kind = 'blocker_raised' AND t.deleted_at IS NULL
         AND t.status NOT IN ('done', 'cancelled')
       ORDER BY e.ts ASC, e.id ASC`,
    ).all() as Array<{ task_id: string; ts: string; payload_json: string; title: string }>;
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
  listPendingGates(): Array<{
    task_id: string;
    title: string;
    criterion_id: string;
    criterion_text: string;
  }> {
    const tasks = this.listTasks().filter((t) => t.status !== 'done' && t.status !== 'cancelled');
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
   * Lazily-cached prepared statement. Caching by SQL text matches bun's own
   * internal prepared-statement cache semantics and avoids re-parsing on
   * every hot-path call (nextReady walks the graph N times).
   */
  private prep(sql: string): Statement {
    const cached = this.statements.get(sql);
    if (cached) return cached;
    const stmt = this.db.prepare(sql);
    this.statements.set(sql, stmt);
    return stmt;
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
 * Decode a raw `scrum_tasks` SELECT row into the public `ScrumTask`. The two
 * transforms are `acceptance_json` (TEXT|NULL) → `acceptance` and `bounds_json`
 * (TEXT|NULL) → `bounds`; every other column passes through unchanged. NULL
 * JSON → `null`.
 *
 * The JSON columns have no SQL-level guarantee of valid JSON (`validateBounds`/
 * `validateAcceptance` only run on writes through the store API). `decodeTask`
 * is on the hot read path of getTask/listTasks/getChildren/listTasksForTag/
 * nextReady, so a single corrupt row must NOT throw and brick every task read.
 * `safeParseJson` degrades a poisoned column to `null` (with a stderr warning)
 * instead — the task still reads, just without its acceptance/bounds.
 */
function decodeTask(row: ScrumTaskRow): ScrumTask {
  const { acceptance_json, bounds_json, ...rest } = row;
  return {
    ...rest,
    acceptance: safeParseJson<Acceptance>(acceptance_json, row.id, 'acceptance_json'),
    bounds: safeParseJson<TaskBounds>(bounds_json, row.id, 'bounds_json'),
    provenance: taskProvenance(row),
  };
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
  escalationId: number,
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
 * Whether a criterion counts as satisfied from the story-CLOSE-floor vantage —
 * the read the floor uses to decide `→ done`. The floor has no git and no
 * run/plan context, so it splits by cost:
 *   - `gate` is decided directly via the persisted human verdict
 *     (`criterionSatisfied`).
 *   - `assert`/`bash`/`agent` are decided upstream at the orchestrator
 *     validation gate, which RECORDS the outcome onto the criterion's
 *     `verification`; the floor reads `verification.verdict === 'verified'`.
 *     An absent or non-`verified` record (`pending`/`failed`) is NOT satisfied —
 *     a never-run heavy criterion blocks the close until the gate records it.
 */
export function criterionSatisfiedAtFloor(criterion: AcceptanceCriterion): boolean {
  if (criterion.verifies_by === 'gate') return criterionSatisfied(criterion);
  return criterion.verification?.verdict === 'verified';
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
 * review > ready > backlog. `done` requires a non-empty non-cancelled quorum
 * where every non-cancelled child is done, so an all-cancelled subtree rolls
 * up to backlog rather than done. Invariant: callers only invoke this for a
 * parent with ≥1 live child.
 */
function foldChildStatuses(childStatuses: TaskStatus[]): TaskStatus {
  const anyOf = (s: TaskStatus): boolean => childStatuses.includes(s);
  if (anyOf('in_progress')) return 'in_progress';
  if (anyOf('blocked')) return 'blocked';

  const nonCancelled = childStatuses.filter((s) => s !== 'cancelled');
  if (nonCancelled.length > 0 && nonCancelled.every((s) => s === 'done')) return 'done';

  if (anyOf('review')) return 'review';
  if (anyOf('ready')) return 'ready';
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
  id: number;
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
