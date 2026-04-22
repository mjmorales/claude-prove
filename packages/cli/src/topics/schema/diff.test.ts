/**
 * Unit tests for diff.ts — `configDiff` + `summary`.
 *
 * Covers the four branches of the Python source:
 *   - file-not-found -> `File not found: <path>`
 *   - cannot-detect-schema -> `Cannot auto-detect schema for <path>`
 *   - prove config needing migration -> `Migration Changes:` + target JSON
 *   - prove config at CURRENT_SCHEMA_VERSION -> `Config is up to date`
 *   - settings config with no issues -> `Config is valid`
 *
 * End-to-end CLI parity against Python captures lives in
 * `integration.test.ts`. These tests pin the in-process function surface.
 */

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configDiff, summary } from './diff';
import { CURRENT_SCHEMA_VERSION } from './schemas';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'diff-test-'));
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value));
}

describe('configDiff', () => {
  test('missing file returns sentinel', () => {
    expect(configDiff('/definitely/not/a/real/path/.prove.json')).toBe(
      'File not found: /definitely/not/a/real/path/.prove.json',
    );
  });

  test('unknown filename bails out with explicit message', () => {
    const dir = tmp();
    try {
      const path = join(dir, 'something.json');
      writeJson(path, {});
      expect(configDiff(path)).toBe(`Cannot auto-detect schema for ${path}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('prove config at current version renders up-to-date line', () => {
    const dir = tmp();
    try {
      const path = join(dir, '.prove.json');
      writeJson(path, { schema_version: CURRENT_SCHEMA_VERSION });
      const out = configDiff(path);
      expect(out).toContain('=== Config Diff: .claude/.prove.json ===');
      expect(out).toContain('Config is up to date (no migration needed).');
      expect(out).not.toContain('Migration Changes:');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('prove config needing migration renders plan + target JSON', () => {
    const dir = tmp();
    try {
      const path = join(dir, '.prove.json');
      writeJson(path, { validators: [] });
      const out = configDiff(path);

      expect(out).toContain('Migration Changes:');
      expect(out).toContain('Target config after migration:');
      expect(out).toContain(`"schema_version": "${CURRENT_SCHEMA_VERSION}"`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('settings config with no issues renders valid line', () => {
    const dir = tmp();
    try {
      const claudeDir = join(dir, '.claude');
      mkdirSync(claudeDir);
      const path = join(claudeDir, 'settings.json');
      writeJson(path, {});
      const out = configDiff(path);

      expect(out).toContain('=== Config Diff: .claude/settings.json ===');
      expect(out).toContain('Config is valid (no issues found).');
      expect(out).not.toContain('Migration Changes:');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('summary', () => {
  test('missing files render the /prove:init placeholder', () => {
    const out = summary('/does/not/exist/.prove.json', '/does/not/exist/settings.json');
    expect(out).toContain('=== /does/not/exist/.prove.json ===');
    expect(out).toContain('Not found (will be created by /prove:init)');
    expect(out).toContain('=== /does/not/exist/settings.json ===');
    expect(out.split('\n\n').length).toBeGreaterThanOrEqual(2);
  });

  test('existing files render configDiff concatenated with a blank line', () => {
    const dir = tmp();
    try {
      const claudeDir = join(dir, '.claude');
      mkdirSync(claudeDir);
      const provePath = join(claudeDir, '.prove.json');
      const settingsPath = join(claudeDir, 'settings.json');
      writeJson(provePath, { schema_version: CURRENT_SCHEMA_VERSION });
      writeJson(settingsPath, {});

      const out = summary(provePath, settingsPath);
      expect(out).toContain('Config is up to date (no migration needed).');
      expect(out).toContain('Config is valid (no issues found).');
      expect(out).toContain(
        'Config is up to date (no migration needed).\n\n=== Config Diff: .claude/settings.json ===',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
