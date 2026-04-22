import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FileCache } from '@claude-prove/shared';
import { CACHE_VERSION } from '@claude-prove/shared';
import { computeHash, diffCache } from './hasher';

function makeTmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `cafi-hasher-${prefix}-`));
}

describe('computeHash', () => {
  test('matches SHA-256 of exact byte content', () => {
    const tmp = makeTmpDir('content');
    try {
      const content = 'hello world\n';
      const path = join(tmp, 'a.txt');
      writeFileSync(path, content);
      const expected = createHash('sha256').update(content).digest('hex');
      expect(computeHash(path)).toBe(expected);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('produces identical hashes for identical content', () => {
    const tmp = makeTmpDir('equal');
    try {
      const a = join(tmp, 'a.txt');
      const b = join(tmp, 'b.txt');
      writeFileSync(a, 'same bytes');
      writeFileSync(b, 'same bytes');
      expect(computeHash(a)).toBe(computeHash(b));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('produces distinct hashes for distinct content', () => {
    const tmp = makeTmpDir('distinct');
    try {
      const a = join(tmp, 'a.txt');
      const b = join(tmp, 'b.txt');
      writeFileSync(a, 'content one');
      writeFileSync(b, 'content two');
      expect(computeHash(a)).not.toBe(computeHash(b));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('handles empty file', () => {
    const tmp = makeTmpDir('empty');
    try {
      const path = join(tmp, 'empty.txt');
      writeFileSync(path, '');
      const expected = createHash('sha256').update('').digest('hex');
      expect(computeHash(path)).toBe(expected);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('handles files larger than a single chunk', () => {
    const tmp = makeTmpDir('big');
    try {
      const path = join(tmp, 'big.bin');
      const content = 'x'.repeat(20000); // > 8 KiB so we cross chunk boundary
      writeFileSync(path, content);
      const expected = createHash('sha256').update(content).digest('hex');
      expect(computeHash(path)).toBe(expected);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('diffCache', () => {
  test('categorises new, stale, deleted, and unchanged files', () => {
    const currentFiles = {
      'new_file.py': 'aaa111',
      'changed.py': 'bbb222_new',
      'same.py': 'ccc333',
    };
    const cache: FileCache = {
      version: CACHE_VERSION,
      files: {
        'changed.py': {
          hash: 'bbb222_old',
          description: '',
          last_indexed: '2025-01-01T00:00:00Z',
        },
        'same.py': {
          hash: 'ccc333',
          description: '',
          last_indexed: '2025-01-01T00:00:00Z',
        },
        'deleted.py': {
          hash: 'ddd444',
          description: '',
          last_indexed: '2025-01-01T00:00:00Z',
        },
      },
    };

    const result = diffCache(currentFiles, cache);

    expect(result.new).toEqual(['new_file.py']);
    expect(result.stale).toEqual(['changed.py']);
    expect(result.deleted).toEqual(['deleted.py']);
    expect(result.unchanged).toEqual(['same.py']);
  });

  test('treats empty cache as all-new', () => {
    const currentFiles = { 'b.py': 'hash_b', 'a.py': 'hash_a' };
    const cache: FileCache = { version: CACHE_VERSION, files: {} };
    const result = diffCache(currentFiles, cache);
    expect(result.new).toEqual(['a.py', 'b.py']);
    expect(result.stale).toEqual([]);
    expect(result.deleted).toEqual([]);
    expect(result.unchanged).toEqual([]);
  });

  test('treats empty current as all-deleted', () => {
    const cache: FileCache = {
      version: CACHE_VERSION,
      files: {
        'old.py': { hash: 'xxx', description: '', last_indexed: '2025-01-01T00:00:00Z' },
      },
    };
    const result = diffCache({}, cache);
    expect(result.new).toEqual([]);
    expect(result.stale).toEqual([]);
    expect(result.deleted).toEqual(['old.py']);
    expect(result.unchanged).toEqual([]);
  });

  test('returns sorted output across every category', () => {
    const currentFiles = {
      'z.py': 'zhash',
      'a.py': 'ahash',
      'm.py': 'mnew',
    };
    const cache: FileCache = {
      version: CACHE_VERSION,
      files: {
        'm.py': { hash: 'mold', description: '', last_indexed: 't' },
        'gone_z.py': { hash: 'gz', description: '', last_indexed: 't' },
        'gone_a.py': { hash: 'ga', description: '', last_indexed: 't' },
      },
    };
    const result = diffCache(currentFiles, cache);
    // new + deleted + stale + unchanged are each sorted ascending
    expect(result.new).toEqual(['a.py', 'z.py']);
    expect(result.deleted).toEqual(['gone_a.py', 'gone_z.py']);
    expect(result.stale).toEqual(['m.py']);
    expect(result.unchanged).toEqual([]);
  });
});
