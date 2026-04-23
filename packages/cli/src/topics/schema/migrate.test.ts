/**
 * 1:1 port of tools/schema/test_migrate.py plus v3 -> v4 + v4 -> v5 cases
 * and a full v0 -> v5 chain test.
 *
 * Test-name mapping (Python class/method -> TS test name):
 *
 *   TestDetectVersion.test_no_version_returns_0         -> 'no version returns 0'
 *   TestDetectVersion.test_explicit_version             -> 'explicit version'
 *
 *   TestPlanMigration.test_v0_to_current_adds_schema_version
 *                                                       -> 'v0 to current adds schema_version'
 *   TestPlanMigration.test_v0_to_current_preserves_all_sections
 *                                                       -> 'v0 to current preserves all sections'
 *   TestPlanMigration.test_already_current_no_changes   -> 'already current no changes'
 *   TestPlanMigration.test_schema_version_is_first_key  -> 'schema_version is first key'
 *   TestPlanMigration.test_v1_to_v2_adds_claude_md      -> 'v1 to v2 adds claude_md'
 *   TestPlanMigration.test_v1_to_v2_preserves_existing_claude_md
 *                                                       -> 'v1 to v2 preserves existing claude_md'
 *   TestPlanMigration.test_v1_to_v2_renames_stage_to_phase
 *                                                       -> 'v1 to v2 renames stage to phase'
 *   TestPlanMigration.test_v1_to_v2_skips_rename_if_phase_exists
 *                                                       -> 'v1 to v2 skips rename if phase exists'
 *   TestPlanMigration.test_v0_with_stage_migrates_to_phase
 *                                                       -> 'v0 with stage migrates to phase'
 *   TestPlanMigration.test_v0_migrates_through_v1_to_v2 -> 'v0 migrates through v1 to v2'
 *   TestPlanMigration.test_v2_to_v3_moves_index_to_tools_cafi
 *                                                       -> 'v2 to v3 moves index to tools.cafi'
 *   TestPlanMigration.test_v2_to_v3_no_index_adds_cafi_disabled
 *                                                       -> 'v2 to v3 no index adds cafi disabled'
 *   TestPlanMigration.test_v2_to_v3_preserves_existing_tools
 *                                                       -> 'v2 to v3 preserves existing tools'
 *   TestPlanMigration.test_v0_migrates_through_to_v3    -> 'v0 migrates through to v3'
 *
 *   TestApplyMigration.test_dry_run_no_file_modification
 *                                                       -> 'dry run no file modification'
 *   TestApplyMigration.test_apply_creates_backup        -> 'apply creates backup'
 *   TestApplyMigration.test_apply_writes_migrated_config
 *                                                       -> 'apply writes migrated config'
 *   TestApplyMigration.test_no_migration_needed         -> 'no migration needed'
 *
 *   TestRoundTrip.test_validate_after_migrate_passes    -> 'validate after migrate passes'
 *
 * New v3 -> v4 + v4 -> v5 + full-chain cases (not in the Python source):
 *   'v3 to v4 drops scopes.tools'
 *   'v3 to v4 drops tools.schema'
 *   'v3 to v4 preserves other scopes and tools entries'
 *   'v3 to v4 no-op when neither key present'
 *   'v4 to v5 adds tools.scrum defaults'
 *   'v4 to v5 preserves existing tools.scrum (idempotent)'
 *   'v4 to v5 preserves acb/pcd/cafi/run_state entries'
 *   'v4 to v5 bumps version only when no other changes apply'
 *   'v4 to v5 seeds tools when tools key absent'
 *   'full v0 to v5 chain applies all hops in order'
 *   'backup filename follows Python with_suffix semantics'
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type MigrationChange,
  applyMigration,
  backupConfig,
  detectVersion,
  planMigration,
} from './migrate';
import { CURRENT_SCHEMA_VERSION, PROVE_SCHEMA } from './schemas';
import { validateConfig } from './validate';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'migrate-test-'));
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

describe('TestDetectVersion', () => {
  test('no version returns 0', () => {
    expect(detectVersion({})).toBe('0');
    expect(detectVersion({ validators: [] })).toBe('0');
  });

  test('explicit version', () => {
    expect(detectVersion({ schema_version: '1' })).toBe('1');
    expect(detectVersion({ schema_version: '2' })).toBe('2');
  });
});

describe('TestPlanMigration', () => {
  test('v0 to current adds schema_version', () => {
    const config = { validators: [], scopes: { plugin: '.' } };
    const [target, changes] = planMigration(config);

    expect(target['schema_version']).toBe(CURRENT_SCHEMA_VERSION);
    expect(changes.some((c) => c.path === 'schema_version')).toBe(true);
  });

  test('v0 to current preserves all sections', () => {
    const config = {
      scopes: { skills: 'skills/' },
      validators: [{ name: 'test', command: 'pytest', phase: 'test' }],
      reporters: [
        { name: 'slack', command: './notify.sh', events: ['step-complete'] },
      ],
      index: { excludes: [], max_file_size: 102400, concurrency: 3 },
    };
    const [target] = planMigration(config);

    expect(target['scopes']).toEqual(config.scopes);
    expect(target['validators']).toEqual(config.validators);
    expect(target['reporters']).toEqual(config.reporters);
    // v3 migration moves index -> tools.cafi.config
    expect('index' in target).toBe(false);
    const tools = target['tools'] as Record<string, Record<string, unknown>>;
    expect(tools['cafi']!['config']).toEqual(config.index);
    expect(target['schema_version']).toBe(CURRENT_SCHEMA_VERSION);
  });

  test('already current no changes', () => {
    const config = { schema_version: CURRENT_SCHEMA_VERSION, validators: [] };
    const [target, changes] = planMigration(config);

    expect(changes).toEqual([]);
    expect(target).toEqual(config);
  });

  test('schema_version is first key', () => {
    const config = { validators: [], scopes: {} };
    const [target] = planMigration(config);

    const keys = Object.keys(target);
    expect(keys[0]).toBe('schema_version');
  });

  test('v1 to v2 adds claude_md', () => {
    const config = { schema_version: '1', validators: [] };
    const [target, changes] = planMigration(config);

    expect(target['schema_version']).toBe(CURRENT_SCHEMA_VERSION);
    expect(target['claude_md']).toEqual({ references: [] });
    expect(changes.some((c) => c.path === 'claude_md')).toBe(true);
  });

  test('v1 to v2 preserves existing claude_md', () => {
    const config = {
      schema_version: '1',
      claude_md: {
        references: [{ path: '~/.claude/standards.md', label: 'Standards' }],
      },
    };
    const [target, changes] = planMigration(config);

    expect(target['schema_version']).toBe(CURRENT_SCHEMA_VERSION);
    const cm = target['claude_md'] as { references: { path: string }[] };
    expect(cm.references[0]!.path).toBe('~/.claude/standards.md');
    expect(changes.some((c) => c.path === 'claude_md')).toBe(false);
  });

  test('v1 to v2 renames stage to phase', () => {
    const config = {
      schema_version: '1',
      validators: [
        { name: 'lint', command: 'ruff check .', stage: 'lint' },
        { name: 'test', command: 'pytest', stage: 'test' },
      ],
    };
    const [target, changes] = planMigration(config);

    expect(target['schema_version']).toBe(CURRENT_SCHEMA_VERSION);
    const validators = target['validators'] as Record<string, unknown>[];
    for (const v of validators) {
      expect('phase' in v).toBe(true);
      expect('stage' in v).toBe(false);
    }
    expect(validators[0]!['phase']).toBe('lint');
    expect(validators[1]!['phase']).toBe('test');
    expect(changes.some((c) => c.path.includes('stage'))).toBe(true);
  });

  test('v1 to v2 skips rename if phase exists', () => {
    const config = {
      schema_version: '1',
      validators: [{ name: 'test', command: 'pytest', phase: 'test' }],
    };
    const [target, changes] = planMigration(config);

    const validators = target['validators'] as Record<string, unknown>[];
    expect(validators[0]!['phase']).toBe('test');
    expect(changes.some((c) => c.path.includes('stage'))).toBe(false);
  });

  test('v0 with stage migrates to phase', () => {
    const config = {
      validators: [{ name: 'lint', command: 'ruff check .', stage: 'lint' }],
    };
    const [target] = planMigration(config);

    expect(target['schema_version']).toBe(CURRENT_SCHEMA_VERSION);
    const validators = target['validators'] as Record<string, unknown>[];
    expect(validators[0]!['phase']).toBe('lint');
    expect('stage' in validators[0]!).toBe(false);
  });

  test('v0 migrates through v1 to v2', () => {
    const config = { validators: [], scopes: { plugin: '.' } };
    const [target] = planMigration(config);

    expect(target['schema_version']).toBe(CURRENT_SCHEMA_VERSION);
    expect('claude_md' in target).toBe(true);
  });

  test('v2 to v3 moves index to tools.cafi', () => {
    const config = {
      schema_version: '2',
      index: { excludes: [], max_file_size: 102400, concurrency: 3 },
    };
    const [target, changes] = planMigration(config);

    // After v2->v3 the schema_version is "3"; subsequent hops bump it
    // further, but this test (ported verbatim) only asserts the v2->v3
    // move. The current Python test asserts "3" — the TS hop sequence
    // continues past v3, so assert the final target state is >= "3" AND
    // the v2->v3 move happened.
    expect(parseInt(target['schema_version'] as string, 10)).toBeGreaterThanOrEqual(3);
    expect('index' in target).toBe(false);
    const tools = target['tools'] as Record<string, Record<string, unknown>>;
    expect(tools['cafi']!['enabled']).toBe(true);
    expect((tools['cafi']!['config'] as { max_file_size: number }).max_file_size).toBe(102400);
    expect(changes.some((c) => c.path.includes('index'))).toBe(true);
  });

  test('v2 to v3 no index adds cafi disabled', () => {
    const config = { schema_version: '2', validators: [] };
    const [target] = planMigration(config);

    expect(parseInt(target['schema_version'] as string, 10)).toBeGreaterThanOrEqual(3);
    const tools = target['tools'] as Record<string, Record<string, unknown>>;
    expect(tools['cafi']!['enabled']).toBe(false);
  });

  test('v2 to v3 preserves existing tools', () => {
    const config = {
      schema_version: '2',
      tools: { acb: { enabled: true } },
      index: { excludes: ['*.log'] },
    };
    const [target] = planMigration(config);

    const tools = target['tools'] as Record<string, Record<string, unknown>>;
    expect(tools['acb']!['enabled']).toBe(true);
    expect((tools['cafi']!['config'] as { excludes: string[] }).excludes).toEqual(['*.log']);
  });

  test('v0 migrates through to v3', () => {
    const config = {
      validators: [],
      scopes: { plugin: '.' },
      index: { excludes: [], max_file_size: 50000, concurrency: 2 },
    };
    const [target] = planMigration(config);

    expect(target['schema_version']).toBe(CURRENT_SCHEMA_VERSION);
    expect('claude_md' in target).toBe(true);
    expect('tools' in target).toBe(true);
    const tools = target['tools'] as Record<string, Record<string, unknown>>;
    expect((tools['cafi']!['config'] as { max_file_size: number }).max_file_size).toBe(50000);
    expect('index' in target).toBe(false);
  });
});

describe('TestApplyMigration', () => {
  test('dry run no file modification', () => {
    const tmp = makeTmpDir();
    try {
      const config = { validators: [] };
      const configPath = join(tmp, '.prove.json');
      writeFileSync(configPath, JSON.stringify(config));

      const { backupPath, changes } = applyMigration(configPath, { dryRun: true });

      expect(backupPath).toBeNull();
      expect(changes.length).toBeGreaterThan(0);
      // File should be unchanged.
      expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual(config);
    } finally {
      cleanup(tmp);
    }
  });

  test('apply creates backup', () => {
    const tmp = makeTmpDir();
    try {
      const config = { validators: [] };
      const configPath = join(tmp, '.prove.json');
      writeFileSync(configPath, JSON.stringify(config));

      const { backupPath } = applyMigration(configPath);

      expect(backupPath).not.toBeNull();
      expect(readFileSync(backupPath!, 'utf8')).toBeTruthy();
      // Backup should contain original config.
      expect(JSON.parse(readFileSync(backupPath!, 'utf8'))).toEqual(config);
    } finally {
      cleanup(tmp);
    }
  });

  test('apply writes migrated config', () => {
    const tmp = makeTmpDir();
    try {
      const config = { validators: [], scopes: { plugin: '.' } };
      const configPath = join(tmp, '.prove.json');
      writeFileSync(configPath, JSON.stringify(config));

      applyMigration(configPath);

      const result = JSON.parse(readFileSync(configPath, 'utf8'));
      expect(result['schema_version']).toBe(CURRENT_SCHEMA_VERSION);
      expect(result['scopes']).toEqual({ plugin: '.' });
      expect(result['validators']).toEqual([]);
    } finally {
      cleanup(tmp);
    }
  });

  test('no migration needed', () => {
    const tmp = makeTmpDir();
    try {
      const config = { schema_version: CURRENT_SCHEMA_VERSION };
      const configPath = join(tmp, '.prove.json');
      writeFileSync(configPath, JSON.stringify(config));

      const { backupPath, changes } = applyMigration(configPath);

      expect(backupPath).toBeNull();
      expect(changes).toEqual([]);
    } finally {
      cleanup(tmp);
    }
  });
});

describe('TestRoundTrip', () => {
  test('validate after migrate passes', () => {
    const tmp = makeTmpDir();
    try {
      const config = {
        scopes: { plugin: '.' },
        validators: [{ name: 'test', command: 'pytest', phase: 'test' }],
      };
      const configPath = join(tmp, '.prove.json');
      writeFileSync(configPath, JSON.stringify(config));

      applyMigration(configPath);

      const result = JSON.parse(readFileSync(configPath, 'utf8'));
      const errors = validateConfig(result, PROVE_SCHEMA);
      const errorCount = errors.filter((e) => e.severity === 'error').length;
      expect(errorCount).toBe(0);
    } finally {
      cleanup(tmp);
    }
  });
});

// --- New v3 -> v4 + full-chain cases (not in the Python source) ---

describe('TestV3ToV4', () => {
  test('v3 to v4 drops scopes.tools', () => {
    const config = {
      schema_version: '3',
      scopes: { plugin: '.', tools: 'tools/' },
    };
    const [target, changes] = planMigration(config);

    // planMigration chains to CURRENT_SCHEMA_VERSION ('5' after Phase 12
    // Task 2) — assert the final version AND that the v3->v4 hop fired.
    expect(target['schema_version']).toBe(CURRENT_SCHEMA_VERSION);
    const scopes = target['scopes'] as Record<string, unknown>;
    expect('tools' in scopes).toBe(false);
    expect(scopes['plugin']).toBe('.');
    expect(changes.some((c) => c.path === 'scopes.tools' && c.action === 'remove')).toBe(true);
  });

  test('v3 to v4 drops tools.schema', () => {
    const config = {
      schema_version: '3',
      tools: {
        cafi: { enabled: true, config: { excludes: ['*.log'] } },
        schema: { enabled: true },
      },
    };
    const [target, changes] = planMigration(config);

    expect(target['schema_version']).toBe(CURRENT_SCHEMA_VERSION);
    const tools = target['tools'] as Record<string, Record<string, unknown>>;
    expect('schema' in tools).toBe(false);
    expect(tools['cafi']!['enabled']).toBe(true);
    expect((tools['cafi']!['config'] as { excludes: string[] }).excludes).toEqual(['*.log']);
    expect(changes.some((c) => c.path === 'tools.schema' && c.action === 'remove')).toBe(true);
  });

  test('v3 to v4 preserves other scopes and tools entries', () => {
    const config = {
      schema_version: '3',
      scopes: { plugin: '.', commands: 'commands/', agents: 'agents/', tools: 'tools/' },
      tools: {
        cafi: { enabled: true, config: { concurrency: 4 } },
        acb: { enabled: true },
        schema: { enabled: true },
      },
    };
    const [target] = planMigration(config);

    const scopes = target['scopes'] as Record<string, unknown>;
    expect(scopes).toEqual({
      plugin: '.',
      commands: 'commands/',
      agents: 'agents/',
    });
    const tools = target['tools'] as Record<string, Record<string, unknown>>;
    expect(tools['cafi']).toEqual({ enabled: true, config: { concurrency: 4 } });
    expect(tools['acb']).toEqual({ enabled: true });
    expect('schema' in tools).toBe(false);
  });

  test('v3 to v4 no-op when neither key present', () => {
    const config = {
      schema_version: '3',
      scopes: { plugin: '.' },
      tools: { cafi: { enabled: false } },
    };
    const [target, changes] = planMigration(config);

    expect(target['schema_version']).toBe(CURRENT_SCHEMA_VERSION);
    expect(target['scopes']).toEqual({ plugin: '.' });
    // v4 -> v5 seeds tools.scrum, so cafi is preserved alongside scrum.
    expect((target['tools'] as Record<string, unknown>)['cafi']).toEqual({ enabled: false });
    expect((target['tools'] as Record<string, unknown>)['scrum']).toEqual({
      enabled: true,
      scope: 'user',
      config: {},
    });
    // v3->v4 emits only the schema_version bump; v4->v5 emits schema_version + tools.scrum.
    const nonV3V4Changes = changes.filter(
      (c) => !(c.path === 'schema_version' || c.path === 'tools.scrum'),
    );
    expect(nonV3V4Changes).toEqual([]);
  });
});

describe('TestV4ToV5', () => {
  test('v4 to v5 adds tools.scrum defaults', () => {
    const config = { schema_version: '4', tools: {} };
    const [target, changes] = planMigration(config);

    expect(target['schema_version']).toBe('5');
    const tools = target['tools'] as Record<string, unknown>;
    expect(tools['scrum']).toEqual({
      enabled: true,
      scope: 'user',
      config: {},
    });
    expect(
      changes.some((c) => c.path === 'tools.scrum' && c.action === 'add'),
    ).toBe(true);
  });

  test('v4 to v5 preserves existing tools.scrum (idempotent)', () => {
    const existing = { enabled: false, scope: 'project', config: { velocity: 8 } };
    const config = {
      schema_version: '4',
      tools: { scrum: existing },
    };
    const [target, changes] = planMigration(config);

    expect(target['schema_version']).toBe('5');
    const tools = target['tools'] as Record<string, unknown>;
    // Existing scrum block is preserved byte-for-byte.
    expect(tools['scrum']).toEqual(existing);
    // No add-change for tools.scrum when it already existed.
    expect(changes.some((c) => c.path === 'tools.scrum')).toBe(false);
    // Only schema_version bump change is emitted.
    const nonVersionChanges = changes.filter((c) => c.path !== 'schema_version');
    expect(nonVersionChanges).toEqual([]);
  });

  test('v4 to v5 preserves acb/pcd/cafi/run_state entries', () => {
    const config = {
      schema_version: '4',
      tools: {
        pcd: { enabled: true },
        acb: {
          enabled: true,
          scope: 'user',
          config: { base_branch: 'main', review_ui_port: 5174 },
        },
        cafi: {
          enabled: true,
          scope: 'user',
          config: { excludes: [], max_file_size: 102400, concurrency: 3 },
        },
        run_state: { enabled: true, scope: 'user' },
      },
    };
    const [target] = planMigration(config);

    expect(target['schema_version']).toBe('5');
    const tools = target['tools'] as Record<string, Record<string, unknown>>;
    expect(tools['pcd']).toEqual({ enabled: true });
    expect(tools['acb']).toEqual({
      enabled: true,
      scope: 'user',
      config: { base_branch: 'main', review_ui_port: 5174 },
    });
    expect(tools['cafi']).toEqual({
      enabled: true,
      scope: 'user',
      config: { excludes: [], max_file_size: 102400, concurrency: 3 },
    });
    expect(tools['run_state']).toEqual({ enabled: true, scope: 'user' });
    expect(tools['scrum']).toEqual({
      enabled: true,
      scope: 'user',
      config: {},
    });
  });

  test('v4 to v5 bumps version only when no other changes apply', () => {
    const config = {
      schema_version: '4',
      tools: { scrum: { enabled: true, scope: 'user', config: {} } },
    };
    const [target, changes] = planMigration(config);

    expect(target['schema_version']).toBe('5');
    // Only a version-bump change — no tools.scrum add, no other mutations.
    expect(changes.length).toBe(1);
    expect(changes[0]!.action).toBe('change');
    expect(changes[0]!.path).toBe('schema_version');
    // Keys outside schema_version and tools are untouched.
    const keys = Object.keys(target).filter((k) => k !== 'schema_version' && k !== 'tools');
    const origKeys = Object.keys(config).filter(
      (k) => k !== 'schema_version' && k !== 'tools',
    );
    expect(keys).toEqual(origKeys);
  });

  test('v4 to v5 seeds tools when tools key absent', () => {
    const config = { schema_version: '4' };
    const [target] = planMigration(config);

    expect(target['schema_version']).toBe('5');
    expect(target['tools']).toEqual({
      scrum: { enabled: true, scope: 'user', config: {} },
    });
  });
});

describe('TestFullChain', () => {
  test('full v0 to v5 chain applies all hops in order', () => {
    const config = {
      validators: [{ name: 'lint', command: 'ruff', stage: 'lint' }],
      scopes: { plugin: '.', tools: 'tools/' },
      index: { excludes: ['*.tmp'], max_file_size: 4096, concurrency: 2 },
      tools: { schema: { enabled: true } },
    };
    const [target, changes] = planMigration(config);

    // Final schema_version.
    expect(target['schema_version']).toBe('5');

    // Ordered hop signatures — each hop emits at least one change whose
    // path or description identifies it.
    const changeText = changes.map((c: MigrationChange) => c.toString());
    const idxAdd = changeText.findIndex((s) => s.includes('set to "1"'));
    const idxClaude = changeText.findIndex((s) => s.includes('claude_md'));
    const idxIndex = changeText.findIndex((s) => s.includes('moved to tools.cafi.config'));
    const idxScopesTools = changeText.findIndex((s) => s.includes('scopes.tools'));
    const idxScrum = changeText.findIndex((s) => s.includes('tools.scrum'));

    expect(idxAdd).toBeGreaterThanOrEqual(0);
    expect(idxClaude).toBeGreaterThan(idxAdd);
    expect(idxIndex).toBeGreaterThan(idxClaude);
    expect(idxScopesTools).toBeGreaterThan(idxIndex);
    expect(idxScrum).toBeGreaterThan(idxScopesTools);

    // v1->v2 renames stage -> phase
    const validators = target['validators'] as Record<string, unknown>[];
    expect(validators[0]!['phase']).toBe('lint');
    expect('stage' in validators[0]!).toBe(false);

    // v1->v2 adds claude_md with empty references
    expect(target['claude_md']).toEqual({ references: [] });

    // v2->v3 moves index under tools.cafi
    expect('index' in target).toBe(false);
    const tools = target['tools'] as Record<string, Record<string, unknown>>;
    expect(tools['cafi']!['enabled']).toBe(true);
    expect((tools['cafi']!['config'] as { max_file_size: number }).max_file_size).toBe(4096);

    // v3->v4 drops scopes.tools + tools.schema
    const scopes = target['scopes'] as Record<string, unknown>;
    expect('tools' in scopes).toBe(false);
    expect(scopes['plugin']).toBe('.');
    expect('schema' in tools).toBe(false);

    // v4->v5 seeds tools.scrum with defaults
    expect(tools['scrum']).toEqual({
      enabled: true,
      scope: 'user',
      config: {},
    });
  });
});

describe('TestBackupFilename', () => {
  test('backup filename follows Python with_suffix semantics', () => {
    const tmp = makeTmpDir();
    try {
      const configPath = join(tmp, '.prove.json');
      writeFileSync(configPath, JSON.stringify({ validators: [] }));

      const backupPath = backupConfig(configPath);

      // Python: Path('.prove.json').with_suffix('.<ts>.bak') -> '.prove.<ts>.bak'
      const name = backupPath.slice(tmp.length + 1);
      expect(name).toMatch(/^\.prove\.\d{8}T\d{6}\.bak$/);

      // The backup sits in the same directory.
      const entries = readdirSync(tmp);
      expect(entries).toContain('.prove.json');
      expect(entries.some((n) => /^\.prove\.\d{8}T\d{6}\.bak$/.test(n))).toBe(true);
    } finally {
      cleanup(tmp);
    }
  });
});
