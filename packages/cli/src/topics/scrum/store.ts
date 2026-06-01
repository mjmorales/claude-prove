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
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join } from 'node:path';
import { type Store, type StoreOptions, openStore, runMigrations } from '@claude-prove/store';
import { listEntries } from '../acb/reasoning-log-store';
import { ensureScrumSchemaRegistered } from './schemas';
import type {
  Acceptance,
  AcceptanceCriterion,
  DecisionRow,
  DepKind,
  EscalationPayload,
  EscalationType,
  EventKind,
  MilestoneStatus,
  NextReadyRow,
  ScrumContextBundle,
  ScrumDep,
  ScrumEvent,
  ScrumMilestone,
  ScrumRunLink,
  ScrumTag,
  ScrumTask,
  TaskBounds,
  TaskLayer,
  TaskStatus,
} from './types';
import { ESCALATION_TYPES } from './types';

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
 * per ADR convention.
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

// ---------------------------------------------------------------------------
// Allowed status transitions — rejected at runtime by updateTaskStatus
// ---------------------------------------------------------------------------

/**
 * Allowed forward transitions. Terminal statuses (`done`, `cancelled`)
 * reject every outgoing edge. Keep in sync with the task lifecycle doc in
 * `.prove/decisions/2026-04-21-scrum-architecture.md` § Lifecycle.
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
 * and v6 `bounds_json` columns stay in lockstep with the `ScrumTaskRow`
 * shape. Raw rows carry `acceptance_json`/`bounds_json: string | null`;
 * `decodeTask` turns them into the decoded `ScrumTask.acceptance`/`.bounds`
 * fields at the public boundary.
 */
const TASK_COLUMNS =
  'id, title, description, status, milestone_id, parent_id, layer, acceptance_json, bounds_json, terminal_reason, terminal_detail, created_by_agent, created_at, last_event_at, last_modified_by, last_modified_at, deleted_at';

/**
 * Raw `scrum_tasks` SELECT shape — identical to `ScrumTask` except the v5
 * acceptance and v6 bounds columns arrive as their on-disk JSON strings.
 * `decodeTask` is the sole bridge from this to the public `ScrumTask`.
 */
type ScrumTaskRow = Omit<ScrumTask, 'acceptance' | 'bounds'> & {
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
    if (acceptance !== null) validateAcceptance(acceptance);

    // Declared bounds (v6): explicit input only — never inherited. Validated
    // for the closed-top-level-key shape before insert; null = unbounded.
    const bounds = input.bounds ?? null;
    if (bounds !== null) validateBounds(bounds);

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
      deleted_at: null,
    };

    const tx = this.db.transaction(() => {
      this.prep(
        'INSERT INTO scrum_tasks (id, title, description, status, milestone_id, parent_id, layer, acceptance_json, bounds_json, created_by_agent, created_at, last_event_at, last_modified_by, last_modified_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)',
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

    // Story-layer transition floors (onleash §9.1, §10.4/§3.3). Both are
    // mechanical engine-owned gates: a `layer=story` task carries obligations
    // a flat `layer=task` does not. Non-story layers pass straight through.
    if (task.layer === 'story') {
      this.assertStoryAcceptanceFloor(task, next);
      if (next === 'done') this.assertStorySynthesisFloor(task);
    }

    const ts = isoNow();
    const tx = this.db.transaction(() => {
      this.prep(
        'UPDATE scrum_tasks SET status = ?, last_event_at = ?, last_modified_by = ?, last_modified_at = ? WHERE id = ?',
      ).run(next, ts, agent ?? null, ts, id);
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
    const tx = this.db.transaction(() => {
      this.prep(
        'UPDATE scrum_tasks SET milestone_id = ?, last_event_at = ?, last_modified_by = ?, last_modified_at = ? WHERE id = ?',
      ).run(nextMilestoneId, ts, agent ?? null, ts, id);
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
   * append-only audit log records the retirement (design-principles §4) —
   * matching createTask/updateTaskStatus/updateTaskMilestone, which all emit
   * an event under their write. Without this the events table — the sole
   * audit + reconcile signal — would have no trace of when a task was retired.
   */
  softDeleteTask(id: string): void {
    const task = this.getTask(id);
    if (!task) throw new Error(`softDeleteTask: unknown task '${id}'`);

    const ts = isoNow();
    const tx = this.db.transaction(() => {
      this.prep(
        'UPDATE scrum_tasks SET deleted_at = ?, last_modified_by = NULL, last_modified_at = ? WHERE id = ?',
      ).run(ts, ts, id);
      this.prep(
        'INSERT INTO scrum_events (task_id, ts, kind, agent, payload_json) VALUES (?, ?, ?, ?, ?)',
      ).run(id, ts, 'task_deleted', null, JSON.stringify({ status: task.status }));
    });
    tx();
  }

  // ==========================================================================
  // Cancellation + terminal provenance (v7, onleash §14.4–14.6)
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
   * `parent_id` subtree, in one transaction (onleash §14.4–14.6). The root
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
    this.prep(
      'UPDATE scrum_tasks SET status = ?, terminal_reason = ?, terminal_detail = ?, last_event_at = ?, last_modified_by = ?, last_modified_at = ? WHERE id = ?',
    ).run('cancelled', reason, detail, ts, agent, ts, id);
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
  // Story-layer transition floors (v7, onleash §9.1 + §10.4/§3.3)
  // ==========================================================================

  /**
   * Reject a `layer=story` transition INTO `ready`/`in_progress`/`done` when
   * the story has zero ACTIVE acceptance criteria (onleash §9.1). A story with
   * no goalposts cannot be started or closed; superseded criteria do not count.
   * Other target statuses (`blocked`, `review`, `cancelled`, `backlog`) pass —
   * a story may be parked or abandoned without criteria. Invariant: only
   * called for `task.layer === 'story'`.
   */
  private assertStoryAcceptanceFloor(task: ScrumTask, next: TaskStatus): void {
    if (next !== 'ready' && next !== 'in_progress' && next !== 'done') return;
    const active = task.acceptance?.criteria.filter((c) => c.status === 'active') ?? [];
    if (active.length === 0) {
      throw new Error(
        `updateTaskStatus: story '${task.id}' has no active acceptance criteria; add at least one (\`scrum task acceptance add ${task.id} ...\`) before '${next}'`,
      );
    }
  }

  /**
   * Reject a `layer=story` -> `done` transition when the story's most-recent
   * linked run carries no `synthesis` reasoning-log entry (onleash §10.4/§3.3).
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
   * Status of `taskId` rolled up from its subtree (audit §3.4). Computed,
   * never stored. A leaf (no live children) returns its authored status, so
   * pre-v3 flat tasks behave exactly as before. A parent folds its children's
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
  // Acceptance criteria (v5, audit §5.2) — append-only, never hard-delete
  //
  // TODO(story-close): the story-close workflow consumes these criteria and
  // dispatches by `verifies_by` (bash→validators, assert→expression,
  // gate→AskUserQuestion, agent→validation-agent). This module lands the
  // data model + authoring surface only; no evaluation happens here.
  // ==========================================================================

  /**
   * Replace a task's entire acceptance object. Validates the
   * idempotent/policy invariant (audit §5.2): `parallel` eval_order or
   * `failed_only` rerun_policy require every criterion to be
   * `idempotent: true`. Throws on an unknown task id. Pass `null` to clear.
   */
  setAcceptance(taskId: string, acceptance: Acceptance | null): ScrumTask {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`setAcceptance: unknown task '${taskId}'`);
    if (acceptance !== null) validateAcceptance(acceptance);
    this.writeAcceptance(taskId, acceptance);
    return this.requireTask(taskId, 'setAcceptance');
  }

  /**
   * Append one criterion to a task's acceptance list (audit §5.2). Creates
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
    const next: Acceptance = current?.policy ? { criteria, policy: current.policy } : { criteria };
    validateAcceptance(next);
    this.writeAcceptance(taskId, next);
    return this.requireTask(taskId, 'addCriterion');
  }

  /**
   * Supersede a criterion in place (audit §5.2 / §5.3, append-only). Flips
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
   * The criteria a child should inherit from `parentId` via shared_acceptance
   * (audit §5.2). Returns independent deep copies of the parent's ACTIVE
   * criteria, each tagged `inherited_from: parentId` and reset to
   * `status: 'active'` with cleared supersession pointers. Returns `[]` when
   * the parent is unknown or carries no active criteria.
   *
   * Copies are intentionally independent: a later edit to the parent's
   * criterion does NOT retroactively change a child that already inherited it.
   */
  inheritAcceptance(parentId: string): AcceptanceCriterion[] {
    const parent = this.getTask(parentId);
    if (!parent?.acceptance) return [];
    return parent.acceptance.criteria
      .filter((c) => c.status === 'active')
      .map((c) => ({
        ...c,
        status: 'active' as const,
        superseded_by: null,
        reason: null,
        inherited_from: parentId,
      }));
  }

  /**
   * Persist an acceptance object (or NULL) to `scrum_tasks.acceptance_json`.
   * Bumps last-touch provenance (v9): `last_modified_at = now()`,
   * `last_modified_by = NULL` — these editors carry no agent, so the pair
   * honestly records an unattributed most-recent write.
   */
  private writeAcceptance(taskId: string, acceptance: Acceptance | null): void {
    this.prep(
      'UPDATE scrum_tasks SET acceptance_json = ?, last_modified_by = NULL, last_modified_at = ? WHERE id = ?',
    ).run(acceptance === null ? null : JSON.stringify(acceptance), isoNow(), taskId);
  }

  /** Re-fetch a task that must exist after a same-method write. */
  private requireTask(taskId: string, method: string): ScrumTask {
    const updated = this.getTask(taskId);
    if (!updated) throw new Error(`${method}: task '${taskId}' vanished mid-update`);
    return updated;
  }

  // ==========================================================================
  // Declared bounds (v6, declared-bounds decision §2)
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
    // Bump last-touch provenance (v9); no agent flows here, so by = NULL.
    this.prep(
      'UPDATE scrum_tasks SET bounds_json = ?, last_modified_by = NULL, last_modified_at = ? WHERE id = ?',
    ).run(bounds === null ? null : JSON.stringify(bounds), isoNow(), taskId);
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
      created_at: input.createdAt ?? isoNow(),
      closed_at: null,
    };
    this.prep(
      'INSERT INTO scrum_milestones (id, title, description, target_state, status, created_at, closed_at) VALUES (?, ?, ?, ?, ?, ?, NULL)',
    ).run(row.id, row.title, row.description, row.target_state, row.status, row.created_at);
    return row;
  }

  listMilestones(status?: MilestoneStatus): ScrumMilestone[] {
    if (status === undefined) {
      return this.db
        .prepare(
          'SELECT id, title, description, target_state, status, created_at, closed_at FROM scrum_milestones ORDER BY created_at ASC',
        )
        .all() as ScrumMilestone[];
    }
    return this.db
      .prepare(
        'SELECT id, title, description, target_state, status, created_at, closed_at FROM scrum_milestones WHERE status = ? ORDER BY created_at ASC',
      )
      .all(status) as ScrumMilestone[];
  }

  getMilestone(id: string): ScrumMilestone | null {
    const row = this.prep(
      'SELECT id, title, description, target_state, status, created_at, closed_at FROM scrum_milestones WHERE id = ?',
    ).get(id) as ScrumMilestone | null;
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

  /** Set status = 'closed' and stamp `closed_at = now()`. Throws on unknown id. */
  closeMilestone(id: string): ScrumMilestone {
    const existing = this.getMilestone(id);
    if (!existing) throw new Error(`closeMilestone: unknown milestone '${id}'`);
    const closedAt = isoNow();
    this.prep('UPDATE scrum_milestones SET status = ?, closed_at = ? WHERE id = ?').run(
      'closed',
      closedAt,
      id,
    );
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
        `SELECT t.id, t.title, t.description, t.status, t.milestone_id, t.parent_id, t.layer, t.acceptance_json, t.bounds_json, t.terminal_reason, t.terminal_detail, t.created_by_agent, t.created_at, t.last_event_at, t.last_modified_by, t.last_modified_at, t.deleted_at
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
    // A `blocker_raised` event carries a typed escalation payload (onleash
    // §11.2). Validate it at the boundary so a malformed escalation surfaces a
    // domain error here rather than a silently-untyped row that nextReady/alerts
    // later fail to rank. Other event kinds carry free-form payloads.
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

    // Batch the per-candidate latest-escalation lookup (audit §6.1). A task
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
    const row: DecisionRow = {
      id: input.id,
      title: input.title,
      topic: input.topic ?? null,
      status: incomingStatus,
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
      kind: input.kind ?? null,
    };

    // All binds are named ($-prefixed) so the supersession-preserve flag
    // ($assertsStatus) and every column value survive a future reorder of the
    // INSERT column list — no positional `?N` to silently misalign.
    this.prep(
      `INSERT INTO scrum_decisions (id, title, topic, status, content, source_path, content_sha, recorded_at, recorded_by_agent, superseded_by, reason, kind)
       VALUES ($id, $title, $topic, $status, $content, $source_path, $content_sha, $recorded_at, $recorded_by_agent, $superseded_by, $reason, $kind)
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
         -- status ($assertsStatus = 0), keep status/superseded_by/reason
         -- intact; never auto-resurrect. Otherwise adopt the incoming values.
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
   * Supersede a decision (audit §5.3, append-only). Sets the OLD decision's
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
    const row = this.prep(
      'SELECT id, title, topic, status, content, source_path, content_sha, recorded_at, recorded_by_agent, superseded_by, reason, kind FROM scrum_decisions WHERE id = ?',
    ).get(id) as DecisionRow | null;
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
      // ADR body becomes stored as `Accepted`), but operator filters read
      // naturally in lowercase. Comparison is case-insensitive on both sides
      // so `--status accepted` matches rows stored as `Accepted`, `ACCEPTED`,
      // or any other case variant without rewriting existing rows.
      clauses.push('lower(status) = lower(?)');
      params.push(filter.status);
    }
    if (filter.kind !== undefined) {
      // Case-insensitive on both sides, matching topic/status — the curation
      // step may author `ADR`/`adr` interchangeably.
      clauses.push('lower(kind) = lower(?)');
      params.push(filter.kind);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const sql = `SELECT id, title, topic, status, content, source_path, content_sha, recorded_at, recorded_by_agent, superseded_by, reason, kind FROM scrum_decisions ${where} ORDER BY recorded_at DESC`;
    return this.prep(sql).all(...params) as DecisionRow[];
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
   * surface (audit §6.1): a `done`/`cancelled` task's escalation is resolved and
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
 * Acceptance freeze guard (onleash §14.13). While a worker is in-flight on a
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

/** Closed top-level key set for `TaskBounds` (declared-bounds decision §2). */
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
 * Enforce the policy invariant (audit §5.2): a `parallel` eval_order or a
 * `failed_only` rerun_policy is only valid when every criterion is
 * `idempotent: true`. Non-idempotent criteria cannot be safely re-run or
 * run concurrently, so the policy is rejected at write time. No policy (the
 * default sequential / re-run-all behavior) always passes.
 */
function validateAcceptance(acceptance: Acceptance): void {
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
// Structured escalation typing (onleash §11.2, audit §6.1)
// ---------------------------------------------------------------------------

/** Boost cap (days) and per-day weight for the staleness auto-bubble. */
const ESCALATION_BASE_BOOST = 5;
const ESCALATION_AGE_CAP_DAYS = 30;
const ESCALATION_PER_DAY = 0.5;

/**
 * Validate a `blocker_raised` event payload as a typed `EscalationPayload`
 * (onleash §11.2). Requires `escalation_type` in the closed set and a string
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
 * Staleness auto-bubble boost for an open escalation (audit §6.1). Returns 0
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
