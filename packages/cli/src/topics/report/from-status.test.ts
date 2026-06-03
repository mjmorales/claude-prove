/**
 * Status snapshot → report/v1 dashboard compiler tests. The compiled document
 * must validate, and the tree-aware rollup must flatten depth-first with indented
 * task rows.
 */

import { describe, expect, test } from 'bun:test';
import type { Snapshot } from '../scrum/cli/status-cmd';
import { validateReportDocument } from './blocks';
import { statusSnapshotToReportDocument } from './from-status';

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    active_tasks: [],
    task_tree: [],
    milestones: [],
    total_milestones: 0,
    recent_events: [],
    ...overrides,
  } as Snapshot;
}

describe('statusSnapshotToReportDocument', () => {
  test('compiles a populated snapshot into a valid dashboard document', () => {
    const snap = snapshot({
      milestones: [{ id: 'm1', title: 'Auth', status: 'active' }] as Snapshot['milestones'],
      total_milestones: 2,
      task_tree: [
        {
          id: 'e1',
          title: 'Epic',
          layer: 'epic',
          status: 'in_progress',
          derived_status: 'in_progress',
          children: [
            {
              id: 's1',
              title: 'Story',
              layer: 'story',
              status: 'ready',
              derived_status: 'ready',
              children: [],
            },
          ],
        },
      ],
      active_tasks: [{ id: 's1', title: 'Story', status: 'ready' }] as Snapshot['active_tasks'],
    });
    const doc = statusSnapshotToReportDocument(snap);
    expect(validateReportDocument(doc)).toEqual([]);
    expect(doc.title).toBe('Scrum Status');
  });

  test('flattens the task forest depth-first with indented child rows', () => {
    const snap = snapshot({
      task_tree: [
        {
          id: 'e1',
          title: 'Epic',
          layer: 'epic',
          status: 'in_progress',
          derived_status: 'in_progress',
          children: [
            {
              id: 's1',
              title: 'Story',
              layer: 'story',
              status: 'ready',
              derived_status: 'ready',
              children: [],
            },
          ],
        },
      ],
    });
    const doc = statusSnapshotToReportDocument(snap);
    const treeSection = doc.blocks.find(
      (b) => b.type === 'section' && b.title?.startsWith('Task tree'),
    );
    const table = treeSection?.type === 'section' ? treeSection.blocks[0] : undefined;
    expect(table?.type).toBe('table');
    if (table?.type === 'table') {
      expect(table.rows[0]?.[0]).toBe('e1: Epic'); // root, no indent
      expect(table.rows[1]?.[0]).toBe('— s1: Story'); // child, one indent
    }
  });

  test('an empty snapshot still validates with empty-state placeholders', () => {
    const doc = statusSnapshotToReportDocument(snapshot());
    expect(validateReportDocument(doc)).toEqual([]);
  });
});
