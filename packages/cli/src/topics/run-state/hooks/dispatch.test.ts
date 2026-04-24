/**
 * Dispatch + CLI-shape tests for the run-state hook subcommand.
 *
 * Spawns `bun run packages/cli/bin/run.ts run-state hook <event>` with a
 * canned payload on stdin and asserts stdout/stderr/exit for the CLI
 * boundary. Pure-logic tests live alongside each hook module.
 */

import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

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
    stdin: new Blob([stdin]),
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
      stdin: new Blob(['']),
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
});
