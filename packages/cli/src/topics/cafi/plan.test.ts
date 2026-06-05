import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CACHE_VERSION, type FileCache, loadCache, saveCache } from '@claude-prove/shared';
import { cachePath, getStatus } from './indexer';
import { type DescribePlan, buildPlan } from './plan';
import { saveDescriptions } from './save';

function makeProject(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), `cafi-plan-${prefix}-`));
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(
    join(root, '.claude', '.prove.json'),
    JSON.stringify({
      schema_version: '4',
      tools: {
        cafi: {
          config: { excludes: [], max_file_size: 102400, batch_size: 5, triage: true },
        },
      },
    }),
  );
  return root;
}

function writeProjectFile(root: string, relPath: string, content: string): void {
  const abs = join(root, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function planEntries(plan: DescribePlan): Array<{ path: string; hash: string; reason: string }> {
  return plan.batches.flatMap((b) => b.files);
}

/** Drive the full plan -> describe -> save loop with stub descriptions. */
async function indexAll(root: string): Promise<void> {
  const plan = buildPlan(root);
  const files: Record<string, { hash: string; description: string }> = {};
  for (const entry of planEntries(plan)) {
    files[entry.path] = { hash: entry.hash, description: `stub description for ${entry.path}` };
  }
  await saveDescriptions(root, { files, deleted: plan.deleted });
}

describe('buildPlan', () => {
  let root: string;
  beforeEach(() => {
    root = makeProject('build');
    writeProjectFile(root, 'README.md', '# readme\n');
    writeProjectFile(root, 'src/main.ts', 'export const main = 1;\n');
    writeProjectFile(root, 'src/util.ts', 'export const util = 2;\n');
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('cold build: every file is a new batch entry with a sha256 hash', () => {
    const plan = buildPlan(root);
    expect(plan.total).toBe(3);
    expect(plan.new).toBe(3);
    expect(plan.stale).toBe(0);
    expect(plan.deleted).toEqual([]);
    expect(plan.unchanged).toBe(0);

    const entries = planEntries(plan);
    expect(entries.map((e) => e.path).sort()).toEqual(['README.md', 'src/main.ts', 'src/util.ts']);
    for (const entry of entries) {
      expect(entry.reason).toBe('new');
      expect(entry.hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test('incremental: edited file is stale, added file is new, removed file is deleted', async () => {
    await indexAll(root);
    writeProjectFile(root, 'src/main.ts', 'export const main = 99;\n');
    writeProjectFile(root, 'src/extra.ts', 'export const extra = 3;\n');
    rmSync(join(root, 'src/util.ts'));

    const plan = buildPlan(root);
    expect(plan.total).toBe(3);
    expect(plan.new).toBe(1);
    expect(plan.stale).toBe(1);
    expect(plan.deleted).toEqual(['src/util.ts']);
    expect(plan.unchanged).toBe(1);

    const entries = planEntries(plan);
    expect(entries).toHaveLength(2);
    expect(entries.find((e) => e.path === 'src/extra.ts')?.reason).toBe('new');
    expect(entries.find((e) => e.path === 'src/main.ts')?.reason).toBe('stale');
  });

  test('no changes: plan is empty and idempotent', async () => {
    await indexAll(root);
    const plan = buildPlan(root);
    expect(plan.new).toBe(0);
    expect(plan.stale).toBe(0);
    expect(plan.unchanged).toBe(3);
    expect(plan.batches).toEqual([]);
  });

  test('plan never prunes: a missing file keeps its cache entry and description', async () => {
    await indexAll(root);
    rmSync(join(root, 'src/util.ts'));

    const plan = buildPlan(root);
    expect(plan.deleted).toEqual(['src/util.ts']);

    // The transiently-missing file survives — only `save` prunes.
    const cache = loadCache(cachePath(root));
    expect(cache.files['src/util.ts']?.description).toBe('stub description for src/util.ts');
  });

  test('stale entry keeps its old hash and description until save lands', async () => {
    await indexAll(root);
    const before = loadCache(cachePath(root)).files['src/main.ts'];
    writeProjectFile(root, 'src/main.ts', 'export const main = 99;\n');

    buildPlan(root);
    const after = loadCache(cachePath(root)).files['src/main.ts'];
    expect(after?.hash).toBe(before?.hash as string);
    expect(after?.description).toBe(before?.description as string);

    // Status must keep reporting the file as stale across repeated plans.
    buildPlan(root);
    expect(getStatus(root).stale).toBe(1);
  });

  test('force on a warm cache: every file batched, new/stale honest from cache presence', async () => {
    await indexAll(root);
    writeProjectFile(root, 'src/extra.ts', 'export const extra = 3;\n');

    const plan = buildPlan(root, { force: true });
    expect(plan.total).toBe(4);
    expect(plan.new).toBe(1);
    expect(plan.stale).toBe(3);
    expect(plan.unchanged).toBe(0);

    const entries = planEntries(plan);
    expect(entries).toHaveLength(4);
    expect(entries.find((e) => e.path === 'src/extra.ts')?.reason).toBe('new');
    expect(entries.find((e) => e.path === 'src/main.ts')?.reason).toBe('stale');

    // Old descriptions survive until the new ones are saved.
    const cache = loadCache(cachePath(root));
    expect(cache.files['src/main.ts']?.description).toBe('stub description for src/main.ts');
  });

  test('force on a cold cache: everything is new', () => {
    const plan = buildPlan(root, { force: true });
    expect(plan.new).toBe(3);
    expect(plan.stale).toBe(0);
    expect(planEntries(plan).every((e) => e.reason === 'new')).toBe(true);
  });

  test('batch size chunks entries and ids are 1-based', () => {
    const plan = buildPlan(root, { batchSize: 2 });
    expect(plan.batches.map((b) => b.id)).toEqual([1, 2]);
    expect(plan.batches[0]?.files).toHaveLength(2);
    expect(plan.batches[1]?.files).toHaveLength(1);
  });

  test('batch size defaults from tools.cafi.config.batch_size', () => {
    // Config sets batch_size: 5 — three files fit one batch.
    const plan = buildPlan(root);
    expect(plan.batches).toHaveLength(1);
  });

  test('empty project: zero totals and no batches', () => {
    const empty = makeProject('empty');
    try {
      const plan = buildPlan(empty);
      expect(plan).toEqual({
        total: 0,
        new: 0,
        stale: 0,
        deleted: [],
        unchanged: 0,
        batches: [],
      });
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test('backfills mtime/size on unchanged entries without touching last_indexed', async () => {
    await indexAll(root);

    // Strip the stat fields to simulate a pre-fast-path cache entry.
    const cache = loadCache(cachePath(root));
    const entry = cache.files['src/main.ts'];
    if (!entry) throw new Error('expected cache entry');
    const lastIndexed = entry.last_indexed;
    entry.mtime_ms = undefined;
    entry.size = undefined;
    saveCache(cachePath(root), { ...cache, version: CACHE_VERSION } as FileCache);

    buildPlan(root);
    const after = loadCache(cachePath(root)).files['src/main.ts'];
    expect(after?.mtime_ms).toBeGreaterThan(0);
    expect(after?.size).toBeGreaterThan(0);
    expect(after?.last_indexed).toBe(lastIndexed as string);
  });
});
