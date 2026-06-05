/**
 * reconcile.ts unit tests.
 *
 * Covers:
 *   - happy path: plan.json has task_id -> run_completed event, status
 *     transition on completed runs, context bundle rebuild, run link.
 *   - orphan path: plan.json lacks task_id -> unlinked_run_detected event
 *     under the `__orphan__` sentinel task.
 *   - buildContextBundle: aggregates files, decisions, run summaries.
 *   - sweepUnreconciled: idempotence via mtime cursor; errors collected.
 *
 * Tests use an in-memory scrum store per `openScrumStore({ path: ':memory:' })`
 * and write run fixtures under a fresh tmpdir. Several tests chdir into
 * the tmpdir so `reconcileRunCompleted`'s relative-path computation lines
 * up with the standard `.prove/runs/<branch>/<slug>` layout.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendEntry } from '../acb/reasoning-log-store';
import {
  type CurationProposedPayload,
  ORPHAN_TASK_ID,
  type TriggerBinding,
  bubbleStaleEscalations,
  buildContextBundle,
  computeBoundActions,
  detectContributionMiss,
  parseTeamAgentName,
  reconcileMilestoneClosed,
  reconcileRunCompleted,
  sweepUnreconciled,
  triggerBindingsForStatus,
} from './reconcile';
import { type ScrumStore, openScrumStore } from './store';
import { STALENESS_THRESHOLD_HOURS } from './types';

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let store: ScrumStore;
let project: string;
let prevCwd: string;

beforeEach(() => {
  store = openScrumStore({ path: ':memory:' });
  project = mkdtempSync(join(tmpdir(), 'scrum-reconcile-'));
  prevCwd = process.cwd();
  process.chdir(project);
});

afterEach(() => {
  process.chdir(prevCwd);
  store.close();
  rmSync(project, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

interface RunFixtureOptions {
  branch?: string;
  slug?: string;
  taskId?: string | null;
  /** When set, writes the scrum id nested at tasks[0].task_id instead of top-level. */
  nestedTaskId?: string;
  runStatus?: string;
  stewardVerdict?: string;
  commitShas?: string[];
}

function writeRun(opts: RunFixtureOptions = {}): string {
  const branch = opts.branch ?? 'feature';
  const slug = opts.slug ?? 'demo';
  const runDir = join(project, '.prove', 'runs', branch, slug);
  mkdirSync(runDir, { recursive: true });

  const planTask: Record<string, unknown> = { id: '1', title: 'step', steps: [] };
  if (opts.nestedTaskId !== undefined) planTask.task_id = opts.nestedTaskId;
  const plan: Record<string, unknown> = {
    schema_version: '5',
    kind: 'plan',
    mode: 'full',
    tasks: [planTask],
  };
  if (opts.taskId !== null && opts.taskId !== undefined) {
    plan.task_id = opts.taskId;
  }
  writeFileSync(join(runDir, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`);

  const steps = (opts.commitShas ?? ['abc123']).map((sha, i) => ({
    id: `1.${i + 1}`,
    status: 'completed',
    started_at: '2026-04-23T10:00:00Z',
    ended_at: '2026-04-23T11:00:00Z',
    commit_sha: sha,
    validator_summary: {
      build: 'pass',
      lint: 'pass',
      test: 'pass',
      custom: 'skipped',
      llm: 'skipped',
    },
    halt_reason: '',
  }));
  const state: Record<string, unknown> = {
    schema_version: '5',
    kind: 'state',
    run_status: opts.runStatus ?? 'completed',
    slug,
    branch,
    current_task: '1',
    current_step: '',
    started_at: '2026-04-23T09:00:00Z',
    updated_at: '2026-04-23T12:00:00Z',
    ended_at: '2026-04-23T12:00:00Z',
    tasks: [
      {
        id: '1',
        status: 'completed',
        started_at: '2026-04-23T10:00:00Z',
        ended_at: '2026-04-23T12:00:00Z',
        review: { verdict: 'pending', notes: '', reviewer: '', reviewed_at: '' },
        steps,
      },
    ],
    dispatch: { dispatched: [] },
  };
  if (opts.stewardVerdict) state.steward_verdict = opts.stewardVerdict;
  writeFileSync(join(runDir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);

  return join(runDir, 'state.json');
}

// ===========================================================================
// reconcileRunCompleted — happy path
// ===========================================================================

describe('reconcileRunCompleted — tracked run', () => {
  test('appends run_completed event and links run to task', () => {
    store.createTask({ id: 'scrum-10', title: 'Demo task' });
    const statePath = writeRun({ taskId: 'scrum-10' });

    const result = reconcileRunCompleted(statePath, store);
    expect(result.kind).toBe('reconciled');
    expect(result.taskId).toBe('scrum-10');

    const events = store.listEventsForTask('scrum-10');
    const kinds = events.map((e) => e.kind);
    // newest-first: status_changed (from done transition) + run_completed + task_created
    expect(kinds).toContain('run_completed');

    const runs = store.listRunsForTask('scrum-10');
    expect(runs).toHaveLength(1);
    expect(runs[0]?.branch).toBe('feature');
    expect(runs[0]?.slug).toBe('demo');
  });

  test('transitions task to done when run_status === completed', () => {
    store.createTask({ id: 'scrum-11', title: 'Demo', status: 'in_progress' });
    const statePath = writeRun({ taskId: 'scrum-11', runStatus: 'completed' });

    reconcileRunCompleted(statePath, store);
    expect(store.getTask('scrum-11')?.status).toBe('done');
  });

  test('does NOT transition task on halted or failed runs', () => {
    store.createTask({ id: 'scrum-12', title: 'Demo', status: 'in_progress' });
    const statePath = writeRun({ taskId: 'scrum-12', runStatus: 'halted' });

    reconcileRunCompleted(statePath, store);
    expect(store.getTask('scrum-12')?.status).toBe('in_progress');
  });

  test('appends steward_verdict event when present in state.json', () => {
    store.createTask({ id: 'scrum-13', title: 'Demo' });
    const statePath = writeRun({ taskId: 'scrum-13', stewardVerdict: 'approved' });

    reconcileRunCompleted(statePath, store);
    const events = store.listEventsForTask('scrum-13');
    expect(events.some((e) => e.kind === 'steward_verdict')).toBe(true);
  });

  test('rebuilds context bundle after reconcile', () => {
    store.createTask({ id: 'scrum-14', title: 'Demo' });
    const statePath = writeRun({ taskId: 'scrum-14', commitShas: ['sha-a', 'sha-b'] });

    reconcileRunCompleted(statePath, store);
    const bundle = store.loadContextBundle('scrum-14');
    expect(bundle).not.toBeNull();
    const payload = bundle?.bundle as { files: string[]; runs: unknown[] };
    expect(payload.files).toContain('commit:sha-a');
    expect(payload.files).toContain('commit:sha-b');
    expect(payload.runs).toHaveLength(1);
  });
});

// ===========================================================================
// reconcileRunCompleted — orphan path
// ===========================================================================

describe('reconcileRunCompleted — orphan run', () => {
  test('emits unlinked_run_detected under sentinel when task_id missing', () => {
    const statePath = writeRun({ taskId: null });

    const result = reconcileRunCompleted(statePath, store);
    expect(result.kind).toBe('orphan');
    expect(result.taskId).toBeNull();

    const sentinel = store.getTask(ORPHAN_TASK_ID);
    expect(sentinel).not.toBeNull();
    expect(sentinel?.title).toBe('Unlinked run detections');

    const events = store.listEventsForTask(ORPHAN_TASK_ID);
    expect(events.some((e) => e.kind === 'unlinked_run_detected')).toBe(true);
  });

  test('emits orphan event when plan.json references a missing task_id', () => {
    const statePath = writeRun({ taskId: 'does-not-exist' });

    const result = reconcileRunCompleted(statePath, store);
    expect(result.kind).toBe('orphan');
    expect(result.taskId).toBe('does-not-exist');
    expect(
      store.listEventsForTask(ORPHAN_TASK_ID).some((e) => e.kind === 'unlinked_run_detected'),
    ).toBe(true);
  });

  test('returns skipped on malformed state.json without throwing', () => {
    const runDir = join(project, '.prove', 'runs', 'feat-bad', 'run-1');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'state.json'), '{ not json');
    const result = reconcileRunCompleted(join(runDir, 'state.json'), store);
    expect(result.kind).toBe('skipped');
  });

  test('reuses existing orphan sentinel task across multiple calls', () => {
    const s1 = writeRun({ branch: 'feat-a', slug: 'one', taskId: null });
    const s2 = writeRun({ branch: 'feat-b', slug: 'two', taskId: null });

    reconcileRunCompleted(s1, store);
    reconcileRunCompleted(s2, store);

    const events = store.listEventsForTask(ORPHAN_TASK_ID);
    const orphanEvents = events.filter((e) => e.kind === 'unlinked_run_detected');
    expect(orphanEvents).toHaveLength(2);
  });

  test('revives a soft-deleted orphan sentinel instead of hitting a PK conflict', () => {
    // First orphan run creates the sentinel; an operator then soft-deletes it.
    reconcileRunCompleted(writeRun({ branch: 'feat-a', slug: 'one', taskId: null }), store);
    store.softDeleteTask(ORPHAN_TASK_ID);
    expect(store.getTask(ORPHAN_TASK_ID)).toBeNull();

    // A later orphan run must revive the sentinel, not throw a UNIQUE conflict.
    const result = reconcileRunCompleted(
      writeRun({ branch: 'feat-b', slug: 'two', taskId: null }),
      store,
    );
    expect(result.kind).toBe('orphan');
    expect(store.getTask(ORPHAN_TASK_ID)).not.toBeNull();
    expect(
      store.listEventsForTask(ORPHAN_TASK_ID).some((e) => e.kind === 'unlinked_run_detected'),
    ).toBe(true);
  });
});

// ===========================================================================
// reconcileRunCompleted — link resolution layers (gh#32 orphan split-brain)
// ===========================================================================

describe('reconcileRunCompleted — link resolution beyond top-level plan.task_id', () => {
  test('store run-link is authoritative when plan.json carries no task_id', () => {
    // The split-brain case: a run linked in the store (e.g. via `scrum
    // link-run`) whose plan.json was never updated must reconcile instead of
    // re-emitting unlinked_run_detected on every sweep.
    store.createTask({ id: 'scrum-40', title: 'Store-linked' });
    const statePath = writeRun({ branch: 'feat', slug: 'linked', taskId: null });
    store.linkRun({ taskId: 'scrum-40', runPath: join('.prove', 'runs', 'feat', 'linked') });

    const result = reconcileRunCompleted(statePath, store);
    expect(result.kind).toBe('reconciled');
    expect(result.taskId).toBe('scrum-40');

    // No orphan event was emitted under the sentinel.
    const sentinel = store.getTask(ORPHAN_TASK_ID);
    if (sentinel) {
      expect(
        store.listEventsForTask(ORPHAN_TASK_ID).some((e) => e.kind === 'unlinked_run_detected'),
      ).toBe(false);
    }
    expect(store.listEventsForTask('scrum-40').some((e) => e.kind === 'run_completed')).toBe(true);
  });

  test('a store-linked run sweeps clean — no unlinked_run_detected on repeated sweeps', () => {
    store.createTask({ id: 'scrum-41', title: 'Swept' });
    writeRun({ branch: 'feat', slug: 'swept', taskId: null });
    store.linkRun({ taskId: 'scrum-41', runPath: join('.prove', 'runs', 'feat', 'swept') });

    const r1 = sweepUnreconciled(store, 0);
    expect(r1.reconciled).toBe(1);
    expect(r1.errors).toHaveLength(0);

    const orphanEvents = store
      .listEventsForTask(ORPHAN_TASK_ID)
      .filter((e) => e.kind === 'unlinked_run_detected');
    expect(orphanEvents).toHaveLength(0);
  });

  test('nested tasks[n].task_id is recognized as the link', () => {
    store.createTask({ id: 'scrum-42', title: 'Nested' });
    const statePath = writeRun({
      branch: 'feat',
      slug: 'nested',
      taskId: null,
      nestedTaskId: 'scrum-42',
    });

    const result = reconcileRunCompleted(statePath, store);
    expect(result.kind).toBe('reconciled');
    expect(result.taskId).toBe('scrum-42');
  });

  test('top-level plan.task_id wins over a store link to a different task', () => {
    store.createTask({ id: 'scrum-43', title: 'Plan-side' });
    store.createTask({ id: 'scrum-44', title: 'Store-side' });
    const statePath = writeRun({ branch: 'feat', slug: 'precedence', taskId: 'scrum-43' });
    store.linkRun({ taskId: 'scrum-44', runPath: join('.prove', 'runs', 'feat', 'precedence') });

    const result = reconcileRunCompleted(statePath, store);
    expect(result.taskId).toBe('scrum-43');
  });

  test('still orphans when no layer knows the link', () => {
    const statePath = writeRun({ branch: 'feat', slug: 'truly-orphan', taskId: null });
    const result = reconcileRunCompleted(statePath, store);
    expect(result.kind).toBe('orphan');
  });
});

// ===========================================================================
// buildContextBundle
// ===========================================================================

describe('buildContextBundle', () => {
  test('aggregates decisions from decision_linked events (legacy {path, title} payload)', () => {
    store.createTask({ id: 'scrum-20', title: 'Demo' });
    store.appendEvent({
      taskId: 'scrum-20',
      kind: 'decision_linked',
      payload: { path: '.prove/decisions/x.md', title: 'Use SQLite' },
    });
    store.appendEvent({
      taskId: 'scrum-20',
      kind: 'decision_linked',
      payload: { path: '.prove/decisions/y.md', title: 'Use Bun' },
    });

    const bundle = buildContextBundle('scrum-20', store);
    expect(bundle.decisions).toHaveLength(2);
    expect(bundle.decisions.map((d) => d.title).sort()).toEqual(['Use Bun', 'Use SQLite']);
  });

  test('aggregates decisions from new-shape payload {decision_id, decision_path}', () => {
    store.createTask({ id: 'scrum-20b', title: 'Demo' });
    // Seed a scrum_decisions row so the title can be looked up by id.
    store.recordDecision({
      id: '2026-04-24-adr',
      title: 'Adopt ACB',
      content: '# Adopt ACB\n',
    });
    store.appendEvent({
      taskId: 'scrum-20b',
      kind: 'decision_linked',
      payload: {
        decision_id: '2026-04-24-adr',
        decision_path: '.prove/decisions/2026-04-24-adr.md',
      },
    });

    const bundle = buildContextBundle('scrum-20b', store);
    expect(bundle.decisions).toHaveLength(1);
    expect(bundle.decisions[0]?.path).toBe('.prove/decisions/2026-04-24-adr.md');
    expect(bundle.decisions[0]?.title).toBe('Adopt ACB');
  });

  test('mixed fixture: legacy and new-shape payloads coexist on one task', () => {
    store.createTask({ id: 'scrum-20c', title: 'Demo' });
    store.recordDecision({
      id: '2026-04-24-mixed',
      title: 'Mixed decision',
      content: '# Mixed decision\n',
    });
    // Legacy payload.
    store.appendEvent({
      taskId: 'scrum-20c',
      kind: 'decision_linked',
      payload: { path: '.prove/decisions/legacy.md', title: 'Legacy title' },
    });
    // New-shape payload.
    store.appendEvent({
      taskId: 'scrum-20c',
      kind: 'decision_linked',
      payload: {
        decision_id: '2026-04-24-mixed',
        decision_path: '.prove/decisions/2026-04-24-mixed.md',
      },
    });

    const bundle = buildContextBundle('scrum-20c', store);
    expect(bundle.decisions).toHaveLength(2);
    const paths = bundle.decisions.map((d) => d.path).sort();
    expect(paths).toEqual(['.prove/decisions/2026-04-24-mixed.md', '.prove/decisions/legacy.md']);
    const titles = bundle.decisions.map((d) => d.title).sort();
    expect(titles).toEqual(['Legacy title', 'Mixed decision']);
  });

  test('caps run summaries at 5 (last-5 most recent)', () => {
    store.createTask({ id: 'scrum-21', title: 'Demo' });
    for (let i = 0; i < 7; i++) {
      store.linkRun({
        taskId: 'scrum-21',
        runPath: `.prove/runs/feat/x/run-${i}`,
        branch: 'feat/x',
        slug: `run-${i}`,
        linkedAt: `2026-04-${String(10 + i).padStart(2, '0')}T00:00:00Z`,
      });
    }
    const bundle = buildContextBundle('scrum-21', store);
    expect(bundle.runs).toHaveLength(5);
  });

  test('summary_text concatenates recent event titles', () => {
    store.createTask({ id: 'scrum-22', title: 'Demo' });
    store.appendEvent({ taskId: 'scrum-22', kind: 'note', payload: { text: 'a' } });
    store.appendEvent({ taskId: 'scrum-22', kind: 'note', payload: { text: 'b' } });

    const bundle = buildContextBundle('scrum-22', store);
    expect(bundle.summary_text).toContain('note');
    expect(bundle.summary_text.split('\n').length).toBeGreaterThanOrEqual(2);
  });

  test('returns empty arrays for a task with no events or runs', () => {
    store.createTask({ id: 'scrum-23', title: 'Demo' });
    const bundle = buildContextBundle('scrum-23', store);
    expect(bundle.decisions).toEqual([]);
    expect(bundle.runs).toEqual([]);
    expect(bundle.files).toEqual([]);
  });
});

// ===========================================================================
// sweepUnreconciled
// ===========================================================================

describe('sweepUnreconciled', () => {
  test('scans runs and reconciles each one', () => {
    store.createTask({ id: 'scrum-30', title: 'A' });
    store.createTask({ id: 'scrum-31', title: 'B' });
    writeRun({ branch: 'feat-a', slug: 'one', taskId: 'scrum-30' });
    writeRun({ branch: 'feat-b', slug: 'two', taskId: 'scrum-31' });

    const result = sweepUnreconciled(store, 0);
    expect(result.scanned).toBe(2);
    expect(result.reconciled).toBe(2);
    expect(result.errors).toHaveLength(0);
  });

  test('is idempotent when called with a cursor newer than every mtime', () => {
    store.createTask({ id: 'scrum-32', title: 'A' });
    writeRun({ branch: 'feat-a', slug: 'one', taskId: 'scrum-32' });

    // First sweep processes it.
    const r1 = sweepUnreconciled(store, 0);
    expect(r1.reconciled).toBe(1);

    // Second sweep with cursor in the future sees 0 reconciles.
    const future = Date.now() + 60_000;
    const r2 = sweepUnreconciled(store, future);
    expect(r2.scanned).toBe(1);
    expect(r2.reconciled).toBe(0);
  });

  test('skips state.json files with mtime below the cursor', () => {
    store.createTask({ id: 'scrum-33', title: 'A' });
    const statePath = writeRun({ branch: 'feat-c', slug: 'old', taskId: 'scrum-33' });

    // Backdate the file by 1 hour.
    const oldMs = Date.now() - 3600_000;
    const asSec = oldMs / 1000;
    utimesSync(statePath, asSec, asSec);

    // Cursor is "now" — file is older, must be skipped.
    const result = sweepUnreconciled(store, Date.now());
    expect(result.scanned).toBe(1);
    expect(result.reconciled).toBe(0);
  });

  test('returns empty result when .prove/runs is absent', () => {
    const result = sweepUnreconciled(store, 0);
    expect(result).toEqual({ scanned: 0, reconciled: 0, errors: [] });
  });
});

// ===========================================================================
// reconcileMilestoneClosed — curation candidate bubble-up
// ===========================================================================

// Per-type required fields beyond the envelope (mirrors reasoning-log.ts).
const TYPE_EXTRA: Record<string, Record<string, unknown>> = {
  decision: { alternatives: ['a', 'b'], selected_rationale: 'a won' },
  hack: { file_refs: ['x.ts'], cleanup_condition: 'when stable' },
  risk: { severity: 'high', mitigation: 'monitor it' },
  assumption: { resolved: false, resolution_ref: null },
  bailout: { attempted: 'x', reason_abandoned: 'y' },
  synthesis: { outcome: 'shipped' },
  discovery: {},
  context: {},
  review_feedback: {},
  verification: {},
};

/** Write a valid reasoning-log entry of `type` under `runDir`. */
function writeLogEntry(runDir: string, id: string, type: string, agent = 'engineer'): void {
  appendEntry(runDir, {
    id,
    ts: `2026-06-01T10:00:00Z#${id}`,
    type,
    agent,
    run_path: runDir,
    body: `${type} body for ${id}`,
    ...TYPE_EXTRA[type],
  });
}

/** Link `taskId` to a run dir under `project` and return the absolute run dir. */
function linkRunDir(taskId: string, slug: string, branch = 'feat'): string {
  const runRel = join('.prove', 'runs', branch, slug);
  store.linkRun({ taskId, runPath: runRel, branch, slug });
  return join(project, runRel);
}

/** The decoded payload of the single curation_proposed event on `taskId`. */
function curationPayload(taskId: string): CurationProposedPayload | null {
  const event = store.listEventsForTask(taskId).find((e) => e.kind === 'curation_proposed');
  return event ? (event.payload as CurationProposedPayload) : null;
}

describe('reconcileMilestoneClosed', () => {
  test('emits one curation_proposed per task with findings, keeping only the four curation types', () => {
    store.createMilestone({ id: 'm1', title: 'M1' });
    store.createTask({ id: 'task-a', title: 'A', milestoneId: 'm1' });

    const runDir = linkRunDir('task-a', 'a');
    writeLogEntry(runDir, 'd1', 'decision');
    writeLogEntry(runDir, 'h1', 'hack');
    writeLogEntry(runDir, 'r1', 'risk');
    writeLogEntry(runDir, 'as1', 'assumption');
    // Non-curation entries must be excluded from candidates.
    writeLogEntry(runDir, 'disc1', 'discovery');
    writeLogEntry(runDir, 'syn1', 'synthesis');
    writeLogEntry(runDir, 'bail1', 'bailout');

    const result = reconcileMilestoneClosed('m1', store);

    expect(result.emitted).toEqual([{ taskId: 'task-a', candidateCount: 4 }]);
    const payload = curationPayload('task-a');
    expect(payload?.milestone_id).toBe('m1');
    expect(payload?.candidates.map((c) => c.type).sort()).toEqual([
      'assumption',
      'decision',
      'hack',
      'risk',
    ]);
    expect(
      payload?.candidates.every((c) => c.run_path === join('.prove', 'runs', 'feat', 'a')),
    ).toBe(true);
  });

  test('no-op for a task whose runs carry no curation-relevant findings', () => {
    store.createMilestone({ id: 'm2', title: 'M2' });
    store.createTask({ id: 'task-clean', title: 'Clean', milestoneId: 'm2' });
    const runDir = linkRunDir('task-clean', 'clean');
    writeLogEntry(runDir, 'disc', 'discovery');
    writeLogEntry(runDir, 'syn', 'synthesis');

    const result = reconcileMilestoneClosed('m2', store);

    expect(result.emitted).toHaveLength(0);
    expect(result.skippedNoFindings).toBe(1);
    expect(curationPayload('task-clean')).toBeNull();
  });

  test('no-op for a task with no linked runs at all', () => {
    store.createMilestone({ id: 'm3', title: 'M3' });
    store.createTask({ id: 'task-norun', title: 'NoRun', milestoneId: 'm3' });

    const result = reconcileMilestoneClosed('m3', store);
    expect(result.emitted).toHaveLength(0);
    expect(result.skippedNoFindings).toBe(1);
  });

  test('idempotent: a second close does not re-emit and reports already-emitted', () => {
    store.createMilestone({ id: 'm4', title: 'M4' });
    store.createTask({ id: 'task-i', title: 'I', milestoneId: 'm4' });
    const runDir = linkRunDir('task-i', 'i');
    writeLogEntry(runDir, 'h', 'hack');

    const first = reconcileMilestoneClosed('m4', store);
    expect(first.emitted).toHaveLength(1);

    const second = reconcileMilestoneClosed('m4', store);
    expect(second.emitted).toHaveLength(0);
    expect(second.skippedAlreadyEmitted).toBe(1);

    const count = store
      .listEventsForTask('task-i')
      .filter((e) => e.kind === 'curation_proposed').length;
    expect(count).toBe(1);
  });

  test('aggregates and dedupes candidates across multiple linked runs', () => {
    store.createMilestone({ id: 'm5', title: 'M5' });
    store.createTask({ id: 'task-multi', title: 'Multi', milestoneId: 'm5' });
    const run1 = linkRunDir('task-multi', 'one');
    const run2 = linkRunDir('task-multi', 'two');
    writeLogEntry(run1, 'h-one', 'hack');
    writeLogEntry(run2, 'r-two', 'risk');
    // Same entry id surfacing through both runs is collapsed to one candidate.
    writeLogEntry(run1, 'dup', 'decision');
    writeLogEntry(run2, 'dup', 'decision');

    const result = reconcileMilestoneClosed('m5', store);
    expect(result.emitted[0]?.candidateCount).toBe(3);
    const ids = curationPayload('task-multi')
      ?.candidates.map((c) => c.entry_id)
      .sort();
    expect(ids).toEqual(['dup', 'h-one', 'r-two']);
  });

  test('emits per-task: only milestone members with findings get an event', () => {
    store.createMilestone({ id: 'm6', title: 'M6' });
    store.createTask({ id: 'm6-a', title: 'A', milestoneId: 'm6' });
    store.createTask({ id: 'm6-b', title: 'B', milestoneId: 'm6' });
    // A task in a different milestone must be untouched.
    store.createMilestone({ id: 'other', title: 'Other' });
    store.createTask({ id: 'other-a', title: 'Other A', milestoneId: 'other' });

    writeLogEntry(linkRunDir('m6-a', 'a6'), 'h', 'hack');
    writeLogEntry(linkRunDir('other-a', 'oa'), 'h', 'hack');

    const result = reconcileMilestoneClosed('m6', store);
    expect(result.emitted.map((e) => e.taskId)).toEqual(['m6-a']);
    expect(result.skippedNoFindings).toBe(1); // m6-b
    expect(curationPayload('other-a')).toBeNull();
  });

  test('skips a malformed log dir without aborting the milestone curation', () => {
    store.createMilestone({ id: 'm7', title: 'M7' });
    store.createTask({ id: 'm7-bad', title: 'Bad', milestoneId: 'm7' });
    store.createTask({ id: 'm7-ok', title: 'Ok', milestoneId: 'm7' });

    const badDir = linkRunDir('m7-bad', 'bad');
    mkdirSync(join(badDir, 'log', 'engineer'), { recursive: true });
    writeFileSync(join(badDir, 'log', 'engineer', 'broken.json'), '{ not json');

    writeLogEntry(linkRunDir('m7-ok', 'ok'), 'h', 'hack');

    const result = reconcileMilestoneClosed('m7', store);
    // The corrupt run contributes nothing; the good task still curates.
    expect(result.emitted.map((e) => e.taskId)).toEqual(['m7-ok']);
    expect(result.skippedNoFindings).toBe(1); // m7-bad yielded zero candidates
  });
});

// ===========================================================================
// reconcileMilestoneClosed — milestone-close journal compaction (v22)
//
// On a milestone close, the milestone journal is rolled up into one Lore summary
// per team TERMINATING on that milestone. These tests create the terminating team
// WITHOUT a seated tech_lead, mirroring the real flow where closeMilestone vacates
// the roster before reconcile runs — so the engine-authored compaction Lore lands
// via recordLore's warn-allow (no-tech_lead) branch.
// ===========================================================================

describe('reconcileMilestoneClosed — journal compaction', () => {
  test('rolls the journal into one Lore per terminating team', () => {
    store.createMilestone({ id: 'm1', title: 'M1' });
    store.createTeam({
      slug: 'squad',
      teamType: 'enabling',
      lifetime: 'terminates_on_milestone',
      terminatesOnMilestone: 'm1',
    });
    store.createTask({ id: 'task-a', title: 'A', milestoneId: 'm1' });
    const runDir = linkRunDir('task-a', 'a');
    writeLogEntry(runDir, 'h1', 'hack');
    writeLogEntry(runDir, 'r1', 'risk');

    const result = reconcileMilestoneClosed('m1', store);

    expect(result.compactedTeams).toHaveLength(1);
    expect(result.compactedTeams[0]?.teamSlug).toBe('squad');
    expect(result.compactedTeams[0]?.candidateCount).toBe(2);

    const lores = store.listLores('squad');
    expect(lores).toHaveLength(1);
    // The summary opens with the idempotency marker and folds in each finding.
    expect(lores[0]?.body).toContain('[milestone-close-summary:m1]');
    expect(lores[0]?.body).toContain('[hack]');
    expect(lores[0]?.body).toContain('[risk]');
  });

  test('no terminating team is a no-op (per-task curation unchanged)', () => {
    store.createMilestone({ id: 'm2', title: 'M2' });
    // A persistent team and a team pinned to a DIFFERENT milestone — neither terminates here.
    store.createTeam({ slug: 'core', teamType: 'platform' });
    store.createTeam({
      slug: 'elsewhere',
      teamType: 'enabling',
      lifetime: 'terminates_on_milestone',
      terminatesOnMilestone: 'other',
    });
    store.createTask({ id: 'task-b', title: 'B', milestoneId: 'm2' });
    writeLogEntry(linkRunDir('task-b', 'b'), 'h1', 'hack');

    const result = reconcileMilestoneClosed('m2', store);

    // No compaction; the per-task curation still fired.
    expect(result.compactedTeams).toHaveLength(0);
    expect(result.emitted.map((e) => e.taskId)).toEqual(['task-b']);
    expect(store.listLores('core')).toHaveLength(0);
    expect(store.listLores('elsewhere')).toHaveLength(0);
  });

  test('idempotent: a re-close does not double-write the compaction Lore', () => {
    store.createMilestone({ id: 'm3', title: 'M3' });
    store.createTeam({
      slug: 'squad',
      teamType: 'enabling',
      lifetime: 'terminates_on_milestone',
      terminatesOnMilestone: 'm3',
    });
    store.createTask({ id: 'task-c', title: 'C', milestoneId: 'm3' });
    writeLogEntry(linkRunDir('task-c', 'c'), 'h1', 'hack');

    const first = reconcileMilestoneClosed('m3', store);
    expect(first.compactedTeams).toHaveLength(1);

    const second = reconcileMilestoneClosed('m3', store);
    expect(second.compactedTeams).toHaveLength(0);
    expect(second.skippedAlreadyCompacted).toBe(1);
    // Exactly one compaction Lore exists.
    expect(store.listLores('squad')).toHaveLength(1);
  });

  test('an empty journal still records a compaction Lore for the terminating team', () => {
    store.createMilestone({ id: 'm4', title: 'M4' });
    store.createTeam({
      slug: 'squad',
      teamType: 'enabling',
      lifetime: 'terminates_on_milestone',
      terminatesOnMilestone: 'm4',
    });
    // A task with only non-curation findings — the journal is empty.
    store.createTask({ id: 'task-d', title: 'D', milestoneId: 'm4' });
    writeLogEntry(linkRunDir('task-d', 'd'), 'disc', 'discovery');

    const result = reconcileMilestoneClosed('m4', store);

    expect(result.compactedTeams).toHaveLength(1);
    const lores = store.listLores('squad');
    expect(lores).toHaveLength(1);
    expect(lores[0]?.body).toContain('[milestone-close-summary:m4]');
    expect(lores[0]?.body).toContain('no curation-relevant findings');
  });

  test('two terminating teams each get the same milestone journal rolled up', () => {
    store.createMilestone({ id: 'm5', title: 'M5' });
    for (const slug of ['squad-a', 'squad-b']) {
      store.createTeam({
        slug,
        teamType: 'enabling',
        lifetime: 'terminates_on_milestone',
        terminatesOnMilestone: 'm5',
      });
    }
    store.createTask({ id: 'task-e', title: 'E', milestoneId: 'm5' });
    writeLogEntry(linkRunDir('task-e', 'e'), 'd1', 'decision');

    const result = reconcileMilestoneClosed('m5', store);

    expect(result.compactedTeams.map((c) => c.teamSlug).sort()).toEqual(['squad-a', 'squad-b']);
    expect(store.listLores('squad-a')[0]?.body).toContain('[decision]');
    expect(store.listLores('squad-b')[0]?.body).toContain('[decision]');
  });
});

// ---------------------------------------------------------------------------
// bubbleStaleEscalations — staleness auto-bubble (injected clock)
// ---------------------------------------------------------------------------

describe('bubbleStaleEscalations', () => {
  // A fixed evaluation instant. All escalations are seeded with a `created_at`
  // relative to this so the threshold is crossed deterministically — no wall
  // clock, no setTimeout.
  const NOW_MS = Date.parse('2026-06-02T00:00:00Z');
  const HOUR_MS = 60 * 60 * 1000;

  /** ISO timestamp `hours` before the fixed evaluation instant. */
  function hoursAgo(hours: number): string {
    return new Date(NOW_MS - hours * HOUR_MS).toISOString();
  }

  test('auto-bubbles an escalation older than the threshold one rung up and flips the original to auto_bubbled', () => {
    const stale = store.raiseEscalation({
      taskId: 't1',
      escalationType: 'blocked',
      summary: 'aged out, no receiver',
      createdAt: hoursAgo(STALENESS_THRESHOLD_HOURS + 1),
    });

    const result = bubbleStaleEscalations(store, NOW_MS);

    expect(result.threshold_hours).toBe(STALENESS_THRESHOLD_HOURS);
    expect(result.inspected).toBe(1);
    expect(result.bubbled).toHaveLength(1);
    expect(result.bubbled[0]).toMatchObject({
      from_id: stale.id,
      task_id: 't1',
      from_layer: 'implementer',
      to_layer: 'engineer',
    });

    // The original flips to auto_bubbled with the marker + forward pointer.
    const closed = store.getEscalation(stale.id);
    expect(closed?.state).toBe('auto_bubbled');
    expect(closed?.attributes?.auto_bubbled).toBe(true);
    expect(closed?.attributes?.linked_escalation).toBe(result.bubbled[0]?.to_id);

    // A fresh open row exists exactly one rung up, back-pointing at the original.
    const fresh = store.getEscalation(result.bubbled[0]?.to_id as number);
    expect(fresh?.state).toBe('open');
    expect(fresh?.layer).toBe('engineer');
    expect(fresh?.walked_up_from).toBe(stale.id);
  });

  test('leaves an under-threshold escalation untouched', () => {
    const fresh = store.raiseEscalation({
      taskId: 't1',
      escalationType: 'ambiguous',
      summary: 'raised recently',
      createdAt: hoursAgo(STALENESS_THRESHOLD_HOURS - 1),
    });

    const result = bubbleStaleEscalations(store, NOW_MS);

    expect(result.inspected).toBe(1);
    expect(result.bubbled).toHaveLength(0);
    expect(store.getEscalation(fresh.id)?.state).toBe('open');
    expect(store.getEscalation(fresh.id)?.attributes).toBeNull();
    // No successor row was appended.
    expect(store.listOpenEscalationRows()).toHaveLength(1);
  });

  test('an escalation exactly at the threshold is not yet stale (strict greater-than)', () => {
    const boundary = store.raiseEscalation({
      taskId: 't1',
      escalationType: 'conflict',
      summary: 'right at the line',
      createdAt: hoursAgo(STALENESS_THRESHOLD_HOURS),
    });

    const result = bubbleStaleEscalations(store, NOW_MS);

    expect(result.bubbled).toHaveLength(0);
    expect(store.getEscalation(boundary.id)?.state).toBe('open');
  });

  test('reports a stale escalation already at the top of the chain (human) without mutating it', () => {
    const atTop = store.raiseEscalation({
      taskId: 't1',
      escalationType: 'blocked',
      summary: 'human-rung, aged',
      layer: 'human',
      createdAt: hoursAgo(STALENESS_THRESHOLD_HOURS + 100),
    });

    const result = bubbleStaleEscalations(store, NOW_MS);

    expect(result.atTopOfChain).toBe(1);
    expect(result.bubbled).toHaveLength(0);
    // The human-rung row stays open and unmarked — nowhere higher to walk.
    expect(store.getEscalation(atTop.id)?.state).toBe('open');
    expect(store.getEscalation(atTop.id)?.attributes).toBeNull();
  });

  test('advances each stale escalation only one rung in a single pass (does not re-evaluate the fresh successor)', () => {
    const stale = store.raiseEscalation({
      taskId: 't1',
      escalationType: 'blocked',
      summary: 'aged out',
      createdAt: hoursAgo(STALENESS_THRESHOLD_HOURS + 48),
    });

    const result = bubbleStaleEscalations(store, NOW_MS);

    // Exactly one bubble: the successor row is created with created_at = NOW_MS,
    // so it is not stale within the same pass and is not re-bubbled.
    expect(result.bubbled).toHaveLength(1);
    const fresh = store.getEscalation(result.bubbled[0]?.to_id as number);
    expect(fresh?.layer).toBe('engineer');
    expect(fresh?.state).toBe('open');
    // The chain back-link is intact for a future pass to continue from.
    expect(store.getEscalationChain(fresh?.id as number).map((e) => e.layer)).toEqual([
      'implementer',
      'engineer',
    ]);
    void stale;
  });

  test('a custom threshold overrides the default staleness window', () => {
    const aged = store.raiseEscalation({
      taskId: 't1',
      escalationType: 'blocked',
      summary: 'three hours old',
      createdAt: hoursAgo(3),
    });

    // Default (24h) leaves it alone; a 2h threshold bubbles it.
    expect(bubbleStaleEscalations(store, NOW_MS).bubbled).toHaveLength(0);
    const result = bubbleStaleEscalations(store, NOW_MS, 2);
    expect(result.threshold_hours).toBe(2);
    expect(result.bubbled).toHaveLength(1);
    expect(store.getEscalation(aged.id)?.state).toBe('auto_bubbled');
  });

  test('surfaces a stale auto-bubble into next-ready ranking and alerts via the blocker_raised bridge', () => {
    // The owning task must exist for the event-surface bridge to fire.
    store.createTask({ id: 'ranked-task', title: 'Ranked', status: 'ready' });
    store.createTask({ id: 'plain-task', title: 'Plain', status: 'ready' });
    store.raiseEscalation({
      taskId: 'ranked-task',
      escalationType: 'blocked',
      summary: 'no receiver acted',
      createdAt: hoursAgo(STALENESS_THRESHOLD_HOURS + 5),
    });

    bubbleStaleEscalations(store, NOW_MS);

    // Alerts surface: listOpenEscalations reads the blocker_raised event the
    // bubble emitted.
    const alertTaskIds = store.listOpenEscalations().map((e) => e.task_id);
    expect(alertTaskIds).toContain('ranked-task');

    // Next-ready ranking: the escalated task carries a positive escalation_boost
    // and outranks the un-escalated peer.
    const ranked = store.nextReady({ limit: 10, nowMs: NOW_MS });
    const escalated = ranked.find((r) => r.task.id === 'ranked-task');
    const plain = ranked.find((r) => r.task.id === 'plain-task');
    expect(escalated?.rationale.escalation_boost).toBeGreaterThan(0);
    expect(escalated?.rationale.escalation_type).toBe('blocked');
    expect(escalated?.score ?? 0).toBeGreaterThan(plain?.score ?? 0);
  });
});

// ---------------------------------------------------------------------------
// Trigger bindings — declared status-transition -> bound next-action (1.4)
// ---------------------------------------------------------------------------

describe('triggerBindingsForStatus', () => {
  const triggers: TriggerBinding[] = [
    { on: 'accepted', workflow: 'decompose', description: 'fire next layer' },
    { on: 'accepted', workflow: 'notify' },
    { on: 'ready', workflow: 'orchestrate' },
  ];

  test('returns every binding whose `on` matches the status', () => {
    expect(triggerBindingsForStatus(triggers, 'accepted').map((t) => t.workflow)).toEqual([
      'decompose',
      'notify',
    ]);
  });

  test('returns [] when no binding fires for the status', () => {
    expect(triggerBindingsForStatus(triggers, 'done')).toEqual([]);
    expect(triggerBindingsForStatus([], 'accepted')).toEqual([]);
  });
});

describe('computeBoundActions', () => {
  const triggers: TriggerBinding[] = [
    { on: 'accepted', workflow: 'decompose', description: 'fire next layer' },
    { on: 'ready', workflow: 'orchestrate' },
  ];

  test('surfaces one bound action per task sitting in a triggering status', () => {
    store.createTask({ id: 'a1', title: 'Accepted one', status: 'accepted' });
    store.createTask({ id: 'r1', title: 'Ready one', status: 'ready' });
    store.createTask({ id: 'b1', title: 'Backlog one', status: 'backlog' });

    const actions = computeBoundActions(store, triggers, 10);
    expect(actions).toEqual([
      {
        task_id: 'a1',
        title: 'Accepted one',
        status: 'accepted',
        workflow: 'decompose',
        description: 'fire next layer',
      },
      {
        task_id: 'r1',
        title: 'Ready one',
        status: 'ready',
        workflow: 'orchestrate',
        description: '',
      },
    ]);
  });

  test('an empty trigger table yields no actions', () => {
    store.createTask({ id: 'a1', title: 'Accepted', status: 'accepted' });
    expect(computeBoundActions(store, [], 10)).toEqual([]);
  });

  test('honors the cap', () => {
    store.createTask({ id: 'a1', title: 'A1', status: 'accepted' });
    store.createTask({ id: 'a2', title: 'A2', status: 'accepted' });
    store.createTask({ id: 'a3', title: 'A3', status: 'accepted' });
    expect(computeBoundActions(store, triggers, 2)).toHaveLength(2);
  });
});

describe('parseTeamAgentName', () => {
  test('parses a simple team-role seat', () => {
    expect(parseTeamAgentName('team-auth-engineer')).toEqual({
      slug: 'auth',
      role: 'engineer',
    });
  });

  test('anchors on the role suffix so a hyphenated slug survives', () => {
    expect(parseTeamAgentName('team-data-platform-tech_lead')).toEqual({
      slug: 'data-platform',
      role: 'tech_lead',
    });
  });

  test('returns null for a non-team agent name', () => {
    expect(parseTeamAgentName('general-purpose')).toBeNull();
    expect(parseTeamAgentName('task-planner')).toBeNull();
  });

  test('returns null when the name has the prefix but no role suffix', () => {
    expect(parseTeamAgentName('team-auth')).toBeNull();
  });

  test('returns null when the slug is empty', () => {
    expect(parseTeamAgentName('team-engineer')).toBeNull();
  });
});

describe('detectContributionMiss', () => {
  const WINDOW_START = '2024-01-01T00:00:00.000Z';
  const WINDOW_END = '2024-01-01T01:00:00.000Z';

  test('in-window contribution from the seat is not a miss', () => {
    store.createTask({ id: 'team-task-1', title: 'Work' });
    store.appendEvent({
      taskId: 'team-task-1',
      kind: 'note',
      agent: 'team-auth-engineer',
      ts: '2024-01-01T00:30:00.000Z',
      payload: { text: 'did the work' },
    });

    const result = detectContributionMiss(
      store,
      'team-auth-engineer',
      'team-task-1',
      WINDOW_START,
      WINDOW_END,
    );
    expect(result).toEqual({
      isTeamRoleAgent: true,
      missed: false,
      role: 'engineer',
      slug: 'auth',
    });
  });

  test('seat with no in-window event is a miss', () => {
    store.createTask({ id: 'team-task-2', title: 'Work' });

    const result = detectContributionMiss(
      store,
      'team-auth-engineer',
      'team-task-2',
      WINDOW_START,
      WINDOW_END,
    );
    expect(result).toEqual({
      isTeamRoleAgent: true,
      missed: true,
      role: 'engineer',
      slug: 'auth',
    });
  });

  test('a non-team agent is a no-op (isTeamRoleAgent false, not missed)', () => {
    store.createTask({ id: 'team-task-3', title: 'Work' });

    const result = detectContributionMiss(
      store,
      'general-purpose',
      'team-task-3',
      WINDOW_START,
      WINDOW_END,
    );
    expect(result).toEqual({ isTeamRoleAgent: false, missed: false });
  });

  test('window is half-open: the end instant is out of window, the start instant is in', () => {
    store.createTask({ id: 'team-task-4', title: 'Work' });
    // Stamped exactly at the end instant — excluded by the half-open `[start, end)`.
    store.appendEvent({
      taskId: 'team-task-4',
      kind: 'note',
      agent: 'team-auth-engineer',
      ts: WINDOW_END,
      payload: { text: 'too late' },
    });

    const atEnd = detectContributionMiss(
      store,
      'team-auth-engineer',
      'team-task-4',
      WINDOW_START,
      WINDOW_END,
    );
    expect(atEnd.missed).toBe(true);

    // Stamped exactly at the start instant — included.
    store.appendEvent({
      taskId: 'team-task-4',
      kind: 'note',
      agent: 'team-auth-engineer',
      ts: WINDOW_START,
      payload: { text: 'right on time' },
    });
    const atStart = detectContributionMiss(
      store,
      'team-auth-engineer',
      'team-task-4',
      WINDOW_START,
      WINDOW_END,
    );
    expect(atStart.missed).toBe(false);
  });

  test("an event stamped by a different seat does not count as this seat's contribution", () => {
    store.createTask({ id: 'team-task-5', title: 'Work' });
    store.appendEvent({
      taskId: 'team-task-5',
      kind: 'note',
      agent: 'team-auth-tech_lead',
      ts: '2024-01-01T00:30:00.000Z',
      payload: { text: 'lead stamped it' },
    });

    const result = detectContributionMiss(
      store,
      'team-auth-engineer',
      'team-task-5',
      WINDOW_START,
      WINDOW_END,
    );
    expect(result.missed).toBe(true);
  });

  test('a vacant-slot dispatch is still evaluated — never short-circuited to no-miss', () => {
    // No team is created and no holder is ever seated for the role; the detector
    // reads presence off the event log alone, so a seat name with zero in-window
    // contributions is still a miss rather than an auto-pass.
    store.createTask({ id: 'team-task-6', title: 'Work' });

    const result = detectContributionMiss(
      store,
      'team-vacant-implementer',
      'team-task-6',
      WINDOW_START,
      WINDOW_END,
    );
    expect(result).toEqual({
      isTeamRoleAgent: true,
      missed: true,
      role: 'implementer',
      slug: 'vacant',
    });
  });
});
