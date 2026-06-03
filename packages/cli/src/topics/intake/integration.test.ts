/**
 * End-to-end integration tests for the `claude-prove intake` CLI topic.
 *
 * Spawn `bun run bin/run.ts intake <cmd>` in a real tmpdir so the full cac
 * dispatch + stdout/stderr split + exit-code contract is exercised: render a
 * built-in form to HTML, list/spec the built-ins, and the validate PASS/FAIL
 * roundtrip including the secret/file rejection on a custom spec.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// packages/cli/src/topics/intake/integration.test.ts -> packages/cli/bin/run.ts
const RUN_TS = resolve(__dirname, '..', '..', '..', 'bin', 'run.ts');
const BUN_BIN = process.execPath;

interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runIntake(args: string[], cwd: string): SpawnResult {
  const proc = Bun.spawnSync({
    cmd: [BUN_BIN, 'run', RUN_TS, 'intake', ...args],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env },
  });
  return {
    exitCode: proc.exitCode ?? -1,
    stdout: proc.stdout?.toString() ?? '',
    stderr: proc.stderr?.toString() ?? '',
  };
}

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'intake-it-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('claude-prove intake (integration)', () => {
  test('list names the built-in forms', () => {
    const r = runIntake(['list'], dir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim().split('\n').sort()).toEqual(['charter', 'decompose', 'team']);
  });

  test('render --form charter emits a self-contained HTML page to --out', () => {
    const out = join(dir, 'charter.html');
    const r = runIntake(['render', '--form', 'charter', '--out', out], dir);
    expect(r.exitCode).toBe(0);
    const html = readFileSync(out, 'utf8');
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('id="intake-copy"');
    expect(html).not.toContain('http://');
    expect(html).not.toContain('https://');
  });

  test('render to stdout works without --out', () => {
    const r = runIntake(['render', '--form', 'team'], dir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('<title>Team</title>');
  });

  test('spec --form decompose emits the resolved spec JSON', () => {
    const r = runIntake(['spec', '--form', 'decompose'], dir);
    expect(r.exitCode).toBe(0);
    const spec = JSON.parse(r.stdout);
    expect(spec.form).toBe('decompose');
    expect(spec.schema_version).toBe('1');
  });

  test('an unknown --form errors with the available names', () => {
    const r = runIntake(['render', '--form', 'bogus'], dir);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('unknown form');
    expect(r.stderr).toContain('charter');
  });

  test('requiring exactly one of --form/--file', () => {
    expect(runIntake(['render'], dir).exitCode).toBe(1);
    expect(runIntake(['render', '--form', 'team', '--file', 'x.json'], dir).stderr).toContain(
      'exactly one of',
    );
  });

  test('validate PASS on a well-formed charter payload', () => {
    const payload = join(dir, 'charter-payload.json');
    writeFileSync(
      payload,
      JSON.stringify({
        schema_version: '1',
        form: 'charter',
        answers: { vision: 'v', mission: 'm', outcome_bet: 'o' },
      }),
    );
    const r = runIntake(['validate', '--form', 'charter', '--payload', payload], dir);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain('PASS');
  });

  test('validate FAIL on a payload missing a required field', () => {
    const payload = join(dir, 'charter-bad.json');
    writeFileSync(
      payload,
      JSON.stringify({ schema_version: '1', form: 'charter', answers: { vision: 'v' } }),
    );
    const r = runIntake(['validate', '--form', 'charter', '--payload', payload], dir);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('FAIL');
    expect(r.stderr).toContain('answers.mission');
  });

  test('a custom spec with a secret field is rejected on render', () => {
    const spec = join(dir, 'secret-form.json');
    writeFileSync(
      spec,
      JSON.stringify({
        schema_version: '1',
        form: 'leaky',
        title: 'Leaky',
        fields: [{ id: 'token', label: 'API token', type: 'secret' }],
      }),
    );
    const r = runIntake(['render', '--file', spec], dir);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('not permitted');
  });

  test('a valid custom spec renders and round-trips through validate', () => {
    const spec = join(dir, 'custom.json');
    writeFileSync(
      spec,
      JSON.stringify({
        schema_version: '1',
        form: 'custom',
        title: 'Custom',
        fields: [{ id: 'q', label: 'Q', type: 'text', required: true }],
      }),
    );
    expect(runIntake(['render', '--file', spec], dir).exitCode).toBe(0);

    const payload = join(dir, 'custom-payload.json');
    writeFileSync(
      payload,
      JSON.stringify({ schema_version: '1', form: 'custom', answers: { q: 'answer' } }),
    );
    const r = runIntake(['validate', '--file', spec, '--payload', payload], dir);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain('PASS');
  });
});
