/**
 * The ordering guarantee is the whole point of this command: a stale watermark
 * must NEVER be cleared while rows are stranded locally, because clearing it
 * lets the next pull roll local state back to the last synced revision and the
 * stranded rows are gone for good.
 *
 * Every test stubs the remote count and the backfill, so nothing here touches a
 * network or a sync engine.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '@claude-prove/store';
import { type RepairSyncDeps, runRepairSync } from './store-repair-sync';

const CLOUD_ON = { enabled: true, org: 'acme', group: 'prove', db_name: 'prove-acme' };
const STRANDED_TABLE = 'scrum_acceptance_criteria';
const STALE_WATERMARK = 19321;

let roots: string[] = [];
afterEach(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots = [];
});

/**
 * A project root carrying a cloud-enabled `.prove.json`, a real store file with
 * `localRows` criteria rows, and a metadata sidecar at `watermark`.
 */
async function makeProject(opts: {
  localRows: number;
  watermark?: number;
}): Promise<{ root: string; dbPath: string; metaPath: string; walFrames: number }> {
  const root = mkdtempSync(join(tmpdir(), 'repair-sync-'));
  roots.push(root);
  mkdirSync(join(root, '.claude'), { recursive: true });
  mkdirSync(join(root, '.git'), { recursive: true });
  writeFileSync(
    join(root, '.claude', '.prove.json'),
    JSON.stringify({ schema_version: '12', cloud: CLOUD_ON }),
    'utf8',
  );
  mkdirSync(join(root, '.prove'), { recursive: true });
  const dbPath = join(root, '.prove', 'prove.db');

  const store = await openStore({ path: dbPath });
  await store.run(`CREATE TABLE ${STRANDED_TABLE} (id TEXT PRIMARY KEY, task_id TEXT)`);
  for (let i = 0; i < opts.localRows; i++) {
    await store.run(`INSERT INTO ${STRANDED_TABLE} (id, task_id) VALUES (?, ?)`, [`ac-${i}`, 't1']);
  }
  store.close();

  const metaPath = `${dbPath}-info`;
  writeFileSync(
    metaPath,
    JSON.stringify({ version: 'v1', revert_since_wal_watermark: opts.watermark ?? 0 }),
    'utf8',
  );
  // The engine's own WAL is left intact (it still holds the rows just written);
  // a watermark far above its frame count is the wedged shape under test.
  const walBytes = existsSync(`${dbPath}-wal`) ? statSync(`${dbPath}-wal`).size : 0;
  const walFrames = walBytes <= 32 ? 0 : Math.floor((walBytes - 32) / (24 + 4096));
  return { root, dbPath, metaPath, walFrames };
}

function readWatermark(metaPath: string): number {
  return (JSON.parse(readFileSync(metaPath, 'utf8')) as { revert_since_wal_watermark: number })
    .revert_since_wal_watermark;
}

/** Deps whose remote is empty and whose backfill lands nothing. */
function failingBackfill(sent: { rows: number }): Partial<RepairSyncDeps> {
  return {
    resolveToken: () => 'db-scoped-token',
    countRemote: async () => 0,
    backfill: async (_db, _coords, _token, stranded) => {
      sent.rows = stranded.reduce((n, s) => n + s.local, 0);
      return sent.rows;
    },
  };
}

describe('store repair-sync', () => {
  test('reports without changing anything unless --confirm is given', async () => {
    const { root, metaPath } = await makeProject({ localRows: 5, watermark: STALE_WATERMARK });
    const code = await runRepairSync({ workspaceRoot: root }, failingBackfill({ rows: 0 }));

    expect(code).toBe(1);
    expect(readWatermark(metaPath)).toBe(STALE_WATERMARK);
  });

  test('leaves the stale watermark ALONE when the backfill does not reach the remote', async () => {
    const { root, metaPath } = await makeProject({ localRows: 5, watermark: STALE_WATERMARK });
    const sent = { rows: 0 };

    const code = await runRepairSync({ workspaceRoot: root, confirm: true }, failingBackfill(sent));

    expect(sent.rows).toBe(5);
    expect(code).toBe(1);
    // The watermark still blocks the pull, which is what keeps the 5 local rows
    // alive: unblocking it would roll them back on the next pull.
    expect(readWatermark(metaPath)).toBe(STALE_WATERMARK);
  });

  test('clamps the watermark only once the remote holds every local row', async () => {
    const { root, metaPath, walFrames } = await makeProject({
      localRows: 5,
      watermark: STALE_WATERMARK,
    });
    let remote = 0;

    const code = await runRepairSync(
      { workspaceRoot: root, confirm: true },
      {
        resolveToken: () => 'db-scoped-token',
        countRemote: async () => remote,
        backfill: async () => {
          remote = 5;
          return 5;
        },
      },
    );

    expect(code).toBe(0);
    expect(readWatermark(metaPath)).toBeLessThan(STALE_WATERMARK);
    expect(readWatermark(metaPath)).toBe(walFrames);
  });

  test('keeps a pre-repair copy of the metadata so a clamp is reversible', async () => {
    const { root, metaPath, walFrames } = await makeProject({
      localRows: 0,
      watermark: STALE_WATERMARK,
    });

    await runRepairSync(
      { workspaceRoot: root, confirm: true },
      {
        resolveToken: () => 'db-scoped-token',
        countRemote: async () => 0,
        backfill: async () => 0,
      },
    );

    expect(readWatermark(`${metaPath}.pre-repair`)).toBe(STALE_WATERMARK);
    expect(readWatermark(metaPath)).toBe(walFrames);
  });

  test('a healthy store is a clean no-op', async () => {
    const { root, metaPath } = await makeProject({ localRows: 5, watermark: 0 });

    const code = await runRepairSync(
      { workspaceRoot: root },
      {
        resolveToken: () => 'db-scoped-token',
        countRemote: async () => 5,
        backfill: async () => {
          throw new Error('a healthy store must not be backfilled');
        },
      },
    );

    expect(code).toBe(0);
    expect(readWatermark(metaPath)).toBe(0);
  });

  test('a project without cloud sync is left untouched', async () => {
    const root = mkdtempSync(join(tmpdir(), 'repair-sync-local-'));
    roots.push(root);
    mkdirSync(join(root, '.claude'), { recursive: true });
    mkdirSync(join(root, '.git'), { recursive: true });
    writeFileSync(
      join(root, '.claude', '.prove.json'),
      JSON.stringify({ schema_version: '12' }),
      'utf8',
    );

    const code = await runRepairSync(
      { workspaceRoot: root, confirm: true },
      {
        resolveToken: () => {
          throw new Error('must not resolve a token for a local-only project');
        },
      },
    );

    expect(code).toBe(0);
  });
});
