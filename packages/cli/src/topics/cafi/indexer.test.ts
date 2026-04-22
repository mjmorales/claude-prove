import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setClaudeRunner } from './describer';
import {
  CACHE_FILENAME,
  buildIndex,
  cachePath,
  clearCache,
  formatIndexForContext,
  getDescription,
  getStatus,
  lookup,
} from './indexer';

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
          config: {
            excludes: [],
            max_file_size: 102400,
            concurrency: 1,
            batch_size: 5,
            triage: true,
          },
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

/** Stub runner: returns `stub description for <path>` for every file. */
function stubRunner(): void {
  setClaudeRunner(async (prompt: string) => {
    if (prompt.includes('--- FILE:')) {
      const paths = [...prompt.matchAll(/--- FILE: ([^\s]+) ---/g)].map((m) => m[1] as string);
      const map: Record<string, string> = {};
      for (const p of paths) map[p] = `stub description for ${p}`;
      return JSON.stringify(map);
    }
    const match = prompt.match(/^File path: (.+)$/m);
    const path = match?.[1] ?? 'unknown';
    return `stub description for ${path}`;
  });
}

afterEach(() => {
  setClaudeRunner(null);
});

describe('buildIndex', () => {
  let root: string;
  beforeEach(() => {
    root = makeProject('build');
    writeProjectFile(root, 'README.md', '# readme\n');
    writeProjectFile(root, 'src/main.ts', 'export const main = 1;\n');
    writeProjectFile(root, 'src/util.ts', 'export const util = 2;\n');
    stubRunner();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('first run: all files become new and land in the cache', async () => {
    const summary = await buildIndex(root);
    expect(summary.new).toBe(3);
    expect(summary.stale).toBe(0);
    expect(summary.deleted).toBe(0);
    expect(summary.unchanged).toBe(0);
    expect(summary.total).toBe(3);
    expect(summary.errors).toBe(0);

    const cache = JSON.parse(readFileSync(cachePath(root), 'utf8'));
    expect(cache.version).toBe(1);
    expect(Object.keys(cache.files).sort()).toEqual(['README.md', 'src/main.ts', 'src/util.ts']);
    expect(cache.files['src/main.ts'].description).toBe('stub description for src/main.ts');
    expect(cache.files['src/main.ts'].hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('second run with no changes: everything unchanged, no re-description', async () => {
    await buildIndex(root);
    let cliCalls = 0;
    setClaudeRunner(async () => {
      cliCalls++;
      return '{}';
    });
    const summary = await buildIndex(root);
    expect(summary.new).toBe(0);
    expect(summary.stale).toBe(0);
    expect(summary.unchanged).toBe(3);
    expect(cliCalls).toBe(0);
  });

  test('after editing a file, it shows up as stale and is re-described', async () => {
    await buildIndex(root);
    writeProjectFile(root, 'src/main.ts', 'export const main = 99;\n');
    stubRunner();
    const summary = await buildIndex(root);
    expect(summary.new).toBe(0);
    expect(summary.stale).toBe(1);
    expect(summary.unchanged).toBe(2);
  });

  test('force: every file is re-described even when hashes match', async () => {
    await buildIndex(root);
    let cliCalls = 0;
    setClaudeRunner(async (prompt) => {
      cliCalls++;
      const paths = [...prompt.matchAll(/--- FILE: ([^\s]+) ---/g)].map((m) => m[1] as string);
      const map: Record<string, string> = {};
      for (const p of paths) map[p] = `forced ${p}`;
      return JSON.stringify(map);
    });
    const summary = await buildIndex(root, { force: true });
    expect(summary.new).toBe(0);
    expect(summary.stale).toBe(3);
    expect(summary.unchanged).toBe(0);
    expect(cliCalls).toBeGreaterThan(0);
    expect(getDescription(root, 'src/main.ts')).toBe('forced src/main.ts');
  });

  test('counts empty descriptions as errors', async () => {
    setClaudeRunner(async () => {
      throw new Error('boom');
    });
    const summary = await buildIndex(root);
    expect(summary.errors).toBe(3);
  });
});

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

  test('cache_exists is true after buildIndex', async () => {
    stubRunner();
    await buildIndex(root);
    const status = getStatus(root);
    expect(status.cache_exists).toBe(true);
    expect(status.unchanged).toBe(3);
  });

  test('matches pinned ts-captures/status.txt fixture', async () => {
    stubRunner();
    await buildIndex(root);
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
    stubRunner();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('returns stored description for indexed path', async () => {
    await buildIndex(root);
    expect(getDescription(root, 'src/main.ts')).toBe('stub description for src/main.ts');
  });

  test('returns null for unknown path', async () => {
    await buildIndex(root);
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
    stubRunner();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('returns true when cache exists and deletes the file', async () => {
    await buildIndex(root);
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
    stubRunner();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('returns empty list when no cache exists', () => {
    expect(lookup(root, 'anything')).toEqual([]);
  });

  test('case-insensitive match on path', async () => {
    await buildIndex(root);
    const hits = lookup(root, 'UTIL');
    expect(hits).toEqual([
      { path: 'src/util.ts', description: 'stub description for src/util.ts' },
    ]);
  });

  test('matches against description text', async () => {
    await buildIndex(root);
    // "stub description" appears in every description — all files hit.
    const hits = lookup(root, 'stub description');
    expect(hits.map((h) => h.path)).toEqual(['README.md', 'src/main.ts', 'src/util.ts']);
  });

  test('result order is sorted by path', async () => {
    await buildIndex(root);
    const hits = lookup(root, 'stub');
    const paths = hits.map((h) => h.path);
    const sorted = [...paths].sort();
    expect(paths).toEqual(sorted);
  });

  test('matches pinned ts-captures/lookup_util.txt fixture', async () => {
    await buildIndex(root);
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
    stubRunner();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('returns empty string when no cache exists', () => {
    expect(formatIndexForContext(root)).toBe('');
  });

  test('renders a sorted markdown list after buildIndex', async () => {
    await buildIndex(root);
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
