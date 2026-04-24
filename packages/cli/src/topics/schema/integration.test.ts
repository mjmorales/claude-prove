/**
 * End-to-end CLI parity tests for the `schema` topic.
 *
 * For each (action, fixture) pair:
 *   1. Copy the fixture to a temp dir named `.prove.json` so the CLI's
 *      path-based schema auto-detection fires.
 *   2. Spawn the TS CLI entry (`bin/run.ts`) via `Bun.spawnSync`.
 *   3. Normalise the temp path in stdout to the sentinel `<FIXTURE_PATH>`
 *      (matching the baked fixtures).
 *   4. Assert the result is byte-identical to
 *      `__fixtures__/ts-captures/<action>_<fixture>.txt`.
 *
 * The test intentionally asserts against `ts-captures/` rather than
 * `python-captures/` — see `__fixtures__/README.md` for the rationale
 * (Python is pinned at `CURRENT_SCHEMA_VERSION = "3"` while TS ships v4
 * from Task 2, a real semantic divergence that can't be papered over).
 *
 * A dedicated unknown-action test pins the stderr message + non-zero
 * exit code contract documented in `schema.ts`.
 */

import { describe, expect, test } from 'bun:test';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(Bun.fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(HERE, '__fixtures__');
const TS_CAPTURES = join(FIXTURES_DIR, 'ts-captures');
const CLI_ENTRY = resolve(HERE, '../../../bin/run.ts');
const SENTINEL = '<FIXTURE_PATH>';

const VERSIONS = ['v0', 'v1', 'v2', 'v3'] as const;
type Version = (typeof VERSIONS)[number];

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runCli(args: string[]): CliResult {
  const proc = Bun.spawnSync({
    cmd: ['bun', 'run', CLI_ENTRY, ...args],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    exitCode: proc.exitCode ?? -1,
  };
}

function withFixture<T>(version: Version, fn: (provePath: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), `schema-integ-${version}-`));
  try {
    const dst = join(dir, '.prove.json');
    copyFileSync(join(FIXTURES_DIR, `${version}.json`), dst);
    return fn(dst);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function normalise(output: string, fixturePath: string): string {
  // Replace absolute temp path with the sentinel used in captured fixtures.
  return output.split(fixturePath).join(SENTINEL);
}

function readCapture(name: string): string {
  return readFileSync(join(TS_CAPTURES, name), 'utf8');
}

describe.each(VERSIONS)('schema CLI parity against %s fixture', (version) => {
  test('validate output matches ts-capture', () => {
    const actual = withFixture(version, (provePath) => {
      const { stdout } = runCli(['schema', 'validate', '--file', provePath]);
      return normalise(stdout, provePath);
    });
    expect(actual).toBe(readCapture(`validate_${version}.txt`));
  });

  test('migrate --dry-run output matches ts-capture', () => {
    const actual = withFixture(version, (provePath) => {
      const { stdout } = runCli(['schema', 'migrate', '--file', provePath, '--dry-run']);
      return normalise(stdout, provePath);
    });
    expect(actual).toBe(readCapture(`migrate_dry_${version}.txt`));
  });

  test('diff output matches ts-capture', () => {
    const actual = withFixture(version, (provePath) => {
      const { stdout } = runCli(['schema', 'diff', '--file', provePath]);
      return normalise(stdout, provePath);
    });
    expect(actual).toBe(readCapture(`diff_${version}.txt`));
  });
});

describe('schema CLI — error paths', () => {
  test('unknown action exits 1 with stderr message', () => {
    const { stderr, exitCode } = runCli(['schema', 'bogus']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain(
      "claude-prove schema: unknown action 'bogus'. expected one of: validate, migrate, diff, summary",
    );
  });

  test('validate on missing file prints error and exits 1', () => {
    const { stdout, exitCode } = runCli([
      'schema',
      'validate',
      '--file',
      '/definitely/not/a/real/path/.prove.json',
    ]);
    expect(exitCode).toBe(1);
    expect(stdout).toContain('file not found');
  });
});
