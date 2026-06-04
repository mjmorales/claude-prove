import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveDbPath } from './paths';
import { list } from './project-registry';

function makeTmpGitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'store-paths-'));
  mkdirSync(join(root, '.git'), { recursive: true });
  return root;
}

// Resolving a git root fires a best-effort project-registry upsert. Redirect
// its base dir to a tmp home so the test never writes the developer's real
// `~/.claude-prove/projects.json`.
let registryHome: string;
let priorRegistryHome: string | undefined;

beforeAll(() => {
  registryHome = mkdtempSync(join(tmpdir(), 'store-paths-home-'));
  priorRegistryHome = process.env.CLAUDE_PROVE_HOME;
  process.env.CLAUDE_PROVE_HOME = registryHome;
});

afterAll(() => {
  // Assigning `undefined` to an env var stringifies to "undefined" rather than
  // unsetting it, so `delete` is the correct restore when the var was unset.
  // biome-ignore lint/performance/noDelete: env restore must truly unset, not stringify
  if (priorRegistryHome === undefined) delete process.env.CLAUDE_PROVE_HOME;
  else process.env.CLAUDE_PROVE_HOME = priorRegistryHome;
  rmSync(registryHome, { recursive: true, force: true });
});

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

  test('git-root resolution registers the repo in the project registry', () => {
    const root = makeTmpGitRepo();
    try {
      resolveDbPath({ cwd: root });
      const entries = list(registryHome);
      expect(entries.some((e) => e.path === root)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('override path does NOT register (no git-root identity)', () => {
    const before = list(registryHome).length;
    resolveDbPath({ override: '/tmp/some-explicit.db' });
    expect(list(registryHome).length).toBe(before);
  });
});
