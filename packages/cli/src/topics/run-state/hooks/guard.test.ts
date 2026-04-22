/**
 * PreToolUse guard-hook tests.
 *
 * Verifies deny vs pass behavior across every tool name / path shape the
 * Python reference handles. Stdout byte-parity with Python is validated
 * by `hooks.parity.test.ts` — these tests cover pure logic so failures
 * point at one function.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { runGuard } from './guard';

describe('runGuard', () => {
  const savedEnv = process.env.RUN_STATE_ALLOW_DIRECT;
  beforeEach(() => {
    delete process.env.RUN_STATE_ALLOW_DIRECT;
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.RUN_STATE_ALLOW_DIRECT;
    else process.env.RUN_STATE_ALLOW_DIRECT = savedEnv;
  });

  test('denies Write on state.json under .prove/runs', () => {
    const result = runGuard({
      tool_name: 'Write',
      tool_input: { file_path: '/repo/.prove/runs/main/demo/state.json' },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('"permissionDecision": "deny"');
    expect(result.stdout).toContain('PreToolUse');
  });

  test('denies Edit + MultiEdit on state.json', () => {
    for (const tool of ['Edit', 'MultiEdit']) {
      const result = runGuard({
        tool_name: tool,
        tool_input: { file_path: '/a/.prove/runs/b/c/state.json' },
      });
      expect(result.stdout).toContain('"permissionDecision": "deny"');
    }
  });

  test('allows Bash and Read regardless of path', () => {
    const result = runGuard({
      tool_name: 'Read',
      tool_input: { file_path: '/a/.prove/runs/b/c/state.json' },
    });
    expect(result.stdout).toBe('');
    expect(result.exitCode).toBe(0);
  });

  test('allows plan.json / prd.json writes', () => {
    for (const fname of ['plan.json', 'prd.json']) {
      const result = runGuard({
        tool_name: 'Write',
        tool_input: { file_path: `/a/.prove/runs/b/c/${fname}` },
      });
      expect(result.stdout).toBe('');
    }
  });

  test('allows state.json outside .prove/runs', () => {
    const result = runGuard({
      tool_name: 'Write',
      tool_input: { file_path: '/a/b/state.json' },
    });
    expect(result.stdout).toBe('');
  });

  test('respects RUN_STATE_ALLOW_DIRECT=1 override', () => {
    process.env.RUN_STATE_ALLOW_DIRECT = '1';
    const result = runGuard({
      tool_name: 'Write',
      tool_input: { file_path: '/a/.prove/runs/b/c/state.json' },
    });
    expect(result.stdout).toBe('');
  });

  test('silent on null payload (malformed stdin)', () => {
    expect(runGuard(null)).toEqual({ exitCode: 0, stdout: '', stderr: '' });
  });

  test('silent on missing file_path', () => {
    const result = runGuard({ tool_name: 'Write', tool_input: {} });
    expect(result.stdout).toBe('');
  });

  test('normalizes backslashes before checking', () => {
    const result = runGuard({
      tool_name: 'Write',
      tool_input: { file_path: 'C:\\repo\\.prove\\runs\\b\\c\\state.json' },
    });
    expect(result.stdout).toContain('"permissionDecision": "deny"');
  });
});
