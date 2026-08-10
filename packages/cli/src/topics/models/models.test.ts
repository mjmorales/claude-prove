/**
 * Tests for the `models` topic: `set` (declare the committed recommendation),
 * `apply` (materialize into settings.local.json), `status` (read-only
 * report), and the doctor `models-drift` wiring.
 *
 * Each test runs against a fresh tmpdir workspace holding a minimal
 * `.claude/.prove.json`, driving the public run functions and asserting on
 * exit codes plus on-disk JSON — never on private helpers.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runDoctor } from '../install/doctor';
import { CURRENT_SCHEMA_VERSION } from '../schema/schemas';
import { runApply } from './apply';
import { PRESET_NAMES, runPresets } from './presets';
import { runSet } from './set';
import { runStatus } from './status';

let workspace: string;
let proveJsonPath: string;
let settingsPath: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'models-topic-'));
  mkdirSync(join(workspace, '.claude'), { recursive: true });
  proveJsonPath = join(workspace, '.claude', '.prove.json');
  settingsPath = join(workspace, '.claude', 'settings.local.json');
  writeFileSync(
    proveJsonPath,
    `${JSON.stringify({ schema_version: CURRENT_SCHEMA_VERSION }, null, 2)}\n`,
    'utf8',
  );
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Silence stdout/stderr for the duration of `fn`. */
function muted<T>(fn: () => T): T {
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = () => true;
  process.stderr.write = () => true;
  try {
    return fn();
  } finally {
    process.stdout.write = origStdout;
    process.stderr.write = origStderr;
  }
}

describe('models set', () => {
  test('declares a full block and preserves unrelated keys', () => {
    const code = muted(() =>
      runSet({
        cwd: workspace,
        main: 'opusplan',
        advisor: 'opus',
        fallback: 'sonnet, haiku',
        effort: 'high',
      }),
    );
    expect(code).toBe(0);
    expect(readJson(proveJsonPath)).toEqual({
      schema_version: CURRENT_SCHEMA_VERSION,
      models: {
        main: 'opusplan',
        advisor: 'opus',
        fallback: ['sonnet', 'haiku'],
        effort: 'high',
      },
    });
  });

  test('amends only the passed field', () => {
    muted(() => runSet({ cwd: workspace, main: 'opusplan', advisor: 'opus' }));
    muted(() => runSet({ cwd: workspace, advisor: 'sonnet' }));
    expect(readJson(proveJsonPath).models).toEqual({ main: 'opusplan', advisor: 'sonnet' });
  });

  test('empty string clears a field; clearing the last field removes the block', () => {
    muted(() => runSet({ cwd: workspace, main: 'opusplan', advisor: 'opus' }));
    muted(() => runSet({ cwd: workspace, advisor: '' }));
    expect(readJson(proveJsonPath).models).toEqual({ main: 'opusplan' });
    muted(() => runSet({ cwd: workspace, main: '' }));
    expect('models' in readJson(proveJsonPath)).toBe(false);
  });

  test('rejects an out-of-enum effort without writing', () => {
    const before = readFileSync(proveJsonPath, 'utf8');
    const code = muted(() => runSet({ cwd: workspace, effort: 'ultra' }));
    expect(code).toBe(1);
    expect(readFileSync(proveJsonPath, 'utf8')).toBe(before);
  });

  test('rejects a call with nothing to set', () => {
    expect(muted(() => runSet({ cwd: workspace }))).toBe(1);
  });

  test('--preset expands the named preset table entry', () => {
    const code = muted(() => runSet({ cwd: workspace, preset: 'unattended' }));
    expect(code).toBe(0);
    expect(readJson(proveJsonPath).models).toEqual({
      main: 'sonnet',
      advisor: 'opus',
      fallback: ['sonnet', 'haiku'],
      effort: 'high',
    });
  });

  test('--preset replaces an existing block instead of merging into it', () => {
    muted(() => runSet({ cwd: workspace, main: 'opusplan', fallback: 'haiku' }));
    muted(() => runSet({ cwd: workspace, preset: 'deep' }));
    // The prior fallback is NOT carried into the preset's coherent pairing.
    expect(readJson(proveJsonPath).models).toEqual({
      main: 'opus',
      advisor: 'opus',
      effort: 'xhigh',
    });
  });

  test('field flags override individual preset fields', () => {
    muted(() => runSet({ cwd: workspace, preset: 'balanced', effort: 'xhigh' }));
    expect(readJson(proveJsonPath).models).toEqual({
      main: 'opusplan',
      advisor: 'opus',
      effort: 'xhigh',
    });
  });

  test('rejects an unknown preset without writing', () => {
    const before = readFileSync(proveJsonPath, 'utf8');
    expect(muted(() => runSet({ cwd: workspace, preset: 'turbo' }))).toBe(1);
    expect(readFileSync(proveJsonPath, 'utf8')).toBe(before);
  });

  test('every preset in the table validates against PROVE_SCHEMA', () => {
    for (const name of PRESET_NAMES) {
      expect(muted(() => runSet({ cwd: workspace, preset: name }))).toBe(0);
    }
  });
});

describe('models presets', () => {
  test('lists every preset and exits 0', () => {
    expect(muted(() => runPresets())).toBe(0);
  });
});

describe('models apply', () => {
  test('materializes the declared block into settings.local.json', () => {
    muted(() => runSet({ cwd: workspace, main: 'opusplan', advisor: 'opus', effort: 'xhigh' }));
    const code = muted(() => runApply({ cwd: workspace }));
    expect(code).toBe(0);
    expect(readJson(settingsPath)).toEqual({
      model: 'opusplan',
      advisorModel: 'opus',
      env: { CLAUDE_CODE_EFFORT_LEVEL: 'xhigh' },
    });
  });

  test('dry-run writes nothing', () => {
    muted(() => runSet({ cwd: workspace, main: 'opusplan' }));
    const code = muted(() => runApply({ cwd: workspace, dryRun: true }));
    expect(code).toBe(0);
    expect(() => readFileSync(settingsPath, 'utf8')).toThrow();
  });

  test('exits 1 when no models block is declared', () => {
    expect(muted(() => runApply({ cwd: workspace }))).toBe(1);
  });

  test('second apply is a no-op and operator keys survive', () => {
    muted(() => runSet({ cwd: workspace, main: 'opusplan' }));
    muted(() => runApply({ cwd: workspace }));
    writeFileSync(
      settingsPath,
      JSON.stringify({ ...readJson(settingsPath), permissions: { allow: ['Bash(ls)'] } }),
      'utf8',
    );
    expect(muted(() => runApply({ cwd: workspace }))).toBe(0);
    expect(readJson(settingsPath)).toEqual({
      model: 'opusplan',
      permissions: { allow: ['Bash(ls)'] },
    });
  });
});

describe('models status', () => {
  test('exits 0 with and without a declared block', () => {
    expect(muted(() => runStatus({ cwd: workspace }))).toBe(0);
    muted(() => runSet({ cwd: workspace, main: 'opusplan' }));
    expect(muted(() => runStatus({ cwd: workspace }))).toBe(0);
  });

  test('exits 1 when .prove.json is missing', () => {
    rmSync(proveJsonPath);
    let code: number;
    try {
      code = muted(() => runStatus({ cwd: workspace }));
    } catch (err) {
      // run functions throw ProveJsonReadError; the topic dispatcher maps it
      // to exit 1 — either surface is acceptable here.
      code = 1;
    }
    expect(code).toBe(1);
  });
});

describe('doctor models-drift', () => {
  async function findCheck(name: string) {
    return (await runDoctor({ cwd: workspace })).find((r) => r.name === name);
  }

  test('absent models block emits no check', async () => {
    expect(await findCheck('models-drift')).toBeUndefined();
  });

  test('declared but unmaterialized block warns and names models apply', async () => {
    muted(() => runSet({ cwd: workspace, main: 'opusplan', advisor: 'opus' }));
    const check = await findCheck('models-drift');
    expect(check?.status).toBe('warn');
    expect(check?.message).toContain('model');
    expect(check?.fix).toContain('claude-prove models apply');
  });

  test('materialized block passes', async () => {
    muted(() => runSet({ cwd: workspace, main: 'opusplan', advisor: 'opus' }));
    muted(() => runApply({ cwd: workspace }));
    const check = await findCheck('models-drift');
    expect(check?.status).toBe('pass');
  });
});
