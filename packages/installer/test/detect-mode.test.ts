import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectMode } from '../src/detect-mode';

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
