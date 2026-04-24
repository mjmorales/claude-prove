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
import { type Store, type StoreOptions, openStore, runMigrations } from '@claude-prove/store';
import { ensureScrumSchemaRegistered } from './schemas';
import type {
  DecisionRow,
  DepKind,
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
  TaskStatus,
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
}

/** Filter shape for `listDecisions`. Both fields are optional and AND-combined. */
export interface ListDecisionsFilter {
  topic?: string;
  status?: string;
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

    if (milestoneId !== null) {
      const exists = this.getMilestone(milestoneId);
      if (!exists) {
        throw new Error(`createTask: unknown milestone_id '${milestoneId}'`);
      }
    }

    const row: ScrumTask = {
      id: input.id,
      title: input.title,
      description: input.description ?? null,
      status,
      milestone_id: milestoneId,
      created_by_agent: input.createdByAgent ?? null,
      created_at: createdAt,
      last_event_at: createdAt,
      deleted_at: null,
    };

    const tx = this.db.transaction(() => {
      this.prep(
        'INSERT INTO scrum_tasks (id, title, description, status, milestone_id, created_by_agent, created_at, last_event_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)',
      ).run(
        row.id,
        row.title,
        row.description,
        row.status,
        row.milestone_id,
        row.created_by_agent,
        row.created_at,
        row.last_event_at,
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
      'SELECT id, title, description, status, milestone_id, created_by_agent, created_at, last_event_at, deleted_at FROM scrum_tasks WHERE id = ? AND deleted_at IS NULL',
    ).get(id) as ScrumTask | null;
    return row ?? null;
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
    const sql = `SELECT id, title, description, status, milestone_id, created_by_agent, created_at, last_event_at, deleted_at FROM scrum_tasks ${where} ORDER BY created_at ASC`;
    return this.prep(sql).all(...params) as ScrumTask[];
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

    const ts = isoNow();
    const tx = this.db.transaction(() => {
      this.prep('UPDATE scrum_tasks SET status = ?, last_event_at = ? WHERE id = ?').run(
        next,
        ts,
        id,
      );
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
      this.prep('UPDATE scrum_tasks SET milestone_id = ?, last_event_at = ? WHERE id = ?').run(
        nextMilestoneId,
        ts,
        id,
      );
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

  /** Soft-delete: stamp `deleted_at = now()`. Does not cascade to dependents. */
  softDeleteTask(id: string): void {
    const task = this.getTask(id);
    if (!task) throw new Error(`softDeleteTask: unknown task '${id}'`);
    this.prep('UPDATE scrum_tasks SET deleted_at = ? WHERE id = ?').run(isoNow(), id);
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
    return this.prep(
      `SELECT t.id, t.title, t.description, t.status, t.milestone_id, t.created_by_agent, t.created_at, t.last_event_at, t.deleted_at
       FROM scrum_tasks t
       INNER JOIN scrum_tags g ON g.task_id = t.id
       WHERE g.tag = ? AND t.deleted_at IS NULL
       ORDER BY t.created_at ASC`,
    ).all(tag) as ScrumTask[];
  }

  // ==========================================================================
  // Dependencies
  // ==========================================================================

  /**
   * Record a dependency. Idempotent on the `(from, to, kind)` PK. Rejects
   * self-edges and unknown task ids (FK pragma catches the latter when
   * enabled, but the explicit check keeps :memory: tests honest).
   */
  addDep(fromTaskId: string, toTaskId: string, kind: DepKind): void {
    if (fromTaskId === toTaskId) {
      throw new Error(`addDep: self-dependency rejected for task '${fromTaskId}'`);
    }
    if (!this.getTask(fromTaskId)) throw new Error(`addDep: unknown from_task '${fromTaskId}'`);
    if (!this.getTask(toTaskId)) throw new Error(`addDep: unknown to_task '${toTaskId}'`);
    this.prep(
      'INSERT OR IGNORE INTO scrum_deps (from_task_id, to_task_id, kind) VALUES (?, ?, ?)',
    ).run(fromTaskId, toTaskId, kind);
  }

  removeDep(fromTaskId: string, toTaskId: string, kind: DepKind): void {
    this.prep('DELETE FROM scrum_deps WHERE from_task_id = ? AND to_task_id = ? AND kind = ?').run(
      fromTaskId,
      toTaskId,
      kind,
    );
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
    const candidates = (
      options.milestoneId
        ? this.prep(
            `SELECT id, title, description, status, milestone_id, created_by_agent, created_at, last_event_at, deleted_at
             FROM scrum_tasks
             WHERE deleted_at IS NULL AND status IN ('ready', 'backlog') AND milestone_id = ?
             ORDER BY created_at ASC`,
          ).all(options.milestoneId)
        : this.prep(
            `SELECT id, title, description, status, milestone_id, created_by_agent, created_at, last_event_at, deleted_at
             FROM scrum_tasks
             WHERE deleted_at IS NULL AND status IN ('ready', 'backlog')
             ORDER BY created_at ASC`,
          ).all()
    ) as ScrumTask[];

    // Snapshot active and closed milestone ids in one pass each — both
    // sets feed `computeMilestoneBoost`. Per-invocation lookup keeps the
    // boost calculation O(1) per task without a per-task DB round trip.
    const activeMilestones = new Set(this.listMilestones('active').map((m) => m.id));
    const closedMilestones = new Set(this.listMilestones('closed').map((m) => m.id));

    // Batch the per-candidate tag lookup into a single IN-query. Bun's sqlite
    // binds parameters positionally, so we expand placeholders to match the
    // candidate count. Per-invocation only — tags mutate between calls.
    const tagBoostByTask = this.fetchTagBoosts(candidates.map((t) => t.id));

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
      const score = unblockDepth * 10 + milestoneBoost * 5 + contextHotness * 3 + tagBoost;
      return {
        task,
        score,
        rationale: {
          unblock_depth: unblockDepth,
          milestone_boost: milestoneBoost,
          context_hotness: contextHotness,
          tag_boost: tagBoost,
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
   * replaced in-place: title/topic/status/content/source_path are
   * overwritten, `content_sha` is recomputed from the new content, and
   * `recorded_at` is bumped to now so list order reflects the latest
   * write. Status defaults to `'accepted'`.
   *
   * `content_sha` uses node:crypto sha256 — same std-lib primitive every
   * other prove domain uses; no new dependency.
   */
  recordDecision(input: RecordDecisionInput): DecisionRow {
    const recordedAt = isoNow();
    const contentSha = createHash('sha256').update(input.content).digest('hex');
    const row: DecisionRow = {
      id: input.id,
      title: input.title,
      topic: input.topic ?? null,
      status: input.status ?? 'accepted',
      content: input.content,
      source_path: input.sourcePath ?? null,
      content_sha: contentSha,
      recorded_at: recordedAt,
      recorded_by_agent: input.recordedByAgent ?? null,
    };

    this.prep(
      `INSERT INTO scrum_decisions (id, title, topic, status, content, source_path, content_sha, recorded_at, recorded_by_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         topic = excluded.topic,
         status = excluded.status,
         content = excluded.content,
         source_path = excluded.source_path,
         content_sha = excluded.content_sha,
         recorded_at = excluded.recorded_at,
         recorded_by_agent = excluded.recorded_by_agent`,
    ).run(
      row.id,
      row.title,
      row.topic,
      row.status,
      row.content,
      row.source_path,
      row.content_sha,
      row.recorded_at,
      row.recorded_by_agent,
    );

    return row;
  }

  /** Fetch one decision by id, or null if missing. */
  getDecision(id: string): DecisionRow | null {
    const row = this.prep(
      'SELECT id, title, topic, status, content, source_path, content_sha, recorded_at, recorded_by_agent FROM scrum_decisions WHERE id = ?',
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
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const sql = `SELECT id, title, topic, status, content, source_path, content_sha, recorded_at, recorded_by_agent FROM scrum_decisions ${where} ORDER BY recorded_at DESC`;
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
