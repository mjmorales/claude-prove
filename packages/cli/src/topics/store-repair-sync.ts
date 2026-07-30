/**
 * `store repair-sync` — diagnose and repair a wedged cloud-sync replica.
 *
 * Two failure modes put a synced store into a state it never leaves on its own,
 * and they compound: a stranded local table (rows the outbound stream dropped,
 * so they exist ONLY on this machine) and a stale WAL watermark (the engine
 * refuses every pull because the local WAL is shorter than the frame its
 * metadata recorded). Repairing them in the wrong order destroys data, because
 * a pull is `rollback local → apply remote → replay local CDC`: any local row
 * whose CDC was already consumed is rolled back and never comes home.
 *
 * So the repair is ordered and gated, never opportunistic:
 *   1. inventory  — count every table locally and on the remote
 *   2. backfill   — re-emit stranded rows into the CDC and push them up
 *   3. verify     — remote now holds every local row, or STOP
 *   4. clamp      — lower the stale watermark to a frame the WAL actually has
 *
 * Step 4 runs only when step 3 passes. A dry run reports the plan and changes
 * nothing; `--confirm` performs it.
 */

import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import {
  type CloudCoordinates,
  type SqlParam,
  type Store,
  openStore,
  openSyncDatabase,
  resolveCloudToken,
  resolveDbPath,
  syncRemoteUrl,
  withTx,
} from '@claude-prove/store';
import { readCloudConfig } from './store-provision';

/** Tables whose rows the guarded-transform defect could have stranded locally. */
const STRANDABLE_TABLES = [
  'scrum_contributors',
  'scrum_acceptance_criteria',
  'scrum_criterion_verdicts',
] as const;

export interface RepairSyncFlags {
  /** Project root holding `.claude/.prove.json`. Defaults to cwd. */
  workspaceRoot?: string;
  /** Perform the repair. Without it the command reports and changes nothing. */
  confirm?: boolean;
}

/** Counts one table's rows on the remote primary. */
export type CountRemote = (
  coords: CloudCoordinates,
  token: string,
  table: string,
) => Promise<number>;

/** Re-emits the stranded rows and pushes them; resolves to the row count sent. */
export type Backfill = (
  dbPath: string,
  coords: CloudCoordinates,
  token: string,
  stranded: TableCensus[],
) => Promise<number>;

/** Injectable seams — production wires the real remote count and backfill. */
export interface RepairSyncDeps {
  countRemote: CountRemote;
  backfill: Backfill;
  resolveToken: (dbName: string) => string | null;
}

/** A single table's local-vs-remote row census. */
export interface TableCensus {
  table: string;
  local: number;
  remote: number;
}

/** What the engine recorded versus what the local WAL can actually satisfy. */
interface WatermarkState {
  /** Frame the metadata demands a checkpoint reach. */
  watermark: number;
  /** Frames the local WAL actually holds. */
  walMaxFrame: number;
}

/**
 * Run the repair. Returns a process exit code: 0 on a clean store or a completed
 * repair, 1 when the store needs a repair that was not confirmed, or when the
 * backfill did not fully land (in which case the watermark is left ALONE, so the
 * stranded rows survive locally and can be retried).
 */
export async function runRepairSync(
  flags: RepairSyncFlags = {},
  overrides: Partial<RepairSyncDeps> = {},
): Promise<number> {
  const deps: RepairSyncDeps = {
    countRemote: countRemoteOverHttp,
    backfill: backfillOverSync,
    resolveToken: resolveCloudToken,
    ...overrides,
  };
  const workspaceRoot = flags.workspaceRoot ?? process.cwd();
  const cloud = readCloudConfig(workspaceRoot);
  if (cloud === null || !cloud.enabled) {
    console.log(
      'store repair-sync: cloud sync is not enabled for this project — nothing to repair',
    );
    return 0;
  }
  const token = deps.resolveToken(cloud.dbName);
  if (token === null) {
    console.error(
      `store repair-sync: no cloud token for '${cloud.dbName}' — run \`claude-prove store provision\``,
    );
    return 1;
  }
  const dbPath = resolveDbPath({ cwd: workspaceRoot });
  const coords: CloudCoordinates = { org: cloud.org, dbName: cloud.dbName };

  const census = await takeCensus(dbPath, coords, token, deps.countRemote);
  const stranded = census.filter((c) => c.local > c.remote);
  const watermark = readWatermark(dbPath);
  const watermarkStale = watermark !== null && watermark.walMaxFrame < watermark.watermark;

  report(census, stranded, watermark, watermarkStale);
  if (stranded.length === 0 && !watermarkStale) return 0;
  if (!flags.confirm) {
    console.log('\nstore repair-sync: reporting only — re-run with --confirm to repair');
    return 1;
  }

  backupMetadata(dbPath);

  if (stranded.length > 0) {
    const pushed = await deps.backfill(dbPath, coords, token, stranded);
    const after = await takeCensus(dbPath, coords, token, deps.countRemote);
    const stillStranded = after.filter((c) => c.local > c.remote);
    console.log(`store repair-sync: re-emitted ${pushed} row(s) and pushed`);
    if (stillStranded.length > 0) {
      for (const c of stillStranded) {
        console.error(
          `store repair-sync: ${c.table} still short on the remote: ${c.local} local vs ${c.remote} remote`,
        );
      }
      console.error(
        'store repair-sync: backfill incomplete — leaving the watermark untouched so the stranded rows stay recoverable',
      );
      return 1;
    }
  }

  if (watermarkStale && watermark !== null) {
    clampWatermark(dbPath, watermark.walMaxFrame);
    console.log(
      `store repair-sync: watermark ${watermark.watermark} -> ${watermark.walMaxFrame} (inbound sync unblocked)`,
    );
  }
  console.log('store repair-sync: repaired');
  return 0;
}

/** Print the census and the diagnosis behind whatever the repair will do. */
function report(
  census: TableCensus[],
  stranded: TableCensus[],
  watermark: WatermarkState | null,
  watermarkStale: boolean,
): void {
  console.log('table                            local   remote');
  for (const c of census) {
    const flag = c.local > c.remote ? '  <-- stranded locally' : '';
    console.log(
      `${c.table.padEnd(32)} ${String(c.local).padStart(5)}   ${String(c.remote).padStart(6)}${flag}`,
    );
  }
  if (watermark !== null) {
    console.log(
      `\nWAL: ${watermark.walMaxFrame} frame(s) local, watermark ${watermark.watermark}${watermarkStale ? '  <-- STALE, pull is blocked' : ''}`,
    );
  }
  if (stranded.length > 0) {
    console.log(
      `\n${stranded.length} table(s) hold rows the remote never received. They must be pushed BEFORE inbound sync resumes: a pull rolls local state back to the last synced revision, which would discard them permanently.`,
    );
  }
}

/** Count every strandable table on both sides. */
async function takeCensus(
  dbPath: string,
  coords: CloudCoordinates,
  token: string,
  countRemote: CountRemote,
): Promise<TableCensus[]> {
  const store = await openStore({ path: dbPath, readonly: true });
  const census: TableCensus[] = [];
  try {
    for (const table of STRANDABLE_TABLES) {
      const local = await countLocal(store, table);
      const remote = await countRemote(coords, token, table);
      census.push({ table, local, remote });
    }
  } finally {
    store.close();
  }
  return census;
}

/**
 * Count a table locally, treating ONLY a genuinely absent table as zero.
 *
 * A read failure must never degrade to 0: an under-reported local count makes a
 * stranded table look synced, which is exactly the state that lets the clamp
 * proceed and the next pull discard the rows. Anything but "no such table"
 * propagates and aborts the repair.
 */
async function countLocal(store: Store, table: string): Promise<number> {
  const present = await store.get<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    [table],
  );
  if (present === undefined) return 0;
  const row = await store.get<{ n: number }>(`SELECT count(*) AS n FROM ${table}`);
  return row?.n ?? 0;
}

const countRemoteOverHttp: CountRemote = async (coords, token, table) => {
  const url = syncRemoteUrl(coords).replace(/^libsql:\/\//, 'https://');
  const response = await fetch(`${url}/v2/pipeline`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      requests: [
        { type: 'execute', stmt: { sql: `SELECT count(*) AS n FROM ${table}` } },
        { type: 'close' },
      ],
    }),
  });
  if (!response.ok) throw new Error(`remote count for ${table}: HTTP ${response.status}`);
  const body = (await response.json()) as RemotePipelineResponse;
  const result = body.results?.[0];
  if (result === undefined || result.type === 'error') {
    throw new Error(`remote count for ${table}: ${result?.error?.message ?? 'no result'}`);
  }
  return Number(result.response?.result?.rows?.[0]?.[0]?.value ?? 0);
};

interface RemotePipelineResponse {
  results?: {
    type: string;
    error?: { message?: string };
    response?: { result?: { rows?: { value?: string }[][] } };
  }[];
}

/**
 * Re-emit every stranded row so the engine captures a FRESH insert for it.
 *
 * The original inserts' CDC entries are already marked consumed, so nothing
 * replays them; deleting and re-inserting the identical row inside one
 * transaction produces a new insert the engine turns into a PK upsert on push.
 * The delete is a no-op against a remote that never had the row.
 */
const backfillOverSync: Backfill = async (dbPath, coords, token, stranded) => {
  const sync = await openSyncDatabase({
    path: dbPath,
    coords,
    token,
    transform: () => null,
  });
  const store = await openStore({ connection: sync.connection, path: dbPath });
  let reemitted = 0;
  try {
    for (const { table } of stranded) {
      const rows = await store.all<Record<string, SqlParam>>(`SELECT * FROM ${table}`);
      if (rows.length === 0) continue;
      const columns = Object.keys(rows[0] as Record<string, SqlParam>);
      const placeholders = columns.map(() => '?').join(', ');
      await withTx(store, async () => {
        for (const row of rows) {
          const values = columns.map((c) => row[c] ?? null);
          await store.run(`DELETE FROM ${table} WHERE id = ?`, [row.id ?? null]);
          await store.run(
            `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`,
            values,
          );
          reemitted += 1;
        }
      });
    }
    await sync.push();
  } finally {
    store.close();
  }
  return reemitted;
};

/**
 * Read the engine's recorded watermark and the frames the local WAL holds. The
 * WAL frame count is derived from the file's size: a WAL is a 32-byte header
 * followed by fixed-size frames of `24 + page_size` bytes.
 */
function readWatermark(dbPath: string): WatermarkState | null {
  const metaPath = `${dbPath}-info`;
  if (!existsSync(metaPath)) return null;
  const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as {
    revert_since_wal_watermark?: number;
  };
  const watermark = meta.revert_since_wal_watermark;
  if (typeof watermark !== 'number') return null;
  return { watermark, walMaxFrame: walFrameCount(dbPath) };
}

const WAL_HEADER_BYTES = 32;
const WAL_FRAME_HEADER_BYTES = 24;
const DEFAULT_PAGE_BYTES = 4096;

function walFrameCount(dbPath: string): number {
  const walPath = `${dbPath}-wal`;
  if (!existsSync(walPath)) return 0;
  const { size } = statSync(walPath);
  if (size <= WAL_HEADER_BYTES) return 0;
  return Math.floor((size - WAL_HEADER_BYTES) / (WAL_FRAME_HEADER_BYTES + DEFAULT_PAGE_BYTES));
}

/** Keep the pre-repair metadata beside the db so a bad clamp is reversible. */
function backupMetadata(dbPath: string): void {
  const metaPath = `${dbPath}-info`;
  if (existsSync(metaPath)) copyFileSync(metaPath, `${metaPath}.pre-repair`);
}

/**
 * Lower the recorded watermark to a frame the WAL actually holds, which is the
 * condition the engine checks before it will checkpoint and pull again.
 */
function clampWatermark(dbPath: string, walMaxFrame: number): void {
  const metaPath = `${dbPath}-info`;
  const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as Record<string, unknown>;
  meta.revert_since_wal_watermark = walMaxFrame;
  writeFileSync(metaPath, JSON.stringify(meta));
}
