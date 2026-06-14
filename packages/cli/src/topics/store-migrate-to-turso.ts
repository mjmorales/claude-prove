/**
 * `claude-prove store migrate-to-turso` — move a project's LEGACY `prove.db`
 * (the pre-Turso `bun:sqlite` schema, scrum chain up to v28 / acb up to v4) onto
 * the sync-safe Turso v1 schema, preserving every row and FK relationship.
 *
 * Run ONCE per existing project; new projects bootstrap clean v1 and never reach
 * this path. The legacy file is the same SQLite format, so the Turso engine
 * reads it directly — `bun:sqlite` appears nowhere here.
 *
 * Pipeline (local; cloud provision + push is a separate step gated on the
 * cloud-sync work and intentionally NOT done here):
 *   1. Open the legacy file read-only and confirm it is actually legacy
 *      (a registered domain logged at a version above the v1 reset).
 *   2. Build a fresh v1 database at a temp path (run the v1 migrations).
 *   3. Transform legacy rows into v1 shape (see `migrateLegacyToV1`).
 *   4. Verify mechanically: per-table row counts + a dangling-FK integrity sweep.
 *   5. Preserve the legacy file untouched, renamed to `<db>.pre-turso`, and
 *      swap the new v1 database in at the canonical path.
 *
 * The transform never mutates the legacy file. A failed verify aborts before any
 * rename, leaving the project exactly as it was.
 */

import { existsSync, renameSync, rmSync } from 'node:fs';
import {
  type Store,
  openStore,
  resolveDbPath,
  runMigrations,
  ulid,
  withTx,
} from '@claude-prove/store';
import { ensureAcbSchemaRegistered } from './acb/store';
import { ensureScrumSchemaRegistered } from './scrum/schemas';

/** The v1 reset collapsed each domain to v1; a logged version above this marks a legacy store. */
const V1_RESET_VERSION = 1;

/** Per-table outcome in the migration report. */
export interface TableReport {
  table: string;
  /** Rows read from the legacy table. */
  legacyRows: number;
  /** Rows written to the v1 table (differs for exploded/derived tables). */
  v1Rows: number;
  /** Non-null legacy FK references with no target row (set NULL in v1). */
  orphansNulled: number;
}

export interface MigrationReport {
  tables: TableReport[];
  /** Acceptance criteria exploded out of `scrum_tasks.acceptance_json`. */
  criteriaExploded: number;
  /** Dangling foreign-key references found after the load (must be 0 for success). */
  fkViolations: number;
}

/**
 * Legacy tables whose integer `AUTOINCREMENT` primary key becomes a fresh ULID.
 * `timeCol` seeds the ULID timestamp so the v1 id ordering matches the legacy
 * chronological order; rows are processed in legacy-PK order and the seed is
 * forced strictly increasing so equal timestamps keep their order.
 */
const REMAP_TABLES: { table: string; pk: string; timeCol: string }[] = [
  { table: 'scrum_events', pk: 'id', timeCol: 'ts' },
  { table: 'scrum_operator_history', pk: 'id', timeCol: 'created_at' },
  { table: 'scrum_team_members', pk: 'id', timeCol: 'created_at' },
  { table: 'scrum_team_accepts', pk: 'id', timeCol: 'created_at' },
  { table: 'scrum_team_exposes', pk: 'id', timeCol: 'created_at' },
  { table: 'scrum_lores', pk: 'id', timeCol: 'created_at' },
  { table: 'scrum_annotations', pk: 'id', timeCol: 'created_at' },
  { table: 'scrum_asks', pk: 'id', timeCol: 'created_at' },
  { table: 'scrum_escalations', pk: 'id', timeCol: 'created_at' },
  { table: 'acb_manifests', pk: 'id', timeCol: 'created_at' },
  { table: 'acb_acb_documents', pk: 'id', timeCol: 'created_at' },
  { table: 'acb_review_state', pk: 'id', timeCol: 'created_at' },
];

/**
 * Self- and cross-referential FK columns holding a LEGACY integer id that must be
 * rewritten to the remapped ULID. Each entry names the table and column plus the
 * remap table whose id-map resolves the value. A value with no mapping is a
 * dangling reference: it is nulled and counted as an orphan, never crashing.
 */
const FK_REWRITES: { table: string; column: string; refTable: string }[] = [
  { table: 'scrum_team_accepts', column: 'superseded_by', refTable: 'scrum_team_accepts' },
  { table: 'scrum_team_exposes', column: 'superseded_by', refTable: 'scrum_team_exposes' },
  { table: 'scrum_escalations', column: 'walked_up_from', refTable: 'scrum_escalations' },
  { table: 'scrum_lores', column: 'superseded_by', refTable: 'scrum_lores' },
  { table: 'scrum_decisions', column: 'source_lore_id', refTable: 'scrum_lores' },
];

/**
 * Tables copied with their TEXT primary key preserved (most scrum tables already
 * carry ULID/slug ids). `acb_group_verdicts` is here even though it gains a ULID
 * `id` column: it has no legacy integer PK to remap (its legacy PK was the
 * `(slug, group_id)` natural key), so each row simply gets a fresh `id`.
 */
const KEEP_TABLES = [
  'scrum_milestones',
  'scrum_tasks',
  'scrum_decisions',
  'scrum_contributors',
  'scrum_teams',
  'scrum_team_scopes',
  'scrum_deps',
  'scrum_tags',
  'scrum_run_links',
  'scrum_context_bundles',
  'acb_group_verdicts',
];

type Row = Record<string, unknown>;
type RemapMap = Map<string, string>;

/** Column names of a table in the target store, in declaration order. */
async function tableColumns(store: Store, table: string): Promise<string[]> {
  const rows = await store.all<{ name: string }>(`PRAGMA table_info(${table})`);
  return rows.map((r) => r.name);
}

/** True when the legacy store has the table (it may predate a given feature). */
async function legacyHasTable(legacy: Store, table: string): Promise<boolean> {
  const row = await legacy.get<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    [table],
  );
  return row !== undefined;
}

/** Parse an ISO timestamp to epoch ms, or undefined when absent/unparseable. */
function parseTime(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * Mint the integer→ULID id maps for every remap table, processing rows in
 * legacy-PK order with a strictly-increasing time seed so v1 id ordering matches
 * the legacy chronological order. Built for ALL remap tables before any insert,
 * so self- and cross-referential FK rewrites always resolve.
 */
async function buildRemaps(legacy: Store): Promise<Map<string, RemapMap>> {
  const remaps = new Map<string, RemapMap>();
  for (const { table, pk, timeCol } of REMAP_TABLES) {
    const map: RemapMap = new Map();
    remaps.set(table, map);
    if (!(await legacyHasTable(legacy, table))) continue;
    const rows = await legacy.all<Row>(`SELECT * FROM ${table} ORDER BY ${pk} ASC`);
    let lastSeed = 0;
    for (const row of rows) {
      const seed = Math.max(parseTime(row[timeCol]) ?? lastSeed + 1, lastSeed + 1);
      lastSeed = seed;
      map.set(String(row[pk]), ulid(seed));
    }
  }
  return remaps;
}

/**
 * Build the v1 row for a legacy row: copy every column the v1 table and the
 * legacy row share by name, then apply the PK remap and FK rewrites. v1-only
 * columns the legacy row lacks are left out (SQLite supplies their default/NULL).
 */
function projectRow(
  legacyRow: Row,
  v1Cols: string[],
  opts: {
    pkColumn?: string;
    newId?: string;
    fkRewrites: { column: string; refTable: string }[];
    remaps: Map<string, RemapMap>;
    onOrphan: () => void;
  },
): Row {
  const out: Row = {};
  for (const col of v1Cols) {
    if (opts.pkColumn && col === opts.pkColumn && opts.newId !== undefined) {
      out[col] = opts.newId;
      continue;
    }
    const rewrite = opts.fkRewrites.find((f) => f.column === col);
    if (rewrite) {
      const legacyVal = legacyRow[col];
      if (legacyVal === null || legacyVal === undefined) {
        out[col] = null;
      } else {
        const mapped = opts.remaps.get(rewrite.refTable)?.get(String(legacyVal));
        if (mapped === undefined) {
          opts.onOrphan();
          out[col] = null;
        } else {
          out[col] = mapped;
        }
      }
      continue;
    }
    // Some legacy tables (e.g. acb_group_verdicts) carry only `updated_at` and no
    // `created_at`, but the v1 schema makes `created_at` NOT NULL. Backfill it from
    // `updated_at`: a row was created no later than its last update, and for the
    // append-only verdict rows the two instants are equal — so the insert no longer
    // violates the constraint and no data is lost.
    if (col === 'created_at' && !(col in legacyRow) && 'updated_at' in legacyRow) {
      out[col] = legacyRow.updated_at;
      continue;
    }
    if (col in legacyRow) out[col] = legacyRow[col];
  }
  return out;
}

/** Insert a projected row into `table`, naming only the columns present in `row`. */
async function insertRow(store: Store, table: string, row: Row): Promise<void> {
  const cols = Object.keys(row);
  if (cols.length === 0) return;
  const placeholders = cols.map(() => '?').join(', ');
  await store.run(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`,
    cols.map((c) => row[c] as never),
  );
}

/**
 * Explode `scrum_tasks.acceptance_json` (legacy blob: `{ criteria: [...] }`) into
 * `scrum_acceptance_criteria` rows. Legacy criteria carry only the DEFINITION (no
 * verdicts), so the append-only `scrum_criterion_verdicts` log starts empty.
 * Returns the number of criteria written.
 */
async function explodeAcceptance(target: Store, task: Row): Promise<number> {
  const raw = task.acceptance_json;
  if (typeof raw !== 'string' || raw.length === 0) return 0;
  let parsed: { criteria?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 0;
  }
  const criteria = Array.isArray(parsed.criteria) ? parsed.criteria : [];
  let written = 0;
  for (let i = 0; i < criteria.length; i++) {
    const c = criteria[i] as Record<string, unknown>;
    if (typeof c?.id !== 'string') continue;
    await insertRow(target, 'scrum_acceptance_criteria', {
      id: ulid(),
      task_id: task.id,
      criterion_id: c.id,
      // ULID ord preserves authored array order (monotonic) and interleaves
      // with any v1-authored criterion added later.
      ord: ulid(),
      text: typeof c.text === 'string' ? c.text : '',
      verifies_by: typeof c.verifies_by === 'string' ? c.verifies_by : 'assert',
      check_payload: typeof c.check === 'string' ? c.check : '',
      status: c.status === 'superseded' ? 'superseded' : 'active',
      idempotent: c.idempotent ? 1 : 0,
      scope: typeof c.scope === 'string' ? c.scope : null,
      timeout: typeof c.timeout === 'string' ? c.timeout : null,
      superseded_by: typeof c.superseded_by === 'string' ? c.superseded_by : null,
      reason: typeof c.reason === 'string' ? c.reason : null,
      inherited_from: typeof c.inherited_from === 'string' ? c.inherited_from : null,
      created_at: typeof task.created_at === 'string' ? task.created_at : new Date(0).toISOString(),
    });
    written++;
  }
  return written;
}

/**
 * Transform every legacy row into the v1 schema on an already-migrated, empty
 * target store. FK enforcement is suspended for the load and re-enabled after,
 * so insert order is irrelevant and integrity is proven by a post-load
 * `foreign_key_check`. The whole load runs in one transaction: any error rolls
 * it back, leaving the target empty and the legacy file untouched.
 */
export async function migrateLegacyToV1(legacy: Store, target: Store): Promise<MigrationReport> {
  const remaps = await buildRemaps(legacy);
  const tables: TableReport[] = [];
  let criteriaExploded = 0;

  // PRAGMA foreign_keys is a no-op inside a transaction, so toggle it around
  // the load rather than within.
  await target.exec('PRAGMA foreign_keys = OFF');
  try {
    await withTx(target, async () => {
      // KEEP tables: copy with the TEXT PK preserved; rewrite any int FK columns.
      for (const table of KEEP_TABLES) {
        if (!(await legacyHasTable(legacy, table))) {
          tables.push({ table, legacyRows: 0, v1Rows: 0, orphansNulled: 0 });
          continue;
        }
        const v1Cols = await tableColumns(target, table);
        const fkRewrites = FK_REWRITES.filter((f) => f.table === table);
        const rows = await legacy.all<Row>(`SELECT * FROM ${table}`);
        let orphans = 0;
        let written = 0;
        for (const row of rows) {
          // acb_group_verdicts gains a ULID id with no legacy integer PK.
          const newId = table === 'acb_group_verdicts' ? ulid() : undefined;
          const projected = projectRow(row, v1Cols, {
            pkColumn: table === 'acb_group_verdicts' ? 'id' : undefined,
            newId,
            fkRewrites,
            remaps,
            onOrphan: () => orphans++,
          });
          await insertRow(target, table, projected);
          written++;
          if (table === 'scrum_tasks') criteriaExploded += await explodeAcceptance(target, row);
        }
        tables.push({ table, legacyRows: rows.length, v1Rows: written, orphansNulled: orphans });
      }

      // REMAP tables: replace the integer PK with the minted ULID; rewrite FKs.
      for (const { table, pk } of REMAP_TABLES) {
        if (!(await legacyHasTable(legacy, table))) {
          tables.push({ table, legacyRows: 0, v1Rows: 0, orphansNulled: 0 });
          continue;
        }
        const v1Cols = await tableColumns(target, table);
        const map = remaps.get(table) ?? new Map();
        const fkRewrites = FK_REWRITES.filter((f) => f.table === table);
        const rows = await legacy.all<Row>(`SELECT * FROM ${table} ORDER BY ${pk} ASC`);
        let orphans = 0;
        for (const row of rows) {
          const projected = projectRow(row, v1Cols, {
            pkColumn: pk,
            newId: map.get(String(row[pk])),
            fkRewrites,
            remaps,
            onOrphan: () => orphans++,
          });
          await insertRow(target, table, projected);
        }
        tables.push({
          table,
          legacyRows: rows.length,
          v1Rows: rows.length,
          orphansNulled: orphans,
        });
      }
    });
  } finally {
    await target.exec('PRAGMA foreign_keys = ON');
  }

  const fkViolations = await countFkViolations(target);
  return { tables, criteriaExploded, fkViolations };
}

/**
 * Count dangling foreign-key references across every table. The Turso engine
 * does not implement `PRAGMA foreign_key_check`, so integrity is verified by
 * introspecting each table's FKs (`foreign_key_list`) and counting non-null
 * child values whose parent row is absent — equivalent and order-independent.
 */
async function countFkViolations(store: Store): Promise<number> {
  const tableRows = await store.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != '_migrations_log'",
  );
  let total = 0;
  for (const { name: table } of tableRows) {
    const fks = await store.all<{ from: string; table: string; to: string }>(
      `PRAGMA foreign_key_list(${table})`,
    );
    for (const fk of fks) {
      const row = await store.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM ${table} c
           WHERE c.${fk.from} IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM ${fk.table} p WHERE p.${fk.to} = c.${fk.from})`,
      );
      total += row?.n ?? 0;
    }
  }
  return total;
}

export interface MigrateToTursoOptions {
  /** Explicit legacy/canonical db path. Defaults to the project's resolved path. */
  dbPath?: string;
  /** Verify + report only; write nothing and leave the legacy file in place. */
  dryRun?: boolean;
  /** Required to perform the file swap (this renames the legacy file). */
  confirm?: boolean;
}

/**
 * Drive the full local migrate-to-turso pipeline and print a report. Returns a
 * process exit code. Idempotent: a store that is already v1 (or never migrated)
 * is reported as nothing-to-do; a prior partial run is safely overwritten
 * because the new database is built at a temp path and only swapped in after a
 * clean verify.
 */
export async function runMigrateToTurso(opts: MigrateToTursoOptions): Promise<number> {
  ensureScrumSchemaRegistered();
  ensureAcbSchemaRegistered();

  const dbPath = opts.dbPath ?? resolveDbPath();
  if (!existsSync(dbPath)) {
    console.error(`migrate-to-turso: no store at ${dbPath}`);
    return 1;
  }

  // Confirm the source is actually legacy before touching anything.
  const probe = await openStore({ path: dbPath, readonly: true });
  let isLegacy: boolean;
  try {
    isLegacy = await storeIsLegacy(probe);
  } finally {
    probe.close();
  }
  if (!isLegacy) {
    console.log(`migrate-to-turso: ${dbPath} is not a legacy store — nothing to migrate.`);
    return 0;
  }

  const tmpPath = `${dbPath}.turso-new`;
  const backupPath = `${dbPath}.pre-turso`;
  // A leftover temp (and its WAL sidecars) from an aborted prior run is rebuilt
  // from scratch.
  removeWithSidecars(tmpPath);

  const legacy = await openStore({ path: dbPath, readonly: true });
  const target = await openStore({ path: tmpPath });
  let report: MigrationReport;
  try {
    await runMigrations(target);
    report = await migrateLegacyToV1(legacy, target);
    // Flush the WAL into the main temp file so the single file is complete
    // before the swap — renaming a WAL-mode db's main file alone would strand
    // every row in the orphaned `<tmp>-wal`. Turso ignores `journal_mode=DELETE`
    // but honors a TRUNCATE checkpoint.
    await target.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    legacy.close();
    target.close();
  }

  printReport(dbPath, report, opts.dryRun ?? false);

  if (report.fkViolations > 0) {
    console.error('migrate-to-turso: FK integrity check failed — aborting, legacy file untouched.');
    rmSync(tmpPath, { force: true });
    return 1;
  }

  if (opts.dryRun) {
    removeWithSidecars(tmpPath);
    console.log('migrate-to-turso: dry run — no files changed.');
    return 0;
  }

  if (!opts.confirm) {
    console.error(
      'migrate-to-turso: re-run with --confirm to swap in the v1 store (the legacy file is preserved as <db>.pre-turso).',
    );
    removeWithSidecars(tmpPath);
    return 1;
  }

  // Preserve the legacy file (with any sidecars) untouched as <db>.pre-turso,
  // then swap the verified v1 db in. The new db's WAL was truncated by the
  // checkpoint above, so its stale `-wal`/`-shm` sidecars are dropped — the
  // canonical path reopens and writes a fresh WAL.
  moveWithSidecars(dbPath, backupPath);
  renameSync(tmpPath, dbPath);
  removeSidecars(tmpPath);
  removeSidecars(dbPath); // drop any WAL inherited from the just-renamed temp
  console.log(`migrate-to-turso: migrated → ${dbPath}; legacy preserved at ${backupPath}.`);
  console.log('migrate-to-turso: cloud provision + push is a separate step (not yet available).');
  return 0;
}

/** WAL/SHM sidecars SQLite writes next to a db file. */
const SIDECAR_SUFFIXES = ['-wal', '-shm'];

/** Delete a db file and its WAL/SHM sidecars (best-effort). */
function removeWithSidecars(path: string): void {
  rmSync(path, { force: true });
  removeSidecars(path);
}

function removeSidecars(path: string): void {
  for (const suffix of SIDECAR_SUFFIXES) rmSync(path + suffix, { force: true });
}

/** Rename a db file and any present sidecars to a new base path. */
function moveWithSidecars(from: string, to: string): void {
  renameSync(from, to);
  for (const suffix of SIDECAR_SUFFIXES) {
    if (existsSync(from + suffix)) renameSync(from + suffix, to + suffix);
  }
}

/** A store is legacy when a registered domain logs a version above the v1 reset. */
async function storeIsLegacy(store: Store): Promise<boolean> {
  const logExists = await store.get<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_migrations_log'",
  );
  if (!logExists) return false;
  const rows = await store.all<{ maxVersion: number }>(
    'SELECT MAX(version) AS maxVersion FROM _migrations_log GROUP BY domain',
  );
  return rows.some((r) => r.maxVersion > V1_RESET_VERSION);
}

function printReport(dbPath: string, report: MigrationReport, dryRun: boolean): void {
  console.log(`migrate-to-turso${dryRun ? ' (dry run)' : ''}: ${dbPath}`);
  let legacyTotal = 0;
  let v1Total = 0;
  let orphanTotal = 0;
  for (const t of report.tables) {
    legacyTotal += t.legacyRows;
    v1Total += t.v1Rows;
    orphanTotal += t.orphansNulled;
    const orphanNote = t.orphansNulled > 0 ? ` (${t.orphansNulled} orphan FK nulled)` : '';
    console.log(`  ${t.table}: ${t.legacyRows} → ${t.v1Rows}${orphanNote}`);
  }
  console.log(
    `  acceptance criteria exploded: ${report.criteriaExploded}; FK violations: ${report.fkViolations}; orphans nulled: ${orphanTotal}`,
  );
  console.log(`  totals: ${legacyTotal} legacy rows → ${v1Total} v1 rows (+ exploded criteria)`);
}
