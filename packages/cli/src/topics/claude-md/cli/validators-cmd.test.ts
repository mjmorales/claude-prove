/**
 * Parity tests for `prove claude-md validators`.
 *
 * Covers the output format formerly produced by the inline Python in
 * `skills/task/scripts/gather-context.sh`:
 *   - one line per validator with non-empty `command`
 *   - format: `- <phase>: \`<command>\``
 *   - missing file / missing key / bad JSON → empty output, exit 0
 *   - prompt-only validators (no command) are skipped
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runValidators } from './generate-cmd';

let root: string;
let stdoutBuf: string;
let writeSpy: ReturnType<typeof spyStdout>;

function spyStdout() {
  const orig = process.stdout.write.bind(process.stdout);
  stdoutBuf = '';
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdoutBuf += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  return {
    restore: () => {
      process.stdout.write = orig;
    },
  };
}

function writeConfig(validators: unknown): void {
  const dir = join(root, '.claude');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.prove.json'), JSON.stringify({ schema_version: '5', validators }));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'validators-'));
  writeSpy = spyStdout();
});

afterEach(() => {
  writeSpy.restore();
  rmSync(root, { recursive: true, force: true });
});

describe('claude-md validators', () => {
  test('emits one line per validator with non-empty command', () => {
    writeConfig([
      { name: 'build', phase: 'build', command: 'bun tsc --build' },
      { name: 'lint', phase: 'lint', command: 'biome check' },
      { name: 'tests', phase: 'test', command: 'bun test' },
    ]);
    const code = runValidators({ projectRoot: root });
    expect(code).toBe(0);
    expect(stdoutBuf).toBe(
      '- build: `bun tsc --build`\n- lint: `biome check`\n- test: `bun test`\n',
    );
  });

  test('skips prompt-only validators (no command field)', () => {
    writeConfig([
      { name: 'build', phase: 'build', command: 'bun tsc --build' },
      { name: 'doc', phase: 'llm', prompt: '.prove/prompts/doc.md' },
    ]);
    const code = runValidators({ projectRoot: root });
    expect(code).toBe(0);
    expect(stdoutBuf).toBe('- build: `bun tsc --build`\n');
  });

  test('missing .claude/.prove.json → no output, exit 0', () => {
    const code = runValidators({ projectRoot: root });
    expect(code).toBe(0);
    expect(stdoutBuf).toBe('');
  });

  test('malformed JSON → no output, exit 0 (hook non-fatal)', () => {
    const dir = join(root, '.claude');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.prove.json'), '{ not json');
    const code = runValidators({ projectRoot: root });
    expect(code).toBe(0);
    expect(stdoutBuf).toBe('');
  });

  test('no validators key → no output, exit 0', () => {
    const dir = join(root, '.claude');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.prove.json'), JSON.stringify({ schema_version: '5' }));
    const code = runValidators({ projectRoot: root });
    expect(code).toBe(0);
    expect(stdoutBuf).toBe('');
  });
});
