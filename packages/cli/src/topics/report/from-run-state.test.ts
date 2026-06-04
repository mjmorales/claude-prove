/**
 * Run-state → report/v1 timeline compiler tests. The compiled document must
 * validate, carry the run header, and render one section per task with a steps
 * table.
 */

import { describe, expect, test } from 'bun:test';
import type { StateData } from '../run-state/state';
import { validateReportDocument } from './blocks';
import { runStateToReportDocument } from './from-run-state';

function state(overrides: Partial<StateData> = {}): StateData {
  return {
    schema_version: '4',
    kind: 'state',
    run_status: 'running',
    slug: 'add-login',
    branch: 'feature',
    current_task: '1',
    current_step: '1.1',
    started_at: '2026-06-03T09:00:00Z',
    updated_at: '2026-06-03T10:00:00Z',
    ended_at: '',
    tasks: [],
    dispatch: { dispatched: [] },
    ...overrides,
  };
}

describe('runStateToReportDocument', () => {
  test('compiles a run with tasks + steps into a valid timeline document', () => {
    const doc = runStateToReportDocument(
      state({
        tasks: [
          {
            id: '1',
            status: 'in_progress',
            started_at: '2026-06-03T09:05:00Z',
            ended_at: '',
            review: { verdict: 'pending', notes: '', reviewer: '', reviewed_at: '' },
            steps: [
              {
                id: '1.1',
                status: 'completed',
                started_at: '',
                ended_at: '',
                commit_sha: 'abc123',
                validator_summary: {
                  build: 'pass',
                  lint: 'pass',
                  test: 'pass',
                  custom: 'skipped',
                  llm: 'skipped',
                },
                halt_reason: '',
              },
            ],
          },
        ],
      }),
    );
    expect(validateReportDocument(doc)).toEqual([]);
    expect(doc.title).toBe('Run timeline: feature/add-login');
    const taskSection = doc.blocks.find((b) => b.type === 'section' && b.title === 'Task 1');
    expect(taskSection).toBeDefined();
  });

  test('the run header keyValue carries status and run id', () => {
    const doc = runStateToReportDocument(state({ run_status: 'halted' }));
    const kv = doc.blocks.find((b) => b.type === 'keyValue');
    const items = kv?.type === 'keyValue' ? kv.items : [];
    expect(items.find((i) => i.key === 'Run')?.value).toBe('`feature/add-login`');
    expect(items.find((i) => i.key === 'Status')?.value).toBe('halted');
  });

  test('an empty run still validates with a no-tasks placeholder', () => {
    const doc = runStateToReportDocument(state());
    expect(validateReportDocument(doc)).toEqual([]);
  });
});
