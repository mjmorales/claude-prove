/**
 * PostToolUse validate-hook tests.
 *
 * Exercises the on-disk validation path: write a stub artifact, run the
 * hook against a matching tool payload, assert the decision shape.
 */

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runValidateHook } from './validate';

function mkRunDir(): { root: string; runDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'validate-hook-'));
  const runDir = join(root, '.prove', 'runs', 'main', 'demo');
  mkdirSync(runDir, { recursive: true });
  return { root, runDir };
}

describe('runValidateHook', () => {
  test('blocks invalid plan.json and includes findings', () => {
    const { root, runDir } = mkRunDir();
    try {
      const planPath = join(runDir, 'plan.json');
      writeFileSync(planPath, JSON.stringify({ kind: 'plan' }));

      const result = runValidateHook({
        tool_name: 'Write',
        tool_input: { file_path: planPath },
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('"decision": "block"');
      expect(result.stdout).toContain('Schema validation failed for plan.json');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('passes on valid prd.json', () => {
    const { root, runDir } = mkRunDir();
    try {
      const prdPath = join(runDir, 'prd.json');
      writeFileSync(
        prdPath,
        JSON.stringify({
          schema_version: '1',
          kind: 'prd',
          title: 'T',
        }),
      );

      const result = runValidateHook({
        tool_name: 'Write',
        tool_input: { file_path: prdPath },
      });
      expect(result).toEqual({ exitCode: 0, stdout: '', stderr: '' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('validates report files under reports/', () => {
    const { root, runDir } = mkRunDir();
    try {
      const reportsDir = join(runDir, 'reports');
      mkdirSync(reportsDir, { recursive: true });
      const reportPath = join(reportsDir, '1_1_1.json');
      writeFileSync(reportPath, JSON.stringify({ kind: 'report' })); // missing required fields

      const result = runValidateHook({
        tool_name: 'Write',
        tool_input: { file_path: reportPath },
      });
      expect(result.stdout).toContain('"decision": "block"');
      expect(result.stdout).toContain('Schema validation failed for 1_1_1.json');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('ignores non-run-artifact paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'validate-hook-'));
    try {
      const p = join(root, 'random.json');
      writeFileSync(p, '{"foo":"bar"}');
      const result = runValidateHook({
        tool_name: 'Write',
        tool_input: { file_path: p },
      });
      expect(result.stdout).toBe('');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('ignores non-Write tools', () => {
    const result = runValidateHook({
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });
    expect(result.stdout).toBe('');
  });

  test('silent on null payload', () => {
    expect(runValidateHook(null)).toEqual({ exitCode: 0, stdout: '', stderr: '' });
  });

  test('ignores when file disappears between write and hook', () => {
    const { root, runDir } = mkRunDir();
    try {
      const p = join(runDir, 'plan.json'); // never written
      const result = runValidateHook({
        tool_name: 'Write',
        tool_input: { file_path: p },
      });
      expect(result.stdout).toBe('');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
