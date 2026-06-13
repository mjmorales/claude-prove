/**
 * Dispatch + CLI-shape tests for the run-state hook subcommand.
 *
 * Spawns `bun run packages/cli/bin/run.ts run-state hook <event>` with a
 * canned payload on stdin and asserts stdout/stderr/exit for the CLI
 * boundary. Pure-logic tests live alongside each hook module.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openScrumStore } from '../../scrum/store';

const CLI_PATH = resolve(import.meta.dir, '../../../../bin/run.ts');

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runHookCli(
  event: string,
  stdin: string,
  envExtras: Record<string, string> = {},
): CliResult {
  const env = { ...process.env, ...envExtras };
  Reflect.deleteProperty(env, 'RUN_STATE_ALLOW_DIRECT');
  const proc = Bun.spawnSync({
    cmd: ['bun', 'run', CLI_PATH, 'run-state', 'hook', event],
    // Buffer, NOT `new Blob(...)`: the web suites register happy-dom globals,
    // and any test-file order that runs a DOM suite before this one leaves a
    // shadowed globalThis.Blob whose instances Bun.spawnSync rejects with
    // "stdio must be an array of 'inherit', 'ignore', or null" (file order is
    // filesystem-dependent — it bites on Linux CI but not macOS). Buffer is
    // immune to DOM global shadowing.
    stdin: Buffer.from(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
    env,
  });
  return {
    exitCode: proc.exitCode ?? -1,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

describe('run-state hook <event> CLI', () => {
  test('unknown event exits 1 with hint', () => {
    const result = runHookCli('bogus', '{}');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unknown hook event 'bogus'");
  });

  test('missing event exits 1 with list of valid events', () => {
    const proc = Bun.spawnSync({
      cmd: ['bun', 'run', CLI_PATH, 'run-state', 'hook'],
      stdin: Buffer.from(''),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(proc.exitCode).toBe(1);
    expect(proc.stderr.toString()).toContain('hook event');
  });

  test('guard event denies state.json write via stdin payload', () => {
    const payload = JSON.stringify({
      tool_name: 'Write',
      tool_input: { file_path: '/a/.prove/runs/main/demo/state.json' },
    });
    const result = runHookCli('guard', payload);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('"permissionDecision": "deny"');
  });

  test('guard event passes empty stdin without crash', () => {
    const result = runHookCli('guard', '');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
  });

  test('session-start silent when no runs under cwd', () => {
    const payload = JSON.stringify({ cwd: '/tmp/no-such-project' });
    const result = runHookCli('session-start', payload);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
  });

  test('stop silent when no runs under cwd', () => {
    const payload = JSON.stringify({ cwd: '/tmp/no-such-project' });
    const result = runHookCli('stop', payload);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
  });

  test('subagent-stop silent without slug marker', () => {
    const payload = JSON.stringify({ cwd: '/tmp/no-such-project' });
    const result = runHookCli('subagent-stop', payload);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
  });

  test('bounds event passes with no project context', () => {
    const payload = JSON.stringify({
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/no-such-project/x.ts' },
      cwd: '/tmp/no-such-project',
    });
    const result = runHookCli('bounds', payload);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
  });

  test('capture event passes silently with no active run', () => {
    const payload = JSON.stringify({
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/no-such-project/x.ts' },
      cwd: '/tmp/no-such-project',
    });
    const result = runHookCli('capture', payload);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  test('capture event passes empty stdin without crash', () => {
    const result = runHookCli('capture', '');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
  });
});

describe('run-state hook bounds CLI — against a seeded store', () => {
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'bounds-cli-'));
    mkdirSync(join(dir, '.git'), { recursive: true });
    const store = await openScrumStore({ override: join(dir, '.prove', 'prove.db') });
    try {
      await store.createTask({ id: 't1', title: 'bounded', bounds: { write: ['src/**'] } });
      await store.updateTaskStatus('t1', 'ready');
      await store.updateTaskStatus('t1', 'in_progress');
    } finally {
      // Await every seed write before the sync close so no pending prepared
      // statement runs after the connection finalizes.
      store.close();
    }
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('denies an out-of-bounds write (permissionDecision:deny + exit 0)', () => {
    const payload = JSON.stringify({
      tool_name: 'Write',
      tool_input: { file_path: join(dir, 'docs/readme.md') },
      cwd: dir,
    });
    const result = runHookCli('bounds', payload);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('"permissionDecision": "deny"');
    expect(result.stdout).toContain('docs/readme.md');
  });

  test('passes an in-bounds write', () => {
    const payload = JSON.stringify({
      tool_name: 'Write',
      tool_input: { file_path: join(dir, 'src/auth/login.ts') },
      cwd: dir,
    });
    const result = runHookCli('bounds', payload);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
  });
});
