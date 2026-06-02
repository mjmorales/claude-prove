/**
 * Unit tests for the per-user (home-dir) project-root → default contributor
 * config. Every test drives the config through an explicit base-dir override
 * pointed at a fresh tmp dir, so the developer's real `~/.config` is NEVER
 * touched. The XDG-honoring path resolution is exercised through the process
 * env with the real `homedir()` stubbed out via XDG_CONFIG_HOME.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  configFilePath,
  readUserConfig,
  resolveDefaultContributor,
  setDefaultContributor,
} from './user-config';

/**
 * Restore an env var to a saved value, deleting it when it was previously
 * unset. The computed-member `delete` (vs `delete process.env.KEY`) is the form
 * the scrum CLI test harness uses and that biome's noDelete tolerates.
 */
function restoreEnv(key: string, saved: string | undefined): void {
  if (saved === undefined) {
    if (key in process.env) delete process.env[key];
  } else {
    process.env[key] = saved;
  }
}

let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'prove-user-config-'));
});

afterEach(() => {
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('user-config: set then show round-trip', () => {
  test('a mapped root resolves to its CT-UUID', () => {
    const root = '/Users/dev/project-a';
    const key = setDefaultContributor(root, 'ct-jane-doe-abc123', base);
    expect(key).toBe(resolve(root));

    const resolved = resolveDefaultContributor(root, base);
    expect(resolved).toBe('ct-jane-doe-abc123');
  });

  test('set is idempotent-overwrite — the latest mapping wins', () => {
    const root = '/Users/dev/project-a';
    setDefaultContributor(root, 'ct-first-111', base);
    setDefaultContributor(root, 'ct-second-222', base);
    expect(resolveDefaultContributor(root, base)).toBe('ct-second-222');
  });

  test('set preserves unrelated top-level keys and other root mappings', () => {
    // Seed a config carrying an unrelated key and a pre-existing mapping.
    mkdirSync(join(base, 'claude-prove'), { recursive: true });
    writeFileSync(
      configFilePath(base),
      JSON.stringify({
        future_setting: { keep: true },
        default_contributors: { '/Users/dev/project-x': 'ct-x-999' },
      }),
      'utf8',
    );

    setDefaultContributor('/Users/dev/project-a', 'ct-a-111', base);

    const config = readUserConfig(base);
    expect(config.future_setting).toEqual({ keep: true });
    expect(config.default_contributors['/Users/dev/project-x']).toBe('ct-x-999');
    expect(config.default_contributors[resolve('/Users/dev/project-a')]).toBe('ct-a-111');
  });
});

describe('user-config: unmapped root → null fallback', () => {
  test('an unmapped root resolves to null without throwing', () => {
    setDefaultContributor('/Users/dev/project-a', 'ct-a-111', base);
    expect(resolveDefaultContributor('/Users/dev/project-b', base)).toBeNull();
  });
});

describe('user-config: absent config file', () => {
  test('read returns an empty mapping, no throw', () => {
    const config = readUserConfig(base);
    expect(config.default_contributors).toEqual({});
  });

  test('resolve against an absent config returns null', () => {
    expect(resolveDefaultContributor('/Users/dev/anything', base)).toBeNull();
  });
});

describe('user-config: malformed config file', () => {
  test('invalid JSON throws a clear, path-anchored error', () => {
    mkdirSync(join(base, 'claude-prove'), { recursive: true });
    writeFileSync(configFilePath(base), '{ not valid json', 'utf8');
    expect(() => readUserConfig(base)).toThrow(/malformed user config at .*config\.json/);
  });

  test('a non-object default_contributors throws a clear error', () => {
    mkdirSync(join(base, 'claude-prove'), { recursive: true });
    writeFileSync(
      configFilePath(base),
      JSON.stringify({ default_contributors: ['not', 'an', 'object'] }),
      'utf8',
    );
    expect(() => readUserConfig(base)).toThrow(/default_contributors.*must be an object/);
  });

  test('a top-level JSON array throws a clear error', () => {
    mkdirSync(join(base, 'claude-prove'), { recursive: true });
    writeFileSync(configFilePath(base), JSON.stringify(['array', 'root']), 'utf8');
    expect(() => readUserConfig(base)).toThrow(/expected a JSON object/);
  });
});

describe('user-config: XDG_CONFIG_HOME honored', () => {
  let savedXdg: string | undefined;

  beforeEach(() => {
    savedXdg = process.env.XDG_CONFIG_HOME;
  });

  afterEach(() => {
    restoreEnv('XDG_CONFIG_HOME', savedXdg);
  });

  test('the config path lands under $XDG_CONFIG_HOME when no override is given', () => {
    process.env.XDG_CONFIG_HOME = base;
    // No explicit base override — resolution must fall through to the env var.
    setDefaultContributor('/Users/dev/project-a', 'ct-xdg-111');
    expect(configFilePath()).toBe(join(base, 'claude-prove', 'config.json'));
    expect(resolveDefaultContributor('/Users/dev/project-a')).toBe('ct-xdg-111');
  });
});
