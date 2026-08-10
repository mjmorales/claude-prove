import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalSettingsParseError } from '../src/write-local-env';
import {
  diffModelSettings,
  hasModelDeclarations,
  writeModelSettings,
} from '../src/write-model-settings';

let dir: string;
let settingsPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'installer-model-settings-'));
  settingsPath = join(dir, 'settings.local.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function readJson(): Record<string, unknown> {
  return JSON.parse(readFileSync(settingsPath, 'utf8'));
}

describe('writeModelSettings', () => {
  test('scaffolds the file with every mapped key when missing', () => {
    const result = writeModelSettings(settingsPath, {
      main: 'opusplan',
      advisor: 'opus',
      fallback: ['sonnet', 'haiku'],
      effort: 'high',
    });
    expect(result.wrote).toBe(true);
    expect(result.applied).toEqual([
      'model',
      'advisorModel',
      'fallbackModel',
      'env.CLAUDE_CODE_EFFORT_LEVEL',
    ]);
    expect(readJson()).toEqual({
      model: 'opusplan',
      advisorModel: 'opus',
      fallbackModel: ['sonnet', 'haiku'],
      env: { CLAUDE_CODE_EFFORT_LEVEL: 'high' },
    });
  });

  test('preserves unrelated top-level keys and other env vars', () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        permissions: { allow: ['Bash(ls)'] },
        env: { CLAUDE_PROVE_PLUGIN_DIR: '/kept' },
      }),
      'utf8',
    );
    writeModelSettings(settingsPath, { main: 'opusplan', effort: 'xhigh' });
    expect(readJson()).toEqual({
      permissions: { allow: ['Bash(ls)'] },
      env: { CLAUDE_PROVE_PLUGIN_DIR: '/kept', CLAUDE_CODE_EFFORT_LEVEL: 'xhigh' },
      model: 'opusplan',
    });
  });

  test('undeclared fields never touch their settings keys', () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({ model: 'sonnet', advisorModel: 'opus', fallbackModel: ['haiku'] }),
      'utf8',
    );
    const result = writeModelSettings(settingsPath, { advisor: 'sonnet' });
    expect(result.applied).toEqual(['advisorModel']);
    expect(readJson()).toEqual({
      model: 'sonnet',
      advisorModel: 'sonnet',
      fallbackModel: ['haiku'],
    });
  });

  test('no-ops when every declared value is already current', () => {
    writeModelSettings(settingsPath, { main: 'opusplan', fallback: ['sonnet'] });
    const before = readFileSync(settingsPath, 'utf8');
    const result = writeModelSettings(settingsPath, { main: 'opusplan', fallback: ['sonnet'] });
    expect(result.wrote).toBe(false);
    expect(result.applied).toEqual([]);
    expect(result.inSync).toEqual(['model', 'fallbackModel']);
    expect(readFileSync(settingsPath, 'utf8')).toBe(before);
  });

  test('empty-string and empty-array fields are treated as undeclared', () => {
    const result = writeModelSettings(settingsPath, { main: '', advisor: '', fallback: [] });
    expect(result.wrote).toBe(false);
    expect(result.applied).toEqual([]);
  });

  test('rewrites a stale fallback chain', () => {
    writeModelSettings(settingsPath, { fallback: ['sonnet'] });
    const result = writeModelSettings(settingsPath, { fallback: ['sonnet', 'haiku'] });
    expect(result.applied).toEqual(['fallbackModel']);
    expect(readJson().fallbackModel).toEqual(['sonnet', 'haiku']);
  });

  test('throws LocalSettingsParseError on malformed JSON without writing', () => {
    writeFileSync(settingsPath, '{ not json', 'utf8');
    expect(() => writeModelSettings(settingsPath, { main: 'opusplan' })).toThrow(
      LocalSettingsParseError,
    );
    expect(readFileSync(settingsPath, 'utf8')).toBe('{ not json');
  });
});

describe('diffModelSettings', () => {
  test('reports every declared key as drifted against a missing file', () => {
    expect(
      diffModelSettings(settingsPath, {
        main: 'opusplan',
        advisor: 'opus',
        fallback: ['sonnet'],
        effort: 'high',
      }),
    ).toEqual(['model', 'advisorModel', 'fallbackModel', 'env.CLAUDE_CODE_EFFORT_LEVEL']);
  });

  test('reports only stale keys against a partially materialized file', () => {
    writeModelSettings(settingsPath, { main: 'opusplan', advisor: 'sonnet' });
    expect(diffModelSettings(settingsPath, { main: 'opusplan', advisor: 'opus' })).toEqual([
      'advisorModel',
    ]);
  });

  test('reports nothing when fully materialized', () => {
    const models = { main: 'opusplan', fallback: ['sonnet'], effort: 'max' };
    writeModelSettings(settingsPath, models);
    expect(diffModelSettings(settingsPath, models)).toEqual([]);
  });
});

describe('hasModelDeclarations', () => {
  test('false for an empty or effectively empty block', () => {
    expect(hasModelDeclarations({})).toBe(false);
    expect(hasModelDeclarations({ main: '', fallback: [] })).toBe(false);
  });

  test('true when any field is declared', () => {
    expect(hasModelDeclarations({ effort: 'low' })).toBe(true);
    expect(hasModelDeclarations({ fallback: ['sonnet'] })).toBe(true);
  });
});
