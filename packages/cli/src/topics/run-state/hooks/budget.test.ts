/**
 * Per-task tool-call budget tests for the PreToolUse bounds hook.
 *
 * `checkToolCallBudget` is exercised directly against a real counter directory
 * in a temp dir so counter persistence across calls is asserted on the actual
 * filesystem. Integration through `runBoundsHook` (scope-pass → budget-count,
 * scope-deny → no count) is covered with an injected `ActiveBounds` stub. The
 * CLI boundary (stdin → exit) is covered in `dispatch.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActiveBounds, BoundsHookDeps } from './bounds';
import { runBoundsHook } from './bounds';
import { checkToolCallBudget, counterPath } from './budget';

describe('checkToolCallBudget', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'budget-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('under budget passes silently (exit 0, no stdout/stderr)', () => {
    const result = checkToolCallBudget('t1', { tool_calls: 10 }, dir);
    expect(result).toEqual({ exitCode: 0, stdout: '', stderr: '' });
  });

  test('soft-warns (non-blocking stderr) on entering the warning band', () => {
    // Budget 10, warn band starts at ceil(0.8 * 10) = 8. Calls 1-7 are silent.
    for (let i = 1; i <= 7; i++) {
      expect(checkToolCallBudget('t1', { tool_calls: 10 }, dir)).toEqual({
        exitCode: 0,
        stdout: '',
        stderr: '',
      });
    }
    // Call 8 enters the warning band: stderr note, no block, exit 0.
    const warn = checkToolCallBudget('t1', { tool_calls: 10 }, dir);
    expect(warn.exitCode).toBe(0);
    expect(warn.stdout).toBe('');
    expect(warn.stderr).toContain('8 of 10');
    expect(warn.stderr).toContain('budget warning');
  });

  test('hard-stops at the budget with canonical deny (permissionDecision:deny + exit 0)', () => {
    // Budget 3: calls 1-2 silent, call 3 denies (count >= limit).
    checkToolCallBudget('t1', { tool_calls: 3 }, dir);
    checkToolCallBudget('t1', { tool_calls: 3 }, dir);
    const stop = checkToolCallBudget('t1', { tool_calls: 3 }, dir);
    expect(stop.exitCode).toBe(0);
    expect(stop.stdout).toContain('"permissionDecision": "deny"');
    expect(stop.stdout).toContain('3 of 3');
    expect(stop.stdout).toContain('budgets.tool_calls');
    expect(stop.stderr).toBe('');
  });

  test('stays hard-stopped over the budget on subsequent calls', () => {
    for (let i = 1; i <= 2; i++) checkToolCallBudget('t1', { tool_calls: 2 }, dir);
    // Calls 2 and beyond all deny.
    const over = checkToolCallBudget('t1', { tool_calls: 2 }, dir);
    expect(over.stdout).toContain('"permissionDecision": "deny"');
  });

  test('counter persists across calls in a per-task file', () => {
    checkToolCallBudget('t1', { tool_calls: 100 }, dir);
    checkToolCallBudget('t1', { tool_calls: 100 }, dir);
    checkToolCallBudget('t1', { tool_calls: 100 }, dir);
    const raw = readFileSync(counterPath(dir, 't1'), 'utf8');
    expect(raw).toBe('3');
  });

  test('separate tasks keep independent counters', () => {
    checkToolCallBudget('t1', { tool_calls: 100 }, dir);
    checkToolCallBudget('t1', { tool_calls: 100 }, dir);
    checkToolCallBudget('t2', { tool_calls: 100 }, dir);
    expect(readFileSync(counterPath(dir, 't1'), 'utf8')).toBe('2');
    expect(readFileSync(counterPath(dir, 't2'), 'utf8')).toBe('1');
  });

  test('a task id containing a path separator cannot escape the budget dir', () => {
    // encodeURIComponent('a/b') === 'a%2Fb', so the file stays inside .prove/budget.
    const path = counterPath(dir, 'a/b');
    expect(path).toContain('a%2Fb.count');
    expect(path).not.toContain('budget/a/b');
  });

  test('absent tool_calls budget is permissive (no counter written)', () => {
    expect(checkToolCallBudget('t1', undefined, dir)).toEqual({
      exitCode: 0,
      stdout: '',
      stderr: '',
    });
    expect(checkToolCallBudget('t1', { tokens: 1000 }, dir)).toEqual({
      exitCode: 0,
      stdout: '',
      stderr: '',
    });
  });

  test('non-positive tool_calls budget is permissive', () => {
    expect(checkToolCallBudget('t1', { tool_calls: 0 }, dir)).toEqual({
      exitCode: 0,
      stdout: '',
      stderr: '',
    });
  });
});

describe('runBoundsHook — budget integration', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'budget-integ-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function stubDeps(active: ActiveBounds): BoundsHookDeps {
    return { resolveActiveBounds: () => active };
  }

  test('counts a relevant tool call against the budget and hard-stops at the limit', () => {
    const active: ActiveBounds = {
      taskId: 't1',
      bounds: { budgets: { tool_calls: 2 } },
      projectRoot: dir,
    };
    const call = () =>
      runBoundsHook(
        { tool_name: 'Read', tool_input: { file_path: join(dir, 'x.ts') }, cwd: dir },
        stubDeps(active),
      );
    expect(call().stdout).toBe(''); // call 1
    const stop = call(); // call 2 == limit
    expect(stop.stdout).toContain('"permissionDecision": "deny"');
    expect(stop.exitCode).toBe(0);
  });

  test('a scope-denied call does NOT consume the tool-call budget', () => {
    // Write outside the write scope is scope-denied before counting; the
    // counter file must not be created.
    const active: ActiveBounds = {
      taskId: 't1',
      bounds: { write: ['src/**'], budgets: { tool_calls: 2 } },
      projectRoot: dir,
    };
    const denied = runBoundsHook(
      { tool_name: 'Write', tool_input: { file_path: join(dir, 'docs/x.md') }, cwd: dir },
      stubDeps(active),
    );
    expect(denied.stdout).toContain('"permissionDecision": "deny"');
    expect(denied.stdout).toContain('docs/x.md');
    expect(() => readFileSync(counterPath(dir, 't1'), 'utf8')).toThrow();
  });

  test('an in-scope call passes the scope wall then counts against the budget', () => {
    const active: ActiveBounds = {
      taskId: 't1',
      bounds: { write: ['src/**'], budgets: { tool_calls: 5 } },
      projectRoot: dir,
    };
    const result = runBoundsHook(
      { tool_name: 'Write', tool_input: { file_path: join(dir, 'src/a.ts') }, cwd: dir },
      stubDeps(active),
    );
    expect(result.stdout).toBe('');
    expect(readFileSync(counterPath(dir, 't1'), 'utf8')).toBe('1');
  });

  test('an irrelevant (uncounted) tool never touches the counter', () => {
    const active: ActiveBounds = {
      taskId: 't1',
      bounds: { budgets: { tool_calls: 2 } },
      projectRoot: dir,
    };
    const result = runBoundsHook(
      { tool_name: 'Glob', tool_input: { pattern: '**' }, cwd: dir },
      stubDeps(active),
    );
    expect(result.stdout).toBe('');
    expect(() => readFileSync(counterPath(dir, 't1'), 'utf8')).toThrow();
  });
});
