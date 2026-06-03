/**
 * Compile a run-state `StateData` (a run's live execution state) into a report/v1
 * `ReportDocument` — a read-only run timeline. Mechanical: state in, blocks out.
 * The state shape is owned by the run-state topic; this module maps its run
 * header + per-task step progression to blocks.
 */

import type { StateData, TaskData } from '../run-state/state';
import type { Block, ReportDocument } from './blocks';

/** One task → a section with a steps table (the per-task timeline). */
function taskSection(task: TaskData): Block {
  const stepRows = task.steps.map((s) => [s.id, s.status, s.commit_sha || '', s.halt_reason || '']);
  const inner: Block[] = [
    {
      type: 'keyValue',
      items: [
        { key: 'Status', value: task.status },
        { key: 'Review', value: task.review.verdict },
        { key: 'Started', value: task.started_at || '—' },
        { key: 'Ended', value: task.ended_at || '—' },
      ],
    },
  ];
  inner.push(
    stepRows.length > 0
      ? { type: 'table', columns: ['Step', 'Status', 'Commit', 'Halt'], rows: stepRows }
      : { type: 'paragraph', text: 'No steps.' },
  );
  return { type: 'section', title: `Task ${task.id}`, blocks: inner };
}

/** Compile a run-state document into a run-timeline report/v1 document. */
export function runStateToReportDocument(state: StateData): ReportDocument {
  const blocks: Block[] = [
    {
      type: 'keyValue',
      items: [
        { key: 'Run', value: `${state.branch}/${state.slug}` },
        { key: 'Status', value: state.run_status },
        { key: 'Current task', value: state.current_task || '—' },
        { key: 'Current step', value: state.current_step || '—' },
        { key: 'Started', value: state.started_at || '—' },
        { key: 'Updated', value: state.updated_at || '—' },
        { key: 'Ended', value: state.ended_at || '—' },
      ],
    },
    { type: 'divider' },
  ];

  if (state.tasks.length > 0) {
    blocks.push(...state.tasks.map(taskSection));
  } else {
    blocks.push({ type: 'paragraph', text: 'No tasks in this run.' });
  }

  return { schema_version: '1', title: `Run timeline: ${state.branch}/${state.slug}`, blocks };
}
