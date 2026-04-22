import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CACHE_VERSION, type FileCache, loadCache, saveCache } from './cache';

function makeTmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `cache-${prefix}-`));
}

describe('loadCache', () => {
  test('returns empty default when file is missing', () => {
    const tmp = makeTmpDir('missing');
    try {
      const cache = loadCache(join(tmp, 'does-not-exist.json'));
      expect(cache).toEqual({ version: CACHE_VERSION, files: {} });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('returns empty default when JSON is malformed', () => {
    const tmp = makeTmpDir('corrupt');
    try {
      const path = join(tmp, 'cache.json');
      writeFileSync(path, 'not json{{{', 'utf8');
      expect(loadCache(path)).toEqual({ version: CACHE_VERSION, files: {} });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('returns empty default when version is wrong', () => {
    const tmp = makeTmpDir('wrongver');
    try {
      const path = join(tmp, 'cache.json');
      writeFileSync(path, JSON.stringify({ version: 999, files: {} }), 'utf8');
      expect(loadCache(path)).toEqual({ version: CACHE_VERSION, files: {} });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('returns parsed data when version matches', () => {
    const tmp = makeTmpDir('ok');
    try {
      const path = join(tmp, 'cache.json');
      const data: FileCache = {
        version: CACHE_VERSION,
        files: {
          'foo.py': {
            hash: 'abc',
            description: 'x',
            last_indexed: '2025-06-01T00:00:00Z',
          },
        },
      };
      writeFileSync(path, JSON.stringify(data), 'utf8');
      expect(loadCache(path)).toEqual(data);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('saveCache', () => {
  test('round-trips through loadCache', () => {
    const tmp = makeTmpDir('rt');
    try {
      const path = join(tmp, 'file-index.json');
      const cache: FileCache = {
        version: CACHE_VERSION,
        files: {
          'foo.py': {
            hash: 'abc123',
            description: 'a module',
            last_indexed: '2025-06-01T00:00:00Z',
          },
        },
      };
      saveCache(path, cache);
      expect(loadCache(path)).toEqual(cache);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('emits keys in sorted order at every depth', () => {
    const tmp = makeTmpDir('sort');
    try {
      const path = join(tmp, 'cache.json');
      // Insert keys in reverse order to prove the sort is real.
      const cache: FileCache = {
        version: CACHE_VERSION,
        files: {
          'z.py': {
            last_indexed: '2025-01-01T00:00:00Z',
            hash: 'z',
            description: 'last',
          },
          'a.py': {
            last_indexed: '2025-01-01T00:00:00Z',
            hash: 'a',
            description: 'first',
          },
        },
      };
      saveCache(path, cache);
      const onDisk = readFileSync(path, 'utf8');

      // Python's json.dump(..., indent=2, sort_keys=True) + trailing newline.
      const expected = `${JSON.stringify(
        {
          files: {
            'a.py': { description: 'first', hash: 'a', last_indexed: '2025-01-01T00:00:00Z' },
            'z.py': { description: 'last', hash: 'z', last_indexed: '2025-01-01T00:00:00Z' },
          },
          version: CACHE_VERSION,
        },
        null,
        2,
      )}\n`;
      expect(onDisk).toBe(expected);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('writes atomically: no stray temp files remain on success', () => {
    const tmp = makeTmpDir('atomic');
    try {
      const path = join(tmp, 'cache.json');
      saveCache(path, { version: CACHE_VERSION, files: {} });
      const entries = readdirSync(tmp);
      // Only the final file should be present — no leftover `.file-index-*` tmp dir.
      expect(entries).toEqual(['cache.json']);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('creates parent directory if missing', () => {
    const tmp = makeTmpDir('mkdir');
    try {
      const path = join(tmp, 'nested', 'dir', 'cache.json');
      saveCache(path, { version: CACHE_VERSION, files: {} });
      expect(loadCache(path)).toEqual({ version: CACHE_VERSION, files: {} });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
