/**
 * Two-writer rebase convergence harness — drives two operators' concurrent and
 * offline writes through the SHIPPED `@tursodatabase/sync` replay mechanism and
 * asserts the multi-operator convergence matrix per write class.
 *
 * ── Test strategy: faithful replay SIMULATION, not the real sync engine ──────
 *
 * The shipped `@tursodatabase/sync` (v0.6.1) cannot sync offline. Its
 * `DatabaseOpts.url` is a `libsql://` HTTP endpoint and `pull()`/`push()` move
 * data over HTTP; the only transport override is `fetch` (a `globalThis.fetch`
 * drop-in). There is no built-in local file-to-file sync target — with no
 * `url`, the database is local-only and `pull()`/`push()` are no-ops. Faking a
 * remote through `fetch` would require reimplementing the entire libsql sync
 * server protocol (page-level transfer, CDC batches, revision e-tags) — the
 * exact engine behaviour under test, so it would prove nothing. We therefore do
 * NOT fake a cloud connection. This harness instead REPRODUCES the shipped
 * replay mechanism deterministically over three real `@tursodatabase/database`
 * connections (a server replica + two operator replicas), driving the ACTUAL
 * scrum store write paths (`ScrumStore` from `./store`) so the assertions track
 * real columns, PKs, UNIQUEs, and FKs — not a toy schema.
 *
 * ── The mechanism this harness models (source-grounded, not assumed) ─────────
 *
 * From the shipped `tursodatabase/turso` sync engine
 * (`database_replay_generator.rs`, `database_tape.rs`,
 * `database_sync_engine.rs`) and the JS bindings:
 *
 *   • push() ships local CDC mutations to the server; the server is the
 *     linearization point and resolves conflicts last-push-wins.
 *   • pull() is ATOMIC: rollback local → apply the remote as physical pages
 *     (local becomes byte-identical to the remote) → replay the local CDC
 *     mutations on top. If replay fails the local DB reverts to its pre-pull
 *     state — nothing half-applies.
 *   • replay rewrites every local INSERT into a PK-keyed UPSERT:
 *       INSERT INTO t(...) VALUES(...) ON CONFLICT(<pk cols>) DO UPDATE SET ...
 *     The ON CONFLICT target is the PRIMARY KEY columns ONLY; secondary UNIQUE
 *     indexes get NO conflict clause.
 *       - PRIMARY-KEY collision → DO UPDATE fires → the local row OVERWRITES the
 *         existing row content (last-push-wins at row granularity; no error).
 *       - SECONDARY-UNIQUE collision → raw `UNIQUE constraint failed` → propagates
 *         out of pull()/push() → the whole op rolls back atomically → sync is
 *         BLOCKED (a hard, surfaced failure — not a silent drop).
 *   • the recovery hook is one-sided `transform(mutation) => {operation:'skip'} |
 *     {operation:'rewrite', stmt} | null`, fired per CDC mutation before push AND
 *     during replay. It receives only the LOCAL mutation, never the remote row.
 *
 * `RebaseSim` below implements exactly this. CDC is captured by snapshotting
 * each replica's tables (keyed by PK) at the last-sync baseline and diffing to
 * the current state — which is what the engine's CDC layer produces. Replay
 * uses real `INSERT ... ON CONFLICT(<pk>) DO UPDATE` against a real connection,
 * so a secondary UNIQUE genuinely throws and the atomic rollback genuinely
 * reverts — the SQLite engine, not the harness, decides the collision outcome.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SqlParam, Store } from '@claude-prove/store';
import { type ScrumStore, foldChildStatuses, openScrumStore } from './store';
import type { TaskStatus } from './types';

// ===========================================================================
// CDC + replay simulation of the shipped @tursodatabase/sync mechanism
// ===========================================================================

/** A single replica: its file-backed store plus the per-table baseline snapshot. */
interface Replica {
  name: string;
  scrum: ScrumStore;
  store: Store;
  /** Snapshot of every synced table at this replica's last sync, keyed PK→row. */
  baseline: Map<string, Map<string, Row>>;
}

type Row = Record<string, SqlParam>;

/** One CDC mutation derived by diffing a replica against its sync baseline. */
interface Mutation {
  table: string;
  changeType: 'insert' | 'update' | 'delete';
  /** Stable PK string for the row (composite PKs joined). */
  pk: string;
  /** Full post-image (insert/update) or null (delete). */
  after: Row | null;
}

/** A one-sided transform hook, exactly the shipped `transform` shape. */
type Transform = (m: Mutation) => { operation: 'skip' } | { operation: 'rewrite'; row: Row } | null;

/**
 * Every scrum table the sync engine carries, with its PRIMARY-KEY columns. The
 * ON CONFLICT replay clause targets these columns ONLY — secondary UNIQUE
 * indexes (e.g. `scrum_contributors.slug`, `scrum_acceptance_criteria
 * UNIQUE(task_id, criterion_id)`) are deliberately absent so a collision on one
 * raises rather than being absorbed by the PK clause (the shipped behaviour).
 */
const SYNCED_TABLES: Record<string, string[]> = {
  scrum_milestones: ['id'],
  scrum_tasks: ['id'],
  scrum_acceptance_criteria: ['id'],
  scrum_criterion_verdicts: ['id'],
  scrum_tags: ['task_id', 'tag'],
  scrum_deps: ['from_task_id', 'to_task_id', 'kind'],
  scrum_events: ['id'],
  scrum_run_links: ['task_id', 'run_path'],
  scrum_decisions: ['id'],
  scrum_contributors: ['id'],
  scrum_operator_history: ['id'],
  scrum_teams: ['slug'],
  scrum_team_scopes: ['team_slug', 'kind', 'glob'],
  scrum_team_members: ['id'],
  scrum_lores: ['id'],
  scrum_annotations: ['id'],
};

/** All non-PK columns of a row, for the DO UPDATE SET clause. */
function nonPkColumns(table: string, row: Row): string[] {
  const pk = new Set(SYNCED_TABLES[table]);
  return Object.keys(row).filter((c) => !pk.has(c));
}

function pkOf(table: string, row: Row): string {
  return (SYNCED_TABLES[table] ?? []).map((c) => String(row[c])).join('\x00');
}

/** Read every row of a table keyed by its PK string. */
async function snapshotTable(store: Store, table: string): Promise<Map<string, Row>> {
  const rows = await store.all<Row>(`SELECT * FROM ${table}`);
  const map = new Map<string, Row>();
  for (const row of rows) map.set(pkOf(table, row), row);
  return map;
}

async function snapshotAll(store: Store): Promise<Map<string, Map<string, Row>>> {
  const all = new Map<string, Map<string, Row>>();
  for (const table of Object.keys(SYNCED_TABLES)) {
    all.set(table, await snapshotTable(store, table));
  }
  return all;
}

/**
 * Wipe every synced table and re-insert the given full state — the page-level
 * copy the shipped pull performs when it "applies the remote as physical
 * pages". A physical-page apply bypasses row-level FK enforcement, so callers
 * run this with `foreign_keys = OFF` (a forward INSERT order would otherwise
 * trip `scrum_tasks.status_event_id`, a forward FK onto `scrum_events`).
 * Deletes referrers-first (reverse declaration order), inserts targets-first
 * (forward order).
 */
async function overwriteState(store: Store, state: Map<string, Map<string, Row>>): Promise<void> {
  for (const table of [...Object.keys(SYNCED_TABLES)].reverse()) {
    await store.run(`DELETE FROM ${table}`);
  }
  for (const table of Object.keys(SYNCED_TABLES)) {
    for (const row of (state.get(table) ?? new Map()).values()) {
      const cols = Object.keys(row);
      await store.run(
        `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
        cols.map((c) => row[c]),
      );
    }
  }
}

/**
 * Run `fn` with the connection's FK enforcement disabled, restoring it after.
 * The engine ignores a `foreign_keys` pragma issued inside a transaction, so the
 * toggle (and the work guarded by it) must run OUTSIDE any sqlite transaction —
 * which is why the page-copy/replay below is hand-rolled atomic (snapshot +
 * manual restore-on-throw) rather than wrapped in `withTx`.
 */
async function withFksOff<T>(store: Store, fn: () => Promise<T>): Promise<T> {
  await store.exec('PRAGMA foreign_keys = OFF');
  try {
    return await fn();
  } finally {
    await store.exec('PRAGMA foreign_keys = ON');
  }
}

function rowsEqual(a: Row, b: Row): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if (a[k] !== b[k]) return false;
  return true;
}

/**
 * Diff a replica's current table state against its sync baseline to derive the
 * CDC mutations accumulated since the last sync — exactly the change set the
 * engine's CDC layer would have captured.
 */
async function captureMutations(replica: Replica): Promise<Mutation[]> {
  const mutations: Mutation[] = [];
  for (const table of Object.keys(SYNCED_TABLES)) {
    const base = replica.baseline.get(table) ?? new Map<string, Row>();
    const now = await snapshotTable(replica.store, table);
    // Deletes first, then inserts/updates — matching the on-disk order of a
    // delete-all-then-reinsert transaction (`writeAcceptance`, team scope-set),
    // so a reinsert of a re-keyed surrogate does not self-collide on a secondary
    // UNIQUE before the old surrogate's delete has replayed.
    for (const [pk] of base) {
      if (!now.has(pk)) mutations.push({ table, changeType: 'delete', pk, after: null });
    }
    for (const [pk, row] of now) {
      const prior = base.get(pk);
      if (prior === undefined) mutations.push({ table, changeType: 'insert', pk, after: row });
      else if (!rowsEqual(prior, row))
        mutations.push({ table, changeType: 'update', pk, after: row });
    }
  }
  return mutations;
}

/**
 * Apply one mutation to a connection as the shipped replay does:
 *   insert/update → INSERT ... ON CONFLICT(<pk cols>) DO UPDATE SET <non-pk>
 *   delete        → DELETE WHERE <pk cols>
 * A secondary-UNIQUE violation on the INSERT raises a real SQLite error (no PK
 * conflict clause covers it), which the caller's transaction turns into an
 * atomic rollback — the shipped sync-blocking outcome.
 */
async function replayMutation(
  store: Store,
  m: Mutation,
  pkColsByTable = SYNCED_TABLES,
): Promise<void> {
  const pkCols = pkColsByTable[m.table] ?? [];
  if (m.changeType === 'delete') {
    const where = pkCols.map((c) => `${c} = ?`).join(' AND ');
    const pkVals = m.pk.split('\x00');
    await store.run(`DELETE FROM ${m.table} WHERE ${where}`, pkVals as SqlParam[]);
    return;
  }
  const row = m.after as Row;
  const cols = Object.keys(row);
  const placeholders = cols.map(() => '?').join(', ');
  const setClause = nonPkColumns(m.table, row)
    .map((c) => `${c} = excluded.${c}`)
    .join(', ');
  const conflict = pkCols.join(', ');
  const doUpdate = setClause.length > 0 ? `DO UPDATE SET ${setClause}` : 'DO NOTHING';
  const sql = `INSERT INTO ${m.table} (${cols.join(', ')}) VALUES (${placeholders}) ON CONFLICT(${conflict}) ${doUpdate}`;
  await store.run(sql, cols.map((c) => row[c]) as SqlParam[]);
}

/**
 * The shipped multi-writer engine over real connections. `server` is the
 * linearization point; each operator pushes/pulls against it.
 */
class RebaseSim {
  constructor(
    readonly server: Replica,
    readonly operators: Replica[],
  ) {}

  /** Mark a replica's baseline = its current state (post-sync settle point). */
  async rebaseline(replica: Replica): Promise<void> {
    replica.baseline = await snapshotAll(replica.store);
  }

  /**
   * push(op): ship op's local CDC mutations to the server as PK-keyed UPSERTs in
   * arrival order. The server is authoritative — a push is last-push-wins at row
   * granularity. After a successful push, op's baseline advances to its pushed
   * state (the engine has acknowledged them upstream).
   */
  async push(op: Replica, transform?: Transform): Promise<void> {
    const mutations = await captureMutations(op);
    const prePush = await snapshotAll(this.server.store);
    await withFksOff(this.server.store, async () => {
      try {
        for (const m of mutations) {
          const decision = transform?.(m) ?? null;
          if (decision?.operation === 'skip') continue;
          const effective: Mutation =
            decision?.operation === 'rewrite' ? { ...m, after: decision.row } : m;
          await replayMutation(this.server.store, effective);
        }
      } catch (err) {
        // Atomic revert — a secondary-UNIQUE collision rolls the whole push back.
        await overwriteState(this.server.store, prePush);
        throw err;
      }
    });
    await this.rebaseline(op);
  }

  /**
   * pull(op): the atomic rollback → copy-remote-as-pages → replay-local-on-top.
   * Captures op's un-pushed local mutations FIRST, snapshots the pre-pull state,
   * wipes + copies every server row (byte-identical replica), then replays the
   * local mutations as PK-UPSERTs with `transform` applied. Any throw (a
   * secondary-UNIQUE collision) rolls the whole pull back to the pre-pull state
   * and re-raises — the shipped sync-blocking, never-half-applied contract.
   */
  async pull(op: Replica, transform?: Transform): Promise<void> {
    const localMutations = await captureMutations(op);
    const prePull = await snapshotAll(op.store);
    const serverState = await snapshotAll(this.server.store);
    await withFksOff(op.store, async () => {
      try {
        // Apply the remote as physical pages: wipe local, copy every server row.
        await overwriteState(op.store, serverState);
        // Replay op's own local writes on top, as PK-keyed UPSERTs.
        for (const m of localMutations) {
          const decision = transform?.(m) ?? null;
          if (decision?.operation === 'skip') continue;
          const effective: Mutation =
            decision?.operation === 'rewrite' ? { ...m, after: decision.row } : m;
          await replayMutation(op.store, effective);
        }
      } catch (err) {
        // Atomic revert to the pre-pull state — nothing half-applies.
        await overwriteState(op.store, prePull);
        throw err;
      }
    });
    await this.rebaseline(op);
  }

  /**
   * A full settle: both operators push their local writes (op order = arrival
   * order at the server), then both pull to converge on the server state.
   */
  async settle(transform?: Transform): Promise<void> {
    for (const op of this.operators) await this.push(op);
    for (const op of this.operators) await this.pull(op, transform);
  }
}

// ===========================================================================
// Harness fixture: server + opA + opB, all seeded from a common base
// ===========================================================================

let tmp: string;
let sim: RebaseSim;
let server: Replica;
let opA: Replica;
let opB: Replica;

async function openReplica(name: string, path: string): Promise<Replica> {
  const scrum = await openScrumStore({ path });
  return { name, scrum, store: scrum.getStore(), baseline: new Map() };
}

/** Copy every synced row from `src` to `dst` so the replicas start identical. */
async function cloneInto(dst: Replica, src: Replica): Promise<void> {
  const state = await snapshotAll(src.store);
  await withFksOff(dst.store, async () => {
    await overwriteState(dst.store, state);
  });
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'rebase-sim-'));
  server = await openReplica('server', join(tmp, 'server.db'));
  opA = await openReplica('opA', join(tmp, 'opA.db'));
  opB = await openReplica('opB', join(tmp, 'opB.db'));
  sim = new RebaseSim(server, [opA, opB]);
});

afterEach(() => {
  for (const r of [server, opA, opB]) r?.scrum.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

/**
 * Seed a common base on the server, clone it to both operators, and set every
 * replica's baseline = that shared state, so subsequent operator writes are the
 * only divergence. Returns once all three replicas are byte-identical.
 */
async function seedCommonBase(seed: (s: ScrumStore) => Promise<void>): Promise<void> {
  await seed(server.scrum);
  await cloneInto(opA, server);
  await cloneInto(opB, server);
  for (const r of [server, opA, opB]) await sim.rebaseline(r);
}

/** Read a single task's authored status off a replica. */
async function statusOf(replica: Replica, taskId: string): Promise<TaskStatus | null> {
  const task = await replica.scrum.getTask(taskId);
  return task?.status ?? null;
}

/** Count rows on a replica matching a WHERE clause — divergence detection. */
async function count(replica: Replica, sql: string, ...params: SqlParam[]): Promise<number> {
  const row = await replica.store.get<{ n: number }>(sql, params);
  return Number(row?.n ?? 0);
}

// ===========================================================================
// Class A — append-only / ULID / composite-PK logs: both appends survive
// ===========================================================================

describe('Class A — append-only logs commute by construction', () => {
  test('two offline event appends both survive replay and converge', async () => {
    await seedCommonBase(async (s) => {
      await s.createTask({ id: 't1', title: 'Shared task' });
    });

    // Each operator appends a distinct ULID-keyed event while offline.
    await opA.scrum.appendEvent({ taskId: 't1', kind: 'note', payload: { who: 'A' } });
    await opB.scrum.appendEvent({ taskId: 't1', kind: 'note', payload: { who: 'B' } });

    await sim.settle();

    // Both note events landed on the server and on every operator — neither
    // clobbered the other (distinct ULIDs, both rebased on top).
    const wantNotes = 1 /* task_created */ + 2;
    for (const r of [server, opA, opB]) {
      expect(await count(r, "SELECT COUNT(*) n FROM scrum_events WHERE task_id = 't1'")).toBe(
        wantNotes,
      );
    }
    expect(await count(server, "SELECT COUNT(*) n FROM scrum_events WHERE kind = 'note'")).toBe(2);
  });

  test('two offline annotation appends both survive', async () => {
    await seedCommonBase(async () => {});
    await opA.scrum.addAnnotation({
      targetKind: 'team',
      targetRef: 'engine',
      body: 'finding from A',
      author: 'A',
    });
    await opB.scrum.addAnnotation({
      targetKind: 'team',
      targetRef: 'engine',
      body: 'finding from B',
      author: 'B',
    });

    await sim.settle();

    for (const r of [server, opA, opB]) {
      expect(await count(r, 'SELECT COUNT(*) n FROM scrum_annotations')).toBe(2);
    }
  });

  test('two offline dependency-edge inserts both survive (composite PK)', async () => {
    await seedCommonBase(async (s) => {
      await s.createTask({ id: 'root', title: 'root' });
      await s.createTask({ id: 'a', title: 'a' });
      await s.createTask({ id: 'b', title: 'b' });
    });
    await opA.scrum.addDep('root', 'a', 'blocks');
    await opB.scrum.addDep('root', 'b', 'blocks');

    await sim.settle();

    for (const r of [server, opA, opB]) {
      expect(await count(r, 'SELECT COUNT(*) n FROM scrum_deps')).toBe(2);
    }
  });
});

// ===========================================================================
// Class B — LWW head columns: converge to the server's last push, losing
// intent stays in the event log (surfaceable).
// ===========================================================================

describe('Class B — LWW head columns converge with intent surfaced', () => {
  test('concurrent status writes converge to last-push head; losing intent is in the event log', async () => {
    await seedCommonBase(async (s) => {
      await s.createTask({ id: 't1', title: 't1', status: 'in_progress' });
    });

    // A drives → review; B drives → blocked, both offline. Each appends a
    // status_changed event (Class A, both survive) and sets the LWW status head.
    await opA.scrum.updateTaskStatus('t1', 'review', 'A');
    await opB.scrum.updateTaskStatus('t1', 'blocked', 'B');

    // Push order = arrival order: A first, then B → B is the last push and wins
    // the head.
    await sim.settle();

    for (const r of [server, opA, opB]) {
      expect(await statusOf(r, 't1')).toBe('blocked');
    }

    // The losing intent (A's → review) is NOT lost: its status_changed event
    // survives the rebase, so a post-pull pass can surface the concurrent
    // cross-writer intent.
    const reviewIntents = await count(
      server,
      "SELECT COUNT(*) n FROM scrum_events WHERE task_id = 't1' AND kind = 'status_changed' AND payload_json LIKE '%\"to\":\"review\"%'",
    );
    expect(reviewIntents).toBe(1);
    const blockedIntents = await count(
      server,
      "SELECT COUNT(*) n FROM scrum_events WHERE task_id = 't1' AND kind = 'status_changed' AND payload_json LIKE '%\"to\":\"blocked\"%'",
    );
    expect(blockedIntents).toBe(1);
  });

  test('status ROLLUP converges after settle: parent derives from the converged child heads', async () => {
    await seedCommonBase(async (s) => {
      await s.createMilestone({ id: 'm1', title: 'm1' });
      await s.createTask({ id: 'epic', title: 'epic', layer: 'epic', milestoneId: 'm1' });
      await s.createTask({ id: 'c1', title: 'c1', parentId: 'epic', status: 'in_progress' });
      await s.createTask({ id: 'c2', title: 'c2', parentId: 'epic', status: 'in_progress' });
    });

    // A finishes c1, B finishes c2, both offline.
    await opA.scrum.updateTaskStatus('c1', 'review', 'A');
    await opA.scrum.updateTaskStatus('c1', 'done', 'A');
    await opB.scrum.updateTaskStatus('c2', 'review', 'B');
    await opB.scrum.updateTaskStatus('c2', 'done', 'B');

    await sim.settle();

    // Both child heads converged to done on every replica → the parent's
    // derived rollup converges to done on every replica.
    for (const r of [server, opA, opB]) {
      expect(await statusOf(r, 'c1')).toBe('done');
      expect(await statusOf(r, 'c2')).toBe('done');
      expect(await r.scrum.derivedStatus('epic')).toBe('done');
    }
    // The rollup is a pure fold over the converged child statuses — identical
    // input on every replica, identical output.
    expect(foldChildStatuses(['done', 'done'])).toBe('done');
  });

  test('concurrent milestone_id writes converge to last-push value', async () => {
    await seedCommonBase(async (s) => {
      await s.createMilestone({ id: 'mA', title: 'mA' });
      await s.createMilestone({ id: 'mB', title: 'mB' });
      await s.createTask({ id: 't1', title: 't1' });
    });
    await opA.scrum.updateTaskMilestone('t1', 'mA', 'A');
    await opB.scrum.updateTaskMilestone('t1', 'mB', 'B');

    await sim.settle();

    for (const r of [server, opA, opB]) {
      const task = await r.scrum.getTask('t1');
      expect(task?.milestone_id).toBe('mB');
    }
  });
});

// ===========================================================================
// Class C① — single-open-interval roles converge STRUCTURALLY under concurrent
// transfers (operator-of-record / team role slot). The current-holder read is a
// max(from_ts) fold over the append-only OPEN intervals (tie-break max(id)), so
// two concurrent offline transfers leave two open rows on the merged state BUT
// every replica deterministically folds them to ONE holder — the dual-open
// hazard is eliminated by construction, with no repair pass.
// ===========================================================================

describe('Class C① — concurrent open-interval transfers converge to one holder via the max-fold', () => {
  test('two concurrent operator-of-record transfers converge: currentOperator folds both opens to the latest holder', async () => {
    await seedCommonBase(async (s) => {
      await s.registerContributor({ slug: 'alice', id: 'ct-alice' });
      await s.registerContributor({ slug: 'bob', id: 'ct-bob' });
      await s.registerContributor({ slug: 'carol', id: 'ct-carol' });
      // Alice holds the role at the base state.
      await s.setOperatorOfRecord({
        contributorId: 'ct-alice',
        fromTs: '2026-01-01T00:00:00.000Z',
      });
    });

    // Each operator, offline, transfers the role to a different holder. Each
    // close-old-then-append-new transaction is valid against ITS OWN local
    // state (it sees one open interval — Alice's — and closes it).
    await opA.scrum.setOperatorOfRecord({
      contributorId: 'ct-bob',
      fromTs: '2026-02-01T00:00:00.000Z',
    });
    await opB.scrum.setOperatorOfRecord({
      contributorId: 'ct-carol',
      fromTs: '2026-03-01T00:00:00.000Z',
    });

    await sim.settle();

    // The merged state still holds TWO open interval ROWS — A closed Alice and
    // opened Bob; B closed Alice and opened Carol; both opens land via distinct
    // ULID PKs (Class A inserts). The raw row state is unchanged by the fix.
    const openIntervals = await count(
      server,
      'SELECT COUNT(*) n FROM scrum_operator_history WHERE to_ts IS NULL',
    );
    expect(openIntervals).toBe(2);

    // But `currentOperator()` no longer trusts "the one open row": it folds the
    // open rows to the greatest (from_ts, id). The later transfer is Carol
    // (2026-03 > 2026-02), so EVERY replica converges to Carol — deterministically,
    // independent of push order. The single-holder read is restored by construction.
    for (const r of [server, opA, opB]) {
      const current = await r.scrum.currentOperator();
      expect(current?.id).toBe('ct-carol');
    }

    // The shared `scrum_current_operator` view that the read derives through
    // returns exactly one row (the max-fold's LIMIT 1), never two — so no
    // "current holder" query surfaces a dual-open.
    const viewRows = await count(server, 'SELECT COUNT(*) n FROM scrum_current_operator');
    expect(viewRows).toBe(1);
    const viewHolder = await server.store.get<{ contributor_id: string }>(
      'SELECT contributor_id FROM scrum_current_operator',
    );
    expect(viewHolder?.contributor_id).toBe('ct-carol');
  });

  test('two concurrent team role-slot rotations converge: getTeamRoster folds both opens to the latest holder', async () => {
    await seedCommonBase(async (s) => {
      await s.createTeam({ slug: 'engine', teamType: 'stream_aligned' });
      await s.rotateTeamMember({
        teamSlug: 'engine',
        role: 'engineer',
        contributorId: 'ct-alice',
        fromTs: '2026-01-01T00:00:00.000Z',
      });
    });

    await opA.scrum.rotateTeamMember({
      teamSlug: 'engine',
      role: 'engineer',
      contributorId: 'ct-bob',
      fromTs: '2026-02-01T00:00:00.000Z',
    });
    await opB.scrum.rotateTeamMember({
      teamSlug: 'engine',
      role: 'engineer',
      contributorId: 'ct-carol',
      fromTs: '2026-03-01T00:00:00.000Z',
    });

    await sim.settle();

    // Both open rows land on the merged state (Class A ULID inserts) — the raw
    // row state is unchanged by the fix.
    const openSlots = await count(
      server,
      "SELECT COUNT(*) n FROM scrum_team_members WHERE team_slug = 'engine' AND role = 'engineer' AND to_ts IS NULL",
    );
    expect(openSlots).toBe(2);

    // But the role-slot read folds the open rows per (team, role) to the greatest
    // (from_ts, id): Carol (2026-03) is the latest, so EVERY replica's roster
    // resolves the engineer slot to Carol regardless of push order — the dual-open
    // hazard is eliminated by construction.
    for (const r of [server, opA, opB]) {
      const roster = await r.scrum.getTeamRoster('engine');
      expect(roster.current.engineer?.contributor_id).toBe('ct-carol');
    }
  });
});

// ===========================================================================
// Class C② / C③ — cross-row invariants the per-row merge cannot preserve.
// Each writer's local state is valid; the MERGED state violates an invariant.
// Surfaceable (detection), not auto-resolved.
// ===========================================================================

describe('Class C② — cross-team write-scope disjointness breaks on merge', () => {
  test('two teams concurrently claim overlapping write globs; merged scopes overlap (detectable)', async () => {
    await seedCommonBase(async (s) => {
      await s.createTeam({ slug: 'engine', teamType: 'stream_aligned' });
      await s.createTeam({ slug: 'platform', teamType: 'platform' });
    });

    // Each scope-set is valid against its own local state: A sees no platform
    // write globs; B sees no engine write globs. The disjointness check passes
    // LOCALLY for each.
    await opA.scrum.setTeamScopes('engine', { read: [], write: ['packages/**'] });
    await opB.scrum.setTeamScopes('platform', { read: [], write: ['packages/store/**'] });

    await sim.settle();

    // Merged state: both write globs land (Class A composite-PK inserts), and
    // `packages/**` overlaps `packages/store/**` — the single-writer-per-path
    // invariant NEITHER writer's local state violated is now broken on the
    // server. `validateTeamWriteScopes` reads the merged state and SURFACES it.
    const conflict = await server.scrum.validateTeamWriteScopes();
    expect(conflict).not.toBeNull();
    expect([conflict?.teamA, conflict?.teamB].sort()).toEqual(['engine', 'platform']);
  });
});

describe('Class C③ — graph acyclicity breaks when merged dep edges form a cycle', () => {
  test('two concurrent dep-edge inserts together form a cycle (detectable, not auto-resolved)', async () => {
    await seedCommonBase(async (s) => {
      await s.createTask({ id: 'x', title: 'x' });
      await s.createTask({ id: 'y', title: 'y' });
    });

    // A adds x→y; B adds y→x. Each edge is individually acyclic against the
    // writer's own local graph (which has only that one edge).
    await opA.scrum.addDep('x', 'y', 'blocks');
    await opB.scrum.addDep('y', 'x', 'blocks');

    await sim.settle();

    // Both edges land; together they form a 2-cycle x↔y. Detect it by walking
    // the merged edge set — neither writer's local graph had a cycle.
    const edges = await server.store.all<{ from_task_id: string; to_task_id: string }>(
      "SELECT from_task_id, to_task_id FROM scrum_deps WHERE kind = 'blocks'",
    );
    const adj = new Map<string, string[]>();
    for (const e of edges) {
      const bucket = adj.get(e.from_task_id);
      if (bucket) bucket.push(e.to_task_id);
      else adj.set(e.from_task_id, [e.to_task_id]);
    }
    expect(hasCycle(adj)).toBe(true); // cycle present on merge, surfaceable.
  });
});

/** DFS cycle detection over a directed adjacency map. */
function hasCycle(adj: Map<string, string[]>): boolean {
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const visit = (node: string): boolean => {
    color.set(node, GREY);
    for (const next of adj.get(node) ?? []) {
      const c = color.get(next) ?? WHITE;
      if (c === GREY) return true;
      if (c === WHITE && visit(next)) return true;
    }
    color.set(node, BLACK);
    return false;
  };
  for (const node of adj.keys()) {
    if ((color.get(node) ?? WHITE) === WHITE && visit(node)) return true;
  }
  return false;
}

// ===========================================================================
// Class D — UNIQUE / PK collisions on replay. Per the collision policy:
//   secondary UNIQUE → throws / rolls back (sync-blocking, surfaced)
//   natural PK       → last-push overwrite (surfaced)
// In NO case a silent transaction DROP.
// ===========================================================================

describe('Class D — collision outcomes on replay (no silent drop)', () => {
  test('secondary UNIQUE (scrum_contributors.slug) collision THROWS and rolls back atomically', async () => {
    await seedCommonBase(async () => {});

    // Both operators register a contributor with the SAME slug but distinct
    // CT-UUID PKs while offline. The PK does not collide; the secondary UNIQUE
    // on `slug` does.
    await opA.scrum.registerContributor({ slug: 'dup', id: 'ct-A-dup' });
    await opB.scrum.registerContributor({ slug: 'dup', id: 'ct-B-dup' });

    // A pushes first → server holds (ct-A-dup, 'dup'). B's push replays its local
    // ct-B-dup INSERT as a PK-keyed UPSERT against the server. The slug UNIQUE is
    // a SECONDARY index (no PK conflict clause covers it) → raw `UNIQUE
    // constraint failed` → the whole push transaction rolls back atomically.
    // Surfaced as a throw, never a silent drop. (The shipped engine applies this
    // same UPSERT replay on both push and pull; whichever direction first
    // replays the losing INSERT over the conflicting row raises.)
    await sim.push(opA);
    const serverBefore = await count(server, 'SELECT COUNT(*) n FROM scrum_contributors');
    let threw = false;
    try {
      await sim.push(opB);
    } catch (err) {
      threw = true;
      expect(String(err)).toMatch(/UNIQUE/i);
    }
    expect(threw).toBe(true);
    // Atomic rollback: the server is unchanged (nothing half-applied), so the
    // collision is recoverable rather than corrupting.
    expect(await count(server, 'SELECT COUNT(*) n FROM scrum_contributors')).toBe(serverBefore);
  });

  test('transform hook degrades the slug-UNIQUE collision to a surfaced skip (sync not blocked)', async () => {
    await seedCommonBase(async () => {});
    await opA.scrum.registerContributor({ slug: 'dup', id: 'ct-A-dup' });
    await opB.scrum.registerContributor({ slug: 'dup', id: 'ct-B-dup' });
    await sim.push(opA);

    // The shipped recovery: a `transform` (fired per CDC mutation before push)
    // that maps the known slug collision to `skip`, so B's push completes
    // instead of blocking. This is the policy's item-6 hook modelled on the
    // simulator. The hook is one-sided — it queries CURRENT server state inside
    // its decision, since it never receives the conflicting remote row.
    const surfaced: Mutation[] = [];
    const transform: Transform = (m) => {
      if (m.table === 'scrum_contributors' && m.after && m.after.slug === 'dup') {
        surfaced.push(m); // record for the post-pull anomaly surface.
        return { operation: 'skip' };
      }
      return null;
    };

    await sim.push(opB, transform); // no throw — degraded to skip.

    // The collision was surfaced (recorded), not silently dropped.
    expect(surfaced.length).toBe(1);
    // The server kept the winning writer's row (ct-A-dup); B's losing insert was
    // skipped, so exactly one 'dup' contributor exists.
    expect(
      await count(server, "SELECT COUNT(*) n FROM scrum_contributors WHERE slug = 'dup'"),
    ).toBe(1);
    const dup = await server.scrum.getContributorBySlug('dup');
    expect(dup?.id).toBe('ct-A-dup');
  });

  test('secondary UNIQUE on scrum_acceptance_criteria (task_id, criterion_id) collision throws', async () => {
    await seedCommonBase(async (s) => {
      await s.createTask({ id: 't1', title: 't1' });
    });

    // Both operators add a criterion with the SAME external criterion_id to the
    // same task. Each criterion row has a distinct ULID surrogate PK, so the PK
    // does not collide — the UNIQUE(task_id, criterion_id) does.
    await opA.scrum.addCriterion('t1', {
      id: 'crit-x',
      text: 'A version',
      verifies_by: 'assert',
      check: 'true',
      status: 'active',
      idempotent: true,
    });
    await opB.scrum.addCriterion('t1', {
      id: 'crit-x',
      text: 'B version',
      verifies_by: 'assert',
      check: 'true',
      status: 'active',
      idempotent: true,
    });

    await sim.push(opA);
    let threw = false;
    try {
      await sim.push(opB);
    } catch (err) {
      threw = true;
      expect(String(err)).toMatch(/UNIQUE/i);
    }
    expect(threw).toBe(true);
  });

  test('natural PK collision (scrum_decisions.id) is a last-push OVERWRITE, surfaced, never a drop', async () => {
    await seedCommonBase(async () => {});

    // Two operators record a same-named decision (the filename slug is the PK)
    // with different bodies. The PK collides.
    await opA.scrum.recordDecision({
      id: '2026-06-14-shared',
      title: 'A title',
      content: 'A body',
    });
    await opB.scrum.recordDecision({
      id: '2026-06-14-shared',
      title: 'B title',
      content: 'B body',
    });

    // A pushes first, then B. On B's push the PK conflict fires DO UPDATE on the
    // server → B overwrites A's row content. No throw, no drop — last-push-wins.
    await sim.settle();

    for (const r of [server, opA, opB]) {
      const d = await r.scrum.getDecision('2026-06-14-shared');
      expect(d?.content).toBe('B body'); // last push (B) won the overwrite.
    }
    // Exactly one row — the overwrite did not duplicate, and A's intent is
    // recoverable from git (the .md file), the policy's accept-and-surface path.
    expect(
      await count(server, "SELECT COUNT(*) n FROM scrum_decisions WHERE id = '2026-06-14-shared'"),
    ).toBe(1);
  });

  test('natural PK collision (scrum_teams.slug) is a last-push OVERWRITE, surfaced', async () => {
    await seedCommonBase(async () => {});
    await opA.scrum.createTeam({
      slug: 'shared',
      teamType: 'stream_aligned',
      charter: 'A charter',
    });
    await opB.scrum.createTeam({ slug: 'shared', teamType: 'platform', charter: 'B charter' });

    await sim.settle();

    for (const r of [server, opA, opB]) {
      const team = await r.scrum.getTeam('shared');
      expect(team?.charter).toBe('B charter'); // last push overwrote.
      expect(team?.team_type).toBe('platform');
    }
  });

  test('delete-all-then-reinsert (writeAcceptance) re-keys the surrogate, orphaning verdict history (the real hazard)', async () => {
    await seedCommonBase(async (s) => {
      await s.createTask({
        id: 't1',
        title: 't1',
        acceptance: {
          criteria: [
            {
              id: 'c1',
              text: 'base',
              verifies_by: 'assert',
              check: 'true',
              status: 'active',
              idempotent: true,
            },
          ],
        },
      });
    });

    // The original c1's surrogate PK (the verdict-log FK target).
    const c1SurrogateBefore = (
      await server.store.get<{ id: string }>(
        "SELECT id FROM scrum_acceptance_criteria WHERE task_id = 't1' AND criterion_id = 'c1'",
      )
    )?.id;

    // A adds a new criterion via the per-row append path (addCriterion).
    await opA.scrum.addCriterion('t1', {
      id: 'c2-from-A',
      text: 'A add',
      verifies_by: 'assert',
      check: 'true',
      status: 'active',
      idempotent: true,
    });
    // B replaces the WHOLE criteria set via setAcceptance (delete-all-reinsert):
    // it DELETEs every criterion row for t1 and re-inserts fresh surrogates.
    await opB.scrum.setAcceptance('t1', {
      criteria: [
        {
          id: 'c1',
          text: 'base',
          verifies_by: 'assert',
          check: 'true',
          status: 'active',
          idempotent: true,
        },
        {
          id: 'c3-from-B',
          text: 'B add',
          verifies_by: 'assert',
          check: 'true',
          status: 'active',
          idempotent: true,
        },
      ],
    });

    await sim.settle();

    const rows = (
      await server.store.all<{ criterion_id: string; id: string }>(
        "SELECT criterion_id, id FROM scrum_acceptance_criteria WHERE task_id = 't1'",
      )
    ).sort((a, b) => a.criterion_id.localeCompare(b.criterion_id));
    const externalIds = rows.map((r) => r.criterion_id);

    // FINDING — nuances the collision policy: under the SHIPPED per-row CDC
    // tape, B's delete-all is captured as per-row deletes of only the rows B saw
    // at its baseline (the original c1 surrogate) — NOT A's concurrently-added
    // c2-from-A, which B never observed. So the SET-replace does NOT clobber a
    // peer's concurrent sibling add at the tape-replay level (the clobber the
    // policy describes is a logical-SQL/predicate-replay concern, not a per-row
    // one). All three external ids survive:
    expect(externalIds).toEqual(['c1', 'c2-from-A', 'c3-from-B']);

    // The REAL residual hazard: B re-inserts c1 under a FRESH ULID surrogate, so
    // c1's PK changes. Any verdict rows that referenced the OLD c1 surrogate are
    // now orphaned (the criterion-head INNER JOIN no longer resolves them). The
    // policy's remedy — prefer per-row append/supersede over bulk replace — is
    // about preserving this surrogate identity, not about clobbering siblings.
    const c1SurrogateAfter = rows.find((r) => r.criterion_id === 'c1')?.id;
    expect(c1SurrogateAfter).toBeDefined();
    expect(c1SurrogateAfter).not.toBe(c1SurrogateBefore); // surrogate re-keyed.
  });
});
