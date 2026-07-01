import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ScanResult } from '../scanner';
import { pluginMetadataMissing, resolvePluginDir } from './generate-cmd';

function makePluginDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-'));
  mkdirSync(join(dir, '.claude-plugin'));
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), '{"version":"9.9.9"}');
  return dir;
}

function scan(overrides: Partial<ScanResult>): ScanResult {
  return {
    project: { name: 'p' },
    tech_stack: { languages: [], frameworks: [], build_systems: [] },
    key_dirs: {},
    conventions: { naming: 'unknown', test_patterns: [], primary_extensions: [] },
    prove_config: {
      exists: true,
      validators: [],
      has_index: false,
      references: [],
      tool_directives: [],
      dev_mode: false,
    },
    cafi: { available: false, file_count: 0 },
    core_commands: [{ name: 'claude-md', summary: 'Regenerate this file' }],
    team_agents: [],
    plugin_version: '4.3.2',
    plugin_dir: '/opt/prove',
    project_root: '/work/p',
    ...overrides,
  };
}

describe('resolvePluginDir', () => {
  const created: string[] = [];
  let savedProveEnv: string | undefined;
  let savedGenericEnv: string | undefined;

  beforeEach(() => {
    savedProveEnv = process.env.CLAUDE_PROVE_PLUGIN_DIR;
    savedGenericEnv = process.env.CLAUDE_PLUGIN_ROOT;
  });

  afterEach(() => {
    restore('CLAUDE_PROVE_PLUGIN_DIR', savedProveEnv);
    restore('CLAUDE_PLUGIN_ROOT', savedGenericEnv);
    for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function restore(key: string, value: string | undefined): void {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  test('the --plugin-dir flag wins over the env', () => {
    const flag = mkdtempSync(join(tmpdir(), 'flag-'));
    const env = makePluginDir();
    created.push(flag, env);
    process.env.CLAUDE_PROVE_PLUGIN_DIR = env;

    expect(resolvePluginDir({ pluginDir: flag }, '/nope')).toBe(resolve(flag));
  });

  test('resolves the plugin dir from the env when it is a real plugin root', () => {
    const env = makePluginDir();
    created.push(env);
    process.env.CLAUDE_PROVE_PLUGIN_DIR = env;

    expect(resolvePluginDir({}, '/nope')).toBe(resolve(env));
  });

  test('falls through an invalid env to the project .claude/prove-plugin bridge', () => {
    const plugin = makePluginDir();
    const projectRoot = mkdtempSync(join(tmpdir(), 'proj-'));
    created.push(plugin, projectRoot);
    mkdirSync(join(projectRoot, '.claude'));
    symlinkSync(plugin, join(projectRoot, '.claude', 'prove-plugin'));
    process.env.CLAUDE_PROVE_PLUGIN_DIR = join(plugin, 'does-not-exist');

    expect(resolvePluginDir({}, projectRoot)).toBe(realpathSync(plugin));
  });
});

describe('pluginMetadataMissing', () => {
  test('false when prove is configured and metadata is present', () => {
    expect(pluginMetadataMissing(scan({}))).toBe(false);
  });

  test('true when the plugin version is unknown', () => {
    expect(pluginMetadataMissing(scan({ plugin_version: 'unknown' }))).toBe(true);
  });

  test('true when there are no core commands', () => {
    expect(pluginMetadataMissing(scan({ core_commands: [] }))).toBe(true);
  });

  test('false when prove is not configured', () => {
    const missing = scan({ core_commands: [], plugin_version: 'unknown' });
    missing.prove_config.exists = false;
    expect(pluginMetadataMissing(missing)).toBe(false);
  });
});
