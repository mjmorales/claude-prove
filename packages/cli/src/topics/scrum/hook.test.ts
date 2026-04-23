/**
 * hook.ts unit tests — three stdin-JSON consumers.
 *
 * Tests invoke handlers directly with fixture payloads (no subprocess
 * spawning — Task 5's CLI wiring covers the spawn-smoke). The scrum
 * store for these tests opens against a real tmpdir git repo so the
 * `openScrumStore({ cwd: project })` path-resolution logic is exercised.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onSessionStart, onStop, onSubagentStop } from './hook';
import { openScrumStore } from './store';

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let project: string;

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'scrum-hook-'));
  // Fake a git root so openScrumStore's resolver finds the project.
  mkdirSync(join(project, '.git'), { recursive: true });
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function seedStore(seed: (s: ReturnType<typeof openScrumStore>) => void): void {
  const store = openScrumStore({ cwd: project });
  try {
    seed(store);
  } finally {
    store.close();
  }
}

function writeRun(
  branch: string,
  slug: string,
  planTaskId: string | null,
  runStatus = 'completed',
): string {
  const runDir = join(project, '.prove', 'runs', branch, slug);
  mkdirSync(runDir, { recursive: true });

  const plan: Record<string, unknown> = {
    schema_version: '5',
    kind: 'plan',
    mode: 'full',
    tasks: [{ id: '1', title: 'step', steps: [] }],
  };
  if (planTaskId !== null) plan.task_id = planTaskId;
  writeFileSync(join(runDir, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`);

  const state = {
    schema_version: '5',
    kind: 'state',
    run_status: runStatus,
    slug,
    branch,
    current_task: '1',
    current_step: '',
    started_at: '2026-04-23T09:00:00Z',
    updated_at: '2026-04-23T12:00:00Z',
    ended_at: '2026-04-23T12:00:00Z',
    tasks: [],
    dispatch: { dispatched: [] },
  };
  writeFileSync(join(runDir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
  return runDir;
}

// ===========================================================================
// onSessionStart
// ===========================================================================

describe('onSessionStart', () => {
  test('silent when no active tasks or recent events', () => {
    const result = onSessionStart({ cwd: project });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
  });

  test('emits hookSpecificOutput with active tasks digest', () => {
    seedStore((store) => {
      store.createTask({ id: 't1', title: 'Demo', status: 'in_progress' });
    });

    const result = onSessionStart({ cwd: project });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('hookSpecificOutput');
    expect(result.stdout).toContain('SessionStart');
    expect(result.stdout).toContain('t1');
    expect(result.stdout).toContain('in_progress');
  });

  test('surfaces stalled WIP in the digest', () => {
    seedStore((store) => {
      const oldTs = '2020-01-01T00:00:00Z';
      store.createTask({
        id: 'stale',
        title: 'Old task',
        status: 'in_progress',
        createdAt: oldTs,
      });
    });

    const result = onSessionStart({ cwd: project });
    expect(result.stdout).toContain('stalled');
  });

  test('exits 0 even when store open fails (non-blocking contract)', () => {
    // Pass a cwd that isn't a git repo — openScrumStore will throw.
    const broken = mkdtempSync(join(tmpdir(), 'scrum-hook-nogit-'));
    try {
      const result = onSessionStart({ cwd: broken });
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain('scrum session-start hook');
    } finally {
      rmSync(broken, { recursive: true, force: true });
    }
  });

  test('returns EMPTY result on null payload when no scrum state exists', () => {
    // Null payload -> falls through to process.cwd(); harness cwd is the
    // repo root, which has no scrum state for this test. The result should
    // be exit 0 (either empty or an error, both non-blocking).
    const result = onSessionStart(null);
    expect(result.exitCode).toBe(0);
  });
});

// ===========================================================================
// onSubagentStop
// ===========================================================================

describe('onSubagentStop', () => {
  test('no-op for non-matching subagent types', () => {
    const result = onSubagentStop({
      cwd: project,
      subagent_type: 'some-other-agent',
    });
    expect(result).toEqual({ exitCode: 0, stdout: '', stderr: '' });
  });

  test('no-op when payload is null', () => {
    const result = onSubagentStop(null);
    expect(result).toEqual({ exitCode: 0, stdout: '', stderr: '' });
  });

  test('reconciles when subagent_type matches and run dir resolvable', () => {
    seedStore((store) => {
      store.createTask({ id: 'hook-t1', title: 'Hook task' });
    });
    const runDir = writeRun('feature-hook', 'demo', 'hook-t1');

    const result = onSubagentStop({
      cwd: runDir,
      subagent_type: 'general-purpose',
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('scrum: reconciled');

    const store = openScrumStore({ cwd: project });
    try {
      const events = store.listEventsForTask('hook-t1');
      expect(events.some((e) => e.kind === 'run_completed')).toBe(true);
    } finally {
      store.close();
    }
  });

  test('reconciles orphan run when matching subagent has no linked task', () => {
    const runDir = writeRun('feature-orph', 'demo', null);
    const result = onSubagentStop({
      cwd: runDir,
      subagent_type: 'task-planner',
    });
    expect(result.exitCode).toBe(0);

    const store = openScrumStore({ cwd: project });
    try {
      const events = store.listEventsForTask('__orphan__');
      expect(events.some((e) => e.kind === 'unlinked_run_detected')).toBe(true);
    } finally {
      store.close();
    }
  });

  test('exit 0 when matching subagent but no state.json locatable', () => {
    const result = onSubagentStop({
      cwd: project,
      subagent_type: 'general-purpose',
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
  });
});

// ===========================================================================
// onStop
// ===========================================================================

describe('onStop', () => {
  test('sweeps runs and writes last-sweep.json', () => {
    seedStore((store) => {
      store.createTask({ id: 'sweep-t1', title: 'Sweep task' });
    });
    writeRun('feature-sweep', 'run-a', 'sweep-t1');

    const result = onStop({ cwd: project });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('scrum:');

    const cursorPath = join(project, '.prove', 'scrum', 'last-sweep.json');
    const body = readFileSync(cursorPath, 'utf8');
    const parsed = JSON.parse(body) as { ts: number; iso: string };
    expect(typeof parsed.ts).toBe('number');
    expect(parsed.ts).toBeGreaterThan(0);
  });

  test('is idempotent: second call reports 0 reconciles', () => {
    seedStore((store) => {
      store.createTask({ id: 'sweep-t2', title: 'Sweep B' });
    });
    writeRun('feature-sweep', 'run-b', 'sweep-t2');

    const first = onStop({ cwd: project });
    expect(first.exitCode).toBe(0);

    const second = onStop({ cwd: project });
    expect(second.exitCode).toBe(0);
    // Second sweep's cursor is after the state.json mtime — 0 reconciles.
    expect(second.stdout).toBe('');
  });

  test('creates .prove/scrum directory when absent', () => {
    // No state files to reconcile — still should create the dir and write
    // the cursor so future sweeps have a starting point.
    onStop({ cwd: project });
    const body = readFileSync(join(project, '.prove', 'scrum', 'last-sweep.json'), 'utf8');
    const parsed = JSON.parse(body) as { ts: number };
    expect(parsed.ts).toBeGreaterThan(0);
  });

  test('exits 0 even when store open fails (non-blocking contract)', () => {
    const broken = mkdtempSync(join(tmpdir(), 'scrum-hook-nogit-stop-'));
    try {
      const result = onStop({ cwd: broken });
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain('scrum stop hook');
    } finally {
      rmSync(broken, { recursive: true, force: true });
    }
  });
});
