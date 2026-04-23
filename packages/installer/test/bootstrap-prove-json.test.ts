/**
 * Integration-ish tests for bootstrapProveJson.
 *
 * Each stack test copies a fixture dir into a tmp root, runs the
 * bootstrap, and asserts the emitted `.claude/.prove.json` matches the
 * validators that detectValidators would return for that fixture. The
 * bootstrap and the detector share a source of truth; these tests pin
 * the emit format (atomic write, schema_version, reporters: []).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CURRENT_SCHEMA_VERSION } from '@claude-prove/cli/schema/schemas';
import { bootstrapProveJson } from '../src/bootstrap-prove-json';

const FIXTURES = join(import.meta.dir, '__fixtures__', 'stacks');

function stageFixture(stack: string): string {
  const dir = mkdtempSync(join(tmpdir(), `installer-${stack}-`));
  cpSync(join(FIXTURES, stack), dir, { recursive: true });
  return dir;
}

function readConfig(cwd: string): {
  schema_version: string;
  validators: Array<{ name: string; command?: string; phase: string }>;
  reporters: unknown[];
  [key: string]: unknown;
} {
  const raw = readFileSync(join(cwd, '.claude', '.prove.json'), 'utf8');
  return JSON.parse(raw);
}

describe('bootstrapProveJson — stack fixtures', () => {
  let savedPath: string | undefined;

  beforeEach(() => {
    savedPath = process.env.PATH;
    // Python fixture emits ruff vs mypy vs neither — pin to neither so
    // tests don't depend on local toolchain.
    process.env.PATH = '/tmp/detect-no-tools';
  });
  afterEach(() => {
    if (savedPath === undefined) Reflect.deleteProperty(process.env, 'PATH');
    else process.env.PATH = savedPath;
  });

  test('Node fixture emits tests validator', () => {
    const dir = stageFixture('node');
    try {
      bootstrapProveJson(dir);
      const config = readConfig(dir);
      expect(config.schema_version).toBe(CURRENT_SCHEMA_VERSION);
      expect(config.reporters).toEqual([]);
      expect(config.validators).toEqual([{ name: 'tests', command: 'npm test', phase: 'test' }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('Go fixture emits build/lint/test', () => {
    const dir = stageFixture('go');
    try {
      bootstrapProveJson(dir);
      expect(readConfig(dir).validators).toEqual([
        { name: 'build', command: 'go build ./...', phase: 'build' },
        { name: 'lint', command: 'go vet ./...', phase: 'lint' },
        { name: 'tests', command: 'go test ./...', phase: 'test' },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('Python fixture emits pytest only (no ruff/mypy on PATH)', () => {
    const dir = stageFixture('python');
    try {
      bootstrapProveJson(dir);
      expect(readConfig(dir).validators).toEqual([
        { name: 'tests', command: 'pytest', phase: 'test' },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('Rust fixture emits check/clippy/test', () => {
    const dir = stageFixture('rust');
    try {
      bootstrapProveJson(dir);
      expect(readConfig(dir).validators).toEqual([
        { name: 'check', command: 'cargo check', phase: 'build' },
        { name: 'clippy', command: 'cargo clippy -- -D warnings', phase: 'lint' },
        { name: 'tests', command: 'cargo test', phase: 'test' },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('Godot fixture (with addons/gut) emits gut runner', () => {
    const dir = stageFixture('godot');
    try {
      bootstrapProveJson(dir);
      expect(readConfig(dir).validators).toEqual([
        {
          name: 'tests',
          command: 'godot --headless -s addons/gut/gut_cmdln.gd',
          phase: 'test',
        },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('Makefile fixture emits make test', () => {
    const dir = stageFixture('make');
    try {
      bootstrapProveJson(dir);
      expect(readConfig(dir).validators).toEqual([
        { name: 'tests', command: 'make test', phase: 'test' },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('bootstrapProveJson — file lifecycle', () => {
  test('no-op when `.claude/.prove.json` already exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'installer-noop-'));
    try {
      mkdirSync(join(dir, '.claude'));
      const path = join(dir, '.claude', '.prove.json');
      const original = '{"schema_version":"999","validators":[],"reporters":[]}';
      writeFileSync(path, original);
      bootstrapProveJson(dir); // no --force
      expect(readFileSync(path, 'utf8')).toBe(original);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('--force preserves user-custom validators while replacing detected section', () => {
    const dir = stageFixture('go');
    try {
      // Prime a pre-existing config: one go-detected entry plus a user
      // custom entry the reemit must not destroy. `reporters` must also
      // survive, as well as top-level extras.
      mkdirSync(join(dir, '.claude'), { recursive: true });
      const path = join(dir, '.claude', '.prove.json');
      writeFileSync(
        path,
        JSON.stringify({
          schema_version: '3',
          validators: [
            { name: 'build', command: 'go build ./...', phase: 'build' },
            { name: 'my-custom', command: './scripts/lint.sh', phase: 'lint' },
          ],
          reporters: [{ name: 'slack', command: './notify.sh', events: ['step-complete'] }],
          scopes: { cli: 'packages/cli' },
        }),
      );

      bootstrapProveJson(dir, { force: true });
      const after = readConfig(dir);
      expect(after.schema_version).toBe(CURRENT_SCHEMA_VERSION);
      expect(after.validators).toEqual([
        { name: 'build', command: 'go build ./...', phase: 'build' },
        { name: 'lint', command: 'go vet ./...', phase: 'lint' },
        { name: 'tests', command: 'go test ./...', phase: 'test' },
        // user-custom entries retained at the tail.
        { name: 'my-custom', command: './scripts/lint.sh', phase: 'lint' },
      ]);
      expect(after.reporters).toEqual([
        { name: 'slack', command: './notify.sh', events: ['step-complete'] },
      ]);
      expect(after.scopes).toEqual({ cli: 'packages/cli' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('creates `.claude/` if missing and writes trailing newline', () => {
    const dir = mkdtempSync(join(tmpdir(), 'installer-mkdir-'));
    try {
      writeFileSync(join(dir, 'package.json'), '{"name":"x"}');
      bootstrapProveJson(dir);
      const raw = readFileSync(join(dir, '.claude', '.prove.json'), 'utf8');
      expect(raw.endsWith('\n')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('leaves no `.tmp` residue from atomic write', () => {
    const dir = mkdtempSync(join(tmpdir(), 'installer-tmp-'));
    try {
      writeFileSync(join(dir, 'package.json'), '{"name":"x"}');
      bootstrapProveJson(dir);
      expect(existsSync(join(dir, '.claude', '.prove.json.tmp'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
