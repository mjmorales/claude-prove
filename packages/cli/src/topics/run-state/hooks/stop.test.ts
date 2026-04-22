/**
 * Stop hook tests.
 *
 * Verifies the reconcile-on-exit behavior: an in_progress step gets halted
 * with the session-end diagnostic, and the systemMessage lists the change.
 */

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runStop } from './stop';

function mkProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'stop-hook-'));
  mkdirSync(join(root, '.prove', 'runs'), { recursive: true });
  return root;
}

function writeState(project: string, branch: string, slug: string, data: Record<string, unknown>) {
  const dir = join(project, '.prove', 'runs', branch, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'state.json'), `${JSON.stringify(data, null, 2)}\n`);
}

describe('runStop', () => {
  test('silent when runs dir is absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'stop-hook-'));
    try {
      expect(runStop({ cwd: root })).toEqual({ exitCode: 0, stdout: '', stderr: '' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('silent when no in_progress steps', () => {
    const root = mkProject();
    try {
      writeState(root, 'feature', 'demo', {
        schema_version: '1',
        kind: 'state',
        run_status: 'pending',
        slug: 'demo',
        branch: 'feature',
        updated_at: 't',
        tasks: [],
        dispatch: { dispatched: [] },
      });
      const result = runStop({ cwd: root });
      expect(result.stdout).toBe('');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('halts in_progress step and emits systemMessage', () => {
    const root = mkProject();
    try {
      writeState(root, 'feature', 'demo', {
        schema_version: '1',
        kind: 'state',
        run_status: 'running',
        slug: 'demo',
        branch: 'feature',
        updated_at: 't',
        tasks: [
          {
            id: '1.1',
            status: 'in_progress',
            started_at: 't',
            ended_at: '',
            review: { verdict: 'pending', notes: '', reviewer: '', reviewed_at: '' },
            steps: [
              {
                id: '1.1.1',
                status: 'in_progress',
                started_at: 't',
                ended_at: '',
                commit_sha: '',
                validator_summary: {
                  build: 'pending',
                  lint: 'pending',
                  test: 'pending',
                  custom: 'pending',
                  llm: 'pending',
                },
                halt_reason: '',
              },
            ],
          },
        ],
        dispatch: { dispatched: [] },
      });

      const result = runStop({ cwd: root });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('"systemMessage"');
      expect(result.stdout).toContain('feature/demo 1.1.1');
      expect(result.stdout).toContain('halted');

      const after = JSON.parse(
        readFileSync(join(root, '.prove', 'runs', 'feature', 'demo', 'state.json'), 'utf8'),
      );
      expect(after.tasks[0].steps[0].status).toBe('halted');
      expect(after.tasks[0].steps[0].halt_reason).toContain('session ended');
      expect(after.run_status).toBe('halted');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
