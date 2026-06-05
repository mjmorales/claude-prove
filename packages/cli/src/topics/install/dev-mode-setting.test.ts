import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readDevModeSetting } from './dev-mode-setting';

function makeProject(config?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'prove-dev-mode-setting-'));
  if (config !== undefined) {
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude', '.prove.json'), config, 'utf8');
  }
  return root;
}

describe('readDevModeSetting', () => {
  test('returns the explicit boolean when set', () => {
    const enabled = makeProject('{ "schema_version": "10", "dev_mode": true }');
    const disabled = makeProject('{ "schema_version": "10", "dev_mode": false }');
    try {
      expect(readDevModeSetting(enabled)).toBe(true);
      expect(readDevModeSetting(disabled)).toBe(false);
    } finally {
      rmSync(enabled, { recursive: true, force: true });
      rmSync(disabled, { recursive: true, force: true });
    }
  });

  test('returns undefined when the config is absent', () => {
    const root = makeProject();
    try {
      expect(readDevModeSetting(root)).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('returns undefined when dev_mode is missing or not a boolean', () => {
    const missing = makeProject('{ "schema_version": "10" }');
    const stringy = makeProject('{ "dev_mode": "true" }');
    try {
      expect(readDevModeSetting(missing)).toBeUndefined();
      expect(readDevModeSetting(stringy)).toBeUndefined();
    } finally {
      rmSync(missing, { recursive: true, force: true });
      rmSync(stringy, { recursive: true, force: true });
    }
  });

  test('returns undefined on malformed JSON or a non-object root', () => {
    const malformed = makeProject('{ not json');
    const array = makeProject('[true]');
    try {
      expect(readDevModeSetting(malformed)).toBeUndefined();
      expect(readDevModeSetting(array)).toBeUndefined();
    } finally {
      rmSync(malformed, { recursive: true, force: true });
      rmSync(array, { recursive: true, force: true });
    }
  });
});
