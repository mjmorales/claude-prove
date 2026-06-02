/**
 * PostToolUse capture hook tests.
 *
 * The append path is exercised against a real run dir in a temp dir so the
 * on-disk `capture` entry (type, summary, target) is asserted on the actual
 * filesystem. Deps (`resolveRunDir`, `now`, `uuid`) are injected for
 * determinism. The never-blocks contract — no active run, append failure,
 * empty/unparseable payload — is asserted to always return EMPTY_HOOK_RESULT
 * and never throw. The CLI boundary (stdin → exit) is covered in
 * `dispatch.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LogEntry } from '../../acb/reasoning-log';
import { listEntries } from '../../acb/reasoning-log-store';
import { type CaptureHookDeps, runCaptureHook } from './capture';
import { EMPTY_HOOK_RESULT } from './types';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'capture-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Deps stub: a fixed run dir + deterministic clock/uuid. A `null` run dir
 *  models "no active run". */
function stubDeps(runDir: string | null, id = 'cap-1'): CaptureHookDeps {
  return {
    resolveRunDir: () => runDir,
    now: () => '2026-06-02T00:00:00.000Z',
    uuid: () => id,
  };
}

/** Read back the single appended capture entry from a run dir. */
function onlyEntry(runDir: string): LogEntry {
  const entries = listEntries(runDir);
  expect(entries).toHaveLength(1);
  const entry = entries[0];
  if (!entry) throw new Error('expected one entry');
  return entry;
}

describe('runCaptureHook — appends a capture entry', () => {
  test('Write captures the file_path target with a `<Tool> <path>` summary', () => {
    const result = runCaptureHook(
      { tool_name: 'Write', tool_input: { file_path: 'packages/x.ts' }, cwd: dir },
      stubDeps(dir),
    );
    expect(result).toEqual(EMPTY_HOOK_RESULT);

    const entry = onlyEntry(dir);
    expect(entry.type).toBe('capture');
    expect(entry.body).toBe('Write packages/x.ts');
    if (entry.type === 'capture') {
      expect(entry.tool).toBe('Write');
      expect(entry.target).toBe('packages/x.ts');
    }
  });

  test('Bash captures the command as the target', () => {
    runCaptureHook(
      { tool_name: 'Bash', tool_input: { command: 'bun run build' }, cwd: dir },
      stubDeps(dir),
    );
    const entry = onlyEntry(dir);
    expect(entry.body).toBe('Bash bun run build');
    if (entry.type === 'capture') {
      expect(entry.tool).toBe('Bash');
      expect(entry.target).toBe('bun run build');
    }
  });

  test('Read captures the file_path target', () => {
    runCaptureHook(
      { tool_name: 'Read', tool_input: { file_path: '/abs/notes.md' }, cwd: dir },
      stubDeps(dir),
    );
    const entry = onlyEntry(dir);
    expect(entry.body).toBe('Read /abs/notes.md');
    if (entry.type === 'capture') {
      expect(entry.tool).toBe('Read');
      expect(entry.target).toBe('/abs/notes.md');
    }
  });

  test('a tool with no checkable target captures the tool name alone (no target)', () => {
    runCaptureHook({ tool_name: 'Glob', tool_input: { pattern: '**' }, cwd: dir }, stubDeps(dir));
    const entry = onlyEntry(dir);
    expect(entry.body).toBe('Glob');
    if (entry.type === 'capture') {
      expect(entry.tool).toBe('Glob');
      expect(entry.target).toBeUndefined();
    }
  });

  test('a long Bash command is truncated with an ellipsis', () => {
    const cmd = `echo ${'x'.repeat(1000)}`;
    runCaptureHook({ tool_name: 'Bash', tool_input: { command: cmd }, cwd: dir }, stubDeps(dir));
    const entry = onlyEntry(dir);
    if (entry.type === 'capture') {
      expect(entry.target?.length).toBeLessThanOrEqual(500);
      expect(entry.target?.endsWith('…')).toBe(true);
    }
  });

  test('the appended entry is typed `capture` and append-only — a second call adds a new file', () => {
    runCaptureHook(
      { tool_name: 'Write', tool_input: { file_path: 'a.ts' }, cwd: dir },
      stubDeps(dir, 'cap-1'),
    );
    runCaptureHook(
      { tool_name: 'Write', tool_input: { file_path: 'b.ts' }, cwd: dir },
      stubDeps(dir, 'cap-2'),
    );
    const entries = listEntries(dir);
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.type === 'capture')).toBe(true);
    expect(entries.map((e) => e.body).sort()).toEqual(['Write a.ts', 'Write b.ts']);
  });
});

describe('runCaptureHook — never blocks, never throws', () => {
  test('no active run → no-op, exit 0, nothing written', () => {
    const result = runCaptureHook(
      { tool_name: 'Write', tool_input: { file_path: 'x.ts' }, cwd: dir },
      stubDeps(null),
    );
    expect(result).toEqual(EMPTY_HOOK_RESULT);
    expect(listEntries(dir)).toEqual([]);
  });

  test('null payload → no-op, exit 0', () => {
    expect(runCaptureHook(null, stubDeps(dir))).toEqual(EMPTY_HOOK_RESULT);
    expect(listEntries(dir)).toEqual([]);
  });

  test('missing tool_name → no-op, exit 0', () => {
    expect(runCaptureHook({ cwd: dir }, stubDeps(dir))).toEqual(EMPTY_HOOK_RESULT);
    expect(listEntries(dir)).toEqual([]);
  });

  test('append failure → exit 0, never throws', () => {
    // A run dir under a non-existent, unwritable parent makes appendEntry's
    // mkdir/write throw; the hook must swallow it and still return empty.
    const unwritable = '/proc/nonexistent-capture-run-dir/x';
    const result = runCaptureHook(
      { tool_name: 'Write', tool_input: { file_path: 'x.ts' }, cwd: dir },
      stubDeps(unwritable),
    );
    expect(result).toEqual(EMPTY_HOOK_RESULT);
  });

  test('a deps resolver that throws is swallowed (exit 0)', () => {
    const throwingDeps: CaptureHookDeps = {
      resolveRunDir: () => {
        throw new Error('resolution blew up');
      },
      now: () => '2026-06-02T00:00:00.000Z',
      uuid: () => 'cap-x',
    };
    expect(() =>
      runCaptureHook(
        { tool_name: 'Write', tool_input: { file_path: 'x.ts' }, cwd: dir },
        throwingDeps,
      ),
    ).not.toThrow();
  });
});
