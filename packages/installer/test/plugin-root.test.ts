import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLUGIN_DIR_ENV_VAR, resolvePluginRoot } from '../src/plugin-root';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEV_FIXTURE = join(HERE, '__fixtures__', 'dev-plugin');
const DEV_NESTED = join(DEV_FIXTURE, 'nested', 'child');
const ENV_KEY = 'CLAUDE_PLUGIN_ROOT';
const PROVE_ENV_KEY = PLUGIN_DIR_ENV_VAR;

const ORIGINAL_ENV = process.env[ENV_KEY];
const ORIGINAL_PROVE_ENV = process.env[PROVE_ENV_KEY];

function clearEnv(): void {
  Reflect.deleteProperty(process.env, ENV_KEY);
  Reflect.deleteProperty(process.env, PROVE_ENV_KEY);
}

function restoreEnv(): void {
  if (ORIGINAL_ENV === undefined) {
    Reflect.deleteProperty(process.env, ENV_KEY);
  } else {
    process.env[ENV_KEY] = ORIGINAL_ENV;
  }
  if (ORIGINAL_PROVE_ENV === undefined) {
    Reflect.deleteProperty(process.env, PROVE_ENV_KEY);
  } else {
    process.env[PROVE_ENV_KEY] = ORIGINAL_PROVE_ENV;
  }
}

describe('resolvePluginRoot', () => {
  beforeEach(clearEnv);
  afterEach(restoreEnv);

  test('honors $CLAUDE_PROVE_PLUGIN_DIR above all other sources', () => {
    process.env[PROVE_ENV_KEY] = DEV_FIXTURE;
    process.env[ENV_KEY] = '/some/other/root';
    expect(resolvePluginRoot('/unused/start')).toBe(DEV_FIXTURE);
  });

  test('ignores empty $CLAUDE_PROVE_PLUGIN_DIR and falls through to $CLAUDE_PLUGIN_ROOT', () => {
    process.env[PROVE_ENV_KEY] = '';
    process.env[ENV_KEY] = DEV_FIXTURE;
    expect(resolvePluginRoot('/unused/start')).toBe(DEV_FIXTURE);
  });

  test('honors $CLAUDE_PLUGIN_ROOT when set', () => {
    process.env[ENV_KEY] = DEV_FIXTURE;
    expect(resolvePluginRoot('/unused/start')).toBe(DEV_FIXTURE);
  });

  test('ignores empty $CLAUDE_PLUGIN_ROOT and falls through to discovery', () => {
    process.env[ENV_KEY] = '';
    expect(resolvePluginRoot(DEV_NESTED)).toBe(DEV_FIXTURE);
  });

  test('walks upward to locate .claude-plugin/plugin.json', () => {
    expect(resolvePluginRoot(DEV_NESTED)).toBe(DEV_FIXTURE);
  });

  test('returns the starting dir when it already contains the plugin marker', () => {
    expect(resolvePluginRoot(DEV_FIXTURE)).toBe(DEV_FIXTURE);
  });

  test('falls back to $HOME/.claude/plugins/prove when no marker is found', () => {
    const rootless = mkdtempSync(join(tmpdir(), 'installer-plugin-root-'));
    try {
      const fallback = join(homedir(), '.claude', 'plugins', 'prove');
      expect(resolvePluginRoot(rootless)).toBe(fallback);
    } finally {
      rmSync(rootless, { recursive: true, force: true });
    }
  });
});
