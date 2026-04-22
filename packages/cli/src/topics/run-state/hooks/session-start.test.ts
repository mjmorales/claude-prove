/**
 * SessionStart hook tests.
 *
 * Verifies we emit `additionalContext` only when an active run exists, and
 * that the format matches the Python reference ("- branch/slug: status @ step").
 */

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSessionStart } from './session-start';

function mkProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'session-start-'));
  mkdirSync(join(root, '.prove', 'runs'), { recursive: true });
  return root;
}

function writeState(project: string, branch: string, slug: string, data: Record<string, unknown>) {
  const dir = join(project, '.prove', 'runs', branch, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'state.json'), JSON.stringify(data));
}

describe('runSessionStart', () => {
  test('emits additionalContext for a running active run', () => {
    const root = mkProject();
    try {
      writeState(root, 'feature', 'demo', {
        schema_version: '1',
        kind: 'state',
        run_status: 'running',
        slug: 'demo',
        branch: 'feature',
        updated_at: 't',
        current_step: '1.1.1',
        tasks: [],
      });
      const result = runSessionStart({ cwd: root });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('"hookEventName": "SessionStart"');
      expect(result.stdout).toContain('feature/demo');
      expect(result.stdout).toContain('running');
      expect(result.stdout).toContain('@ 1.1.1');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('silent when runs dir does not exist', () => {
    const root = mkdtempSync(join(tmpdir(), 'session-start-'));
    try {
      const result = runSessionStart({ cwd: root });
      expect(result).toEqual({ exitCode: 0, stdout: '', stderr: '' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('skips completed runs', () => {
    const root = mkProject();
    try {
      writeState(root, 'main', 'done', {
        schema_version: '1',
        kind: 'state',
        run_status: 'completed',
        slug: 'done',
        branch: 'main',
        updated_at: 't',
        tasks: [],
      });
      const result = runSessionStart({ cwd: root });
      expect(result.stdout).toBe('');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('omits @ suffix when current_step is empty', () => {
    const root = mkProject();
    try {
      writeState(root, 'main', 'demo', {
        schema_version: '1',
        kind: 'state',
        run_status: 'halted',
        slug: 'demo',
        branch: 'main',
        updated_at: 't',
        current_step: '',
        tasks: [],
      });
      const result = runSessionStart({ cwd: root });
      expect(result.stdout).toContain('main/demo: halted');
      expect(result.stdout).not.toContain('@');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('tolerates non-JSON state files', () => {
    const root = mkProject();
    try {
      const dir = join(root, '.prove', 'runs', 'main', 'bad');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'state.json'), 'not json');
      const result = runSessionStart({ cwd: root });
      expect(result.stdout).toBe('');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
