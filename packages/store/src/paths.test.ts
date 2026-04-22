import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveDbPath } from './paths';

function makeTmpGitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'store-paths-'));
  mkdirSync(join(root, '.git'), { recursive: true });
  return root;
}

describe('resolveDbPath', () => {
  test('returns <git-root>/.prove/prove.db for the happy path', () => {
    const root = makeTmpGitRepo();
    try {
      const nested = join(root, 'a', 'b', 'c');
      mkdirSync(nested, { recursive: true });
      expect(resolveDbPath({ cwd: nested })).toBe(join(root, '.prove', 'prove.db'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('throws with the starting cwd when no .git is found', () => {
    const rootless = mkdtempSync(join(tmpdir(), 'store-paths-rootless-'));
    try {
      // mktemp under macOS lands in /private/var/..., also no .git above.
      expect(() => resolveDbPath({ cwd: rootless })).toThrow(rootless);
    } finally {
      rmSync(rootless, { recursive: true, force: true });
    }
  });

  test('override short-circuits git-root discovery', () => {
    expect(resolveDbPath({ override: '/tmp/override.db' })).toBe('/tmp/override.db');
  });
});
