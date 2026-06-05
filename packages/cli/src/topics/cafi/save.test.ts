import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadCache } from '@claude-prove/shared';
import { cachePath } from './indexer';
import { buildPlan } from './plan';
import {
  MAX_DESCRIPTION_LENGTH,
  SavePayloadError,
  parseSavePayload,
  saveDescriptions,
} from './save';

function makeProject(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), `cafi-save-${prefix}-`));
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

/** Hash of one planned file, taken from a fresh buildPlan. */
function plannedHash(root: string, path: string): string {
  const entry = buildPlan(root, { force: true })
    .batches.flatMap((b) => b.files)
    .find((f) => f.path === path);
  if (!entry) throw new Error(`not in plan: ${path}`);
  return entry.hash;
}

describe('parseSavePayload', () => {
  test('parses a well-formed payload and defaults missing keys', () => {
    const payload = parseSavePayload(
      JSON.stringify({ files: { 'a.ts': { hash: 'h', description: 'd' } } }),
    );
    expect(payload.files['a.ts']).toEqual({ hash: 'h', description: 'd' });
    expect(payload.deleted).toEqual([]);
    expect(parseSavePayload('{}')).toEqual({ files: {}, deleted: [] });
  });

  test('rejects non-JSON, non-object, and malformed shapes', () => {
    expect(() => parseSavePayload('not json')).toThrow(SavePayloadError);
    expect(() => parseSavePayload('[1,2]')).toThrow(SavePayloadError);
    expect(() => parseSavePayload(JSON.stringify({ files: [] }))).toThrow(SavePayloadError);
    expect(() => parseSavePayload(JSON.stringify({ files: { 'a.ts': 'nope' } }))).toThrow(
      SavePayloadError,
    );
    expect(() => parseSavePayload(JSON.stringify({ files: { 'a.ts': { hash: 1 } } }))).toThrow(
      SavePayloadError,
    );
    expect(() => parseSavePayload(JSON.stringify({ deleted: 'a.ts' }))).toThrow(SavePayloadError);
    expect(() => parseSavePayload(JSON.stringify({ deleted: [1] }))).toThrow(SavePayloadError);
  });
});

describe('saveDescriptions', () => {
  let root: string;
  beforeEach(() => {
    root = makeProject('save');
    writeProjectFile(root, 'src/main.ts', 'export const main = 1;\n');
    writeProjectFile(root, 'src/util.ts', 'export const util = 2;\n');
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('happy merge: descriptions land with hash, timestamps, and stat fields', async () => {
    const hash = plannedHash(root, 'src/main.ts');
    const result = await saveDescriptions(root, {
      files: { 'src/main.ts': { hash, description: 'the main entry point' } },
      deleted: [],
    });
    expect(result).toEqual({ saved: 1, pruned: 0, rejected: [] });

    const entry = loadCache(cachePath(root)).files['src/main.ts'];
    expect(entry?.description).toBe('the main entry point');
    expect(entry?.hash).toBe(hash);
    expect(entry?.last_indexed).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(entry?.mtime_ms).toBeGreaterThan(0);
    expect(entry?.size).toBeGreaterThan(0);
  });

  test('description whitespace is trimmed before storing', async () => {
    const hash = plannedHash(root, 'src/main.ts');
    await saveDescriptions(root, {
      files: { 'src/main.ts': { hash, description: '  padded  \n' } },
      deleted: [],
    });
    expect(loadCache(cachePath(root)).files['src/main.ts']?.description).toBe('padded');
  });

  test('hash drift: content changed since describe -> rejected, cache untouched', async () => {
    const hash = plannedHash(root, 'src/main.ts');
    writeProjectFile(root, 'src/main.ts', 'export const main = 99;\n');

    const result = await saveDescriptions(root, {
      files: { 'src/main.ts': { hash, description: 'stale description' } },
      deleted: [],
    });
    expect(result.saved).toBe(0);
    expect(result.rejected).toEqual([{ path: 'src/main.ts', reason: 'hash-drift' }]);
    expect(loadCache(cachePath(root)).files['src/main.ts']).toBeUndefined();
  });

  test('missing file on disk -> rejected as deleted', async () => {
    const result = await saveDescriptions(root, {
      files: { 'src/gone.ts': { hash: 'a'.repeat(64), description: 'ghost' } },
      deleted: [],
    });
    expect(result.rejected).toEqual([{ path: 'src/gone.ts', reason: 'deleted' }]);
  });

  test('empty and over-cap descriptions are rejected', async () => {
    const hash = plannedHash(root, 'src/main.ts');
    const result = await saveDescriptions(root, {
      files: {
        'src/main.ts': { hash, description: '   ' },
        'src/util.ts': {
          hash: plannedHash(root, 'src/util.ts'),
          description: 'x'.repeat(MAX_DESCRIPTION_LENGTH + 1),
        },
      },
      deleted: [],
    });
    expect(result.saved).toBe(0);
    expect(result.rejected.map((r) => r.reason)).toEqual([
      'invalid-description',
      'invalid-description',
    ]);
  });

  test('absolute and root-escaping paths are rejected', async () => {
    const result = await saveDescriptions(root, {
      files: {
        '/etc/passwd': { hash: 'a'.repeat(64), description: 'nope' },
        '../outside.ts': { hash: 'a'.repeat(64), description: 'nope' },
      },
      deleted: ['/etc/passwd'],
    });
    expect(result.saved).toBe(0);
    expect(result.pruned).toBe(0);
    expect(result.rejected.map((r) => r.reason)).toEqual(['invalid-path', 'invalid-path']);
  });

  test('partial acceptance: valid files save even when others are rejected', async () => {
    const goodHash = plannedHash(root, 'src/util.ts');
    const result = await saveDescriptions(root, {
      files: {
        'src/util.ts': { hash: goodHash, description: 'small utilities' },
        'src/main.ts': { hash: 'f'.repeat(64), description: 'drifted' },
      },
      deleted: [],
    });
    expect(result.saved).toBe(1);
    expect(result.rejected).toEqual([{ path: 'src/main.ts', reason: 'hash-drift' }]);
    expect(loadCache(cachePath(root)).files['src/util.ts']?.description).toBe('small utilities');
  });

  test('untouched cache entries survive a merge', async () => {
    const mainHash = plannedHash(root, 'src/main.ts');
    const utilHash = plannedHash(root, 'src/util.ts');
    await saveDescriptions(root, {
      files: { 'src/main.ts': { hash: mainHash, description: 'main' } },
      deleted: [],
    });
    await saveDescriptions(root, {
      files: { 'src/util.ts': { hash: utilHash, description: 'util' } },
      deleted: [],
    });
    const files = loadCache(cachePath(root)).files;
    expect(files['src/main.ts']?.description).toBe('main');
    expect(files['src/util.ts']?.description).toBe('util');
  });

  test('prunes deleted entries only when still absent from disk', async () => {
    const mainHash = plannedHash(root, 'src/main.ts');
    const utilHash = plannedHash(root, 'src/util.ts');
    await saveDescriptions(root, {
      files: {
        'src/main.ts': { hash: mainHash, description: 'main' },
        'src/util.ts': { hash: utilHash, description: 'util' },
      },
      deleted: [],
    });

    rmSync(join(root, 'src/util.ts'));
    const result = await saveDescriptions(root, {
      files: {},
      // util.ts is genuinely gone; main.ts "reappeared" (still on disk) and
      // must keep its entry despite being listed.
      deleted: ['src/util.ts', 'src/main.ts', 'never-indexed.ts'],
    });
    expect(result.pruned).toBe(1);

    const files = loadCache(cachePath(root)).files;
    expect(files['src/util.ts']).toBeUndefined();
    expect(files['src/main.ts']?.description).toBe('main');
  });

  test('empty payload is a no-op', async () => {
    const result = await saveDescriptions(root, { files: {}, deleted: [] });
    expect(result).toEqual({ saved: 0, pruned: 0, rejected: [] });
    expect(loadCache(cachePath(root)).files).toEqual({});
  });
});
