import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectMode, isCompiledEntrypoint, runningFromCompiledBinary } from '../src/detect-mode';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEV_FIXTURE = join(HERE, '__fixtures__', 'dev-plugin');
const COMPILED_FIXTURE = join(HERE, '__fixtures__', 'compiled-plugin');

describe('detectMode', () => {
  test("returns 'dev' when packages/cli/src/ exists under pluginRoot", () => {
    expect(detectMode(DEV_FIXTURE)).toBe('dev');
  });

  test("returns 'compiled' when packages/cli/src/ is absent", () => {
    expect(detectMode(COMPILED_FIXTURE)).toBe('compiled');
  });

  test("returns 'compiled' for an existing directory with no packages tree", () => {
    const empty = mkdtempSync(join(tmpdir(), 'installer-detect-mode-'));
    try {
      expect(detectMode(empty)).toBe('compiled');
    } finally {
      rmSync(empty, { recursive: true, force: true });
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
