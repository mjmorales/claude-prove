import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalSettingsParseError, writeLocalEnv } from '../src/write-local-env';

let dir: string;
let settingsPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'installer-local-env-'));
  settingsPath = join(dir, 'settings.local.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function readJson(): Record<string, unknown> {
  return JSON.parse(readFileSync(settingsPath, 'utf8'));
}

describe('writeLocalEnv', () => {
  test('scaffolds the file with the env entry when missing', () => {
    expect(writeLocalEnv(settingsPath, '/Users/alice/dev/claude-prove')).toBe(true);
    expect(readJson()).toEqual({
      env: { CLAUDE_PROVE_PLUGIN_DIR: '/Users/alice/dev/claude-prove' },
    });
  });

  test('preserves unrelated top-level keys and other env vars', () => {
    writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          permissions: { allow: ['Bash(ls)'] },
          env: { OTHER: 'kept' },
        },
        null,
        2,
      ),
      'utf8',
    );
    expect(writeLocalEnv(settingsPath, '/Users/bob/prove')).toBe(true);
    expect(readJson()).toEqual({
      permissions: { allow: ['Bash(ls)'] },
      env: { OTHER: 'kept', CLAUDE_PROVE_PLUGIN_DIR: '/Users/bob/prove' },
    });
  });

  test('rewrites a stale value', () => {
    writeLocalEnv(settingsPath, '/old/path');
    expect(writeLocalEnv(settingsPath, '/new/path')).toBe(true);
    expect((readJson().env as Record<string, string>).CLAUDE_PROVE_PLUGIN_DIR).toBe('/new/path');
  });

  test('no-ops when the value is already current', () => {
    writeLocalEnv(settingsPath, '/same/path');
    const before = readFileSync(settingsPath, 'utf8');
    expect(writeLocalEnv(settingsPath, '/same/path')).toBe(false);
    expect(readFileSync(settingsPath, 'utf8')).toBe(before);
  });

  test('throws LocalSettingsParseError on malformed JSON without writing', () => {
    writeFileSync(settingsPath, '{not json', 'utf8');
    expect(() => writeLocalEnv(settingsPath, '/x')).toThrow(LocalSettingsParseError);
    expect(readFileSync(settingsPath, 'utf8')).toBe('{not json');
    expect(existsSync(`${settingsPath}.tmp`)).toBe(false);
  });

  test('ends the file with a trailing newline', () => {
    writeLocalEnv(settingsPath, '/x');
    expect(readFileSync(settingsPath, 'utf8').endsWith('}\n')).toBe(true);
  });
});
