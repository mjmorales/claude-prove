import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  CACHE_FILENAME,
  cachePath,
  clearCache,
  formatIndexForContext,
  getDescription,
  getStatus,
  lookup,
} from './indexer';
import { buildPlan } from './plan';
import { saveDescriptions } from './save';

const FIXTURES_DIR = join(import.meta.dir, '__fixtures__');

function makeProject(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), `cafi-indexer-${prefix}-`));
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

/**
 * Drive the full plan -> describe -> save loop with stub descriptions —
 * the in-process equivalent of what the /prove:index driver session does.
 */
async function indexAll(root: string): Promise<void> {
  const plan = buildPlan(root);
  const files: Record<string, { hash: string; description: string }> = {};
  for (const batch of plan.batches) {
    for (const entry of batch.files) {
      files[entry.path] = { hash: entry.hash, description: `stub description for ${entry.path}` };
    }
  }
  await saveDescriptions(root, { files, deleted: plan.deleted });
}

describe('getStatus', () => {
  let root: string;
  beforeEach(() => {
    root = makeProject('status');
    writeProjectFile(root, 'README.md', '# readme\n');
    writeProjectFile(root, 'src/main.ts', 'export const main = 1;\n');
    writeProjectFile(root, 'src/util.ts', 'export const util = 2;\n');
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('cache_exists is false before any build', () => {
    const status = getStatus(root);
    expect(status.cache_exists).toBe(false);
    expect(status.new).toBe(3);
    expect(status.stale).toBe(0);
    expect(status.deleted).toBe(0);
    expect(status.unchanged).toBe(0);
  });

  test('cache_exists is true after an index pass', async () => {
    await indexAll(root);
    const status = getStatus(root);
    expect(status.cache_exists).toBe(true);
    expect(status.unchanged).toBe(3);
  });

  test('matches pinned ts-captures/status.txt fixture', async () => {
    await indexAll(root);
    const status = getStatus(root);
    const rendered = `${JSON.stringify(status, Object.keys(status).sort(), 2)}\n`;
    const expected = readFileSync(join(FIXTURES_DIR, 'ts-captures', 'status.txt'), 'utf8');
    expect(rendered).toBe(expected);
  });
});

describe('getDescription', () => {
  let root: string;
  beforeEach(() => {
    root = makeProject('getdesc');
    writeProjectFile(root, 'src/main.ts', 'export const main = 1;\n');
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('returns stored description for indexed path', async () => {
    await indexAll(root);
    expect(getDescription(root, 'src/main.ts')).toBe('stub description for src/main.ts');
  });

  test('returns null for unknown path', async () => {
    await indexAll(root);
    expect(getDescription(root, 'does-not-exist.ts')).toBeNull();
  });

  test('returns null when no cache exists', () => {
    expect(getDescription(root, 'src/main.ts')).toBeNull();
  });
});

describe('clearCache', () => {
  let root: string;
  beforeEach(() => {
    root = makeProject('clear');
    writeProjectFile(root, 'src/main.ts', 'export const main = 1;\n');
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('returns true when cache exists and deletes the file', async () => {
    await indexAll(root);
    expect(clearCache(root)).toBe(true);
    expect(clearCache(root)).toBe(false);
  });

  test('returns false when no cache exists', () => {
    expect(clearCache(root)).toBe(false);
  });
});

describe('lookup', () => {
  let root: string;
  beforeEach(() => {
    root = makeProject('lookup');
    writeProjectFile(root, 'README.md', '# readme\n');
    writeProjectFile(root, 'src/main.ts', 'export const main = 1;\n');
    writeProjectFile(root, 'src/util.ts', 'export const util = 2;\n');
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('returns empty list when no cache exists', () => {
    expect(lookup(root, 'anything')).toEqual([]);
  });

  test('case-insensitive match on path', async () => {
    await indexAll(root);
    const hits = lookup(root, 'UTIL');
    expect(hits).toEqual([
      { path: 'src/util.ts', description: 'stub description for src/util.ts' },
    ]);
  });

  test('matches against description text', async () => {
    await indexAll(root);
    // "stub description" appears in every description — all files hit.
    const hits = lookup(root, 'stub description');
    expect(hits.map((h) => h.path)).toEqual(['README.md', 'src/main.ts', 'src/util.ts']);
  });

  test('result order is sorted by path', async () => {
    await indexAll(root);
    const hits = lookup(root, 'stub');
    const paths = hits.map((h) => h.path);
    const sorted = [...paths].sort();
    expect(paths).toEqual(sorted);
  });

  test('matches pinned ts-captures/lookup_util.txt fixture', async () => {
    await indexAll(root);
    const hits = lookup(root, 'util');
    let rendered = '';
    for (const hit of hits) {
      rendered += `${hit.path}\n  ${hit.description}\n`;
    }
    const expected = readFileSync(join(FIXTURES_DIR, 'ts-captures', 'lookup_util.txt'), 'utf8');
    expect(rendered).toBe(expected);
  });
});

describe('formatIndexForContext', () => {
  let root: string;
  beforeEach(() => {
    root = makeProject('context');
    writeProjectFile(root, 'README.md', '# readme\n');
    writeProjectFile(root, 'src/main.ts', 'export const main = 1;\n');
    writeProjectFile(root, 'src/util.ts', 'export const util = 2;\n');
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('returns empty string when no cache exists', () => {
    expect(formatIndexForContext(root)).toBe('');
  });

  test('renders a sorted markdown list after an index pass', async () => {
    await indexAll(root);
    const rendered = formatIndexForContext(root);
    const expected = readFileSync(join(FIXTURES_DIR, 'ts-captures', 'context.txt'), 'utf8');
    expect(rendered).toBe(expected);
  });
});

describe('cachePath', () => {
  test('resolves to .prove/file-index.json under the project root', () => {
    expect(cachePath('/tmp/project')).toBe(`/tmp/project/.prove/${CACHE_FILENAME}`);
    expect(CACHE_FILENAME).toBe('file-index.json');
  });
});
