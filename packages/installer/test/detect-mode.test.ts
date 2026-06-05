import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectMode, isCompiledEntrypoint, runningFromCompiledBinary } from '../src/detect-mode';

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPILED_FIXTURE = join(HERE, '__fixtures__', 'compiled-plugin');

/**
 * Build a plugin-root shape in a tmp dir. `node_modules/` is gitignored, so
 * the runnable-checkout shape cannot live as a committed fixture — each test
 * constructs exactly the tree it classifies.
 */
function makePluginRoot(opts: { sources: boolean; workspaceDeps: boolean }): string {
  const root = mkdtempSync(join(tmpdir(), 'installer-detect-mode-'));
  if (opts.sources) {
    mkdirSync(join(root, 'packages', 'cli', 'src'), { recursive: true });
  }
  if (opts.workspaceDeps) {
    mkdirSync(join(root, 'node_modules', '@claude-prove', 'shared'), { recursive: true });
  }
  return root;
}

describe('detectMode', () => {
  test("returns 'dev' for a runnable checkout (sources + workspace deps)", () => {
    const root = makePluginRoot({ sources: true, workspaceDeps: true });
    try {
      expect(detectMode(root)).toBe('dev');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns 'compiled' for a marketplace clone (sources, no workspace deps)", () => {
    const root = makePluginRoot({ sources: true, workspaceDeps: false });
    try {
      expect(detectMode(root)).toBe('compiled');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns 'compiled' when packages/cli/src/ is absent", () => {
    expect(detectMode(COMPILED_FIXTURE)).toBe('compiled');
  });

  test("returns 'compiled' for an existing directory with no packages tree", () => {
    const root = makePluginRoot({ sources: false, workspaceDeps: false });
    try {
      expect(detectMode(root)).toBe('compiled');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('throws when pluginRoot is empty', () => {
    expect(() => detectMode('')).toThrow(/non-empty/);
  });
});

describe('isCompiledEntrypoint', () => {
  test('recognizes the POSIX bunfs virtual-filesystem marker', () => {
    expect(isCompiledEntrypoint('file:///$bunfs/root/run.js')).toBe(true);
    expect(isCompiledEntrypoint('/$bunfs/root/claude-prove')).toBe(true);
  });

  test('recognizes the Windows compiled-binary marker', () => {
    expect(isCompiledEntrypoint('B:/~BUN/root/run.js')).toBe(true);
  });

  test('rejects real filesystem paths and module URLs', () => {
    expect(isCompiledEntrypoint('/Users/dev/claude-prove/packages/cli/bin/run.ts')).toBe(false);
    expect(isCompiledEntrypoint('file:///home/dev/repo/src/detect-mode.ts')).toBe(false);
    expect(isCompiledEntrypoint('')).toBe(false);
  });
});

describe('runningFromCompiledBinary', () => {
  test('is false under the test runner (sources, not a compiled binary)', () => {
    expect(runningFromCompiledBinary()).toBe(false);
  });
});
