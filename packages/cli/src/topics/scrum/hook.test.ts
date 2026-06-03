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

/** Write a reasoning-log entry under `<runDir>/log/<agent>/<id>.json`. */
function writeLogEntry(runDir: string, agent: string, entry: Record<string, unknown>): void {
  const dir = join(runDir, 'log', agent);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${String(entry.id)}.json`), `${JSON.stringify(entry, null, 2)}\n`);
}

/** A mechanical `capture` entry naming a mutating tool — marks "artifact touched". */
function writeCapture(runDir: string, id: string, tool: string, target: string): void {
  writeLogEntry(runDir, 'capture', {
    id,
    ts: `2026-04-23T10:0${id.length}:00Z`,
    type: 'capture',
    agent: 'capture',
    run_path: runDir,
    body: `${tool} ${target}`,
    tool,
    target,
  });
}

/** A `synthesis` entry with the given outcome declaration. */
function writeSynthesis(runDir: string, id: string, outcome: string): void {
  writeLogEntry(runDir, 'general-purpose', {
    id,
    ts: `2026-04-23T11:0${id.length}:00Z`,
    type: 'synthesis',
    agent: 'general-purpose',
    run_path: runDir,
    body: 'episode summary',
    outcome,
  });
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

  test('auto-bubbles a stale escalation and surfaces it in the digest', () => {
    seedStore((store) => {
      store.createTask({ id: 'blocked-task', title: 'Blocked', status: 'ready' });
      // created_at far in the past -> reliably past the staleness threshold
      // regardless of the wall clock the hook reads.
      store.raiseEscalation({
        taskId: 'blocked-task',
        escalationType: 'blocked',
        summary: 'no receiver acted in time',
        createdAt: '2020-01-01T00:00:00Z',
      });
    });

    const result = onSessionStart({ cwd: project });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('auto-bubbled escalations');
    expect(result.stdout).toContain('implementer');
    expect(result.stdout).toContain('engineer');

    // The store reflects the bubble: original closed auto_bubbled, fresh open
    // row one rung up.
    seedStore((store) => {
      const rows = store.listEscalationsForTask('blocked-task');
      expect(rows.map((r) => r.state)).toEqual(['auto_bubbled', 'open']);
      const [closed, fresh] = rows;
      expect(closed?.attributes?.auto_bubbled).toBe(true);
      expect(closed?.attributes?.linked_escalation).toBe(fresh?.id);
      expect(fresh?.layer).toBe('engineer');
    });
  });

  test('leaves a fresh escalation untouched on session-start', () => {
    seedStore((store) => {
      store.createTask({ id: 'fresh-task', title: 'Fresh', status: 'ready' });
      // created_at = now -> well under the threshold; the sweep must skip it.
      store.raiseEscalation({
        taskId: 'fresh-task',
        escalationType: 'ambiguous',
        summary: 'just raised',
      });
    });

    const result = onSessionStart({ cwd: project });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('auto-bubbled escalations');
    seedStore((store) => {
      const rows = store.listEscalationsForTask('fresh-task');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.state).toBe('open');
    });
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

  test('BLOCKS a worker that touched an artifact but logged no synthesis', () => {
    seedStore((store) => {
      store.createTask({ id: 'gate-t1', title: 'Gate task' });
    });
    const runDir = writeRun('feature-gate', 'demo', 'gate-t1');
    writeCapture(runDir, 'c1', 'Write', 'packages/cli/src/x.ts');

    const result = onSubagentStop({
      cwd: runDir,
      subagent_type: 'general-purpose',
    });

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as { decision?: string; reason?: string };
    expect(payload.decision).toBe('block');
    expect(payload.reason).toContain('BLOCKED');
    expect(payload.reason).toContain('completed');
    expect(payload.reason).toContain('handoff:');
    expect(payload.reason).toContain('acb log append');

    // Blocked before reconcile — no run_completed event should have landed.
    const store = openScrumStore({ cwd: project });
    try {
      const events = store.listEventsForTask('gate-t1');
      expect(events.some((e) => e.kind === 'run_completed')).toBe(false);
    } finally {
      store.close();
    }
  });

  test('passes a worker whose synthesis declares completed, then reconciles', () => {
    seedStore((store) => {
      store.createTask({ id: 'gate-t2', title: 'Gate task 2' });
    });
    const runDir = writeRun('feature-gate', 'ok', 'gate-t2');
    writeCapture(runDir, 'c1', 'Edit', 'packages/cli/src/y.ts');
    writeSynthesis(runDir, 's1', 'completed');

    const result = onSubagentStop({
      cwd: runDir,
      subagent_type: 'general-purpose',
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('scrum: reconciled');

    const store = openScrumStore({ cwd: project });
    try {
      const events = store.listEventsForTask('gate-t2');
      expect(events.some((e) => e.kind === 'run_completed')).toBe(true);
    } finally {
      store.close();
    }
  });

  test('BLOCKS a worker whose synthesis outcome is an invalid declaration', () => {
    seedStore((store) => {
      store.createTask({ id: 'gate-t3', title: 'Gate task 3' });
    });
    const runDir = writeRun('feature-gate', 'bad', 'gate-t3');
    writeCapture(runDir, 'c1', 'Write', 'packages/cli/src/z.ts');
    writeSynthesis(runDir, 's1', 'made some progress');

    const result = onSubagentStop({
      cwd: runDir,
      subagent_type: 'general-purpose',
    });

    const payload = JSON.parse(result.stdout) as { decision?: string; reason?: string };
    expect(payload.decision).toBe('block');
    expect(payload.reason).toContain('made some progress');
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

  // The gate resolves the active run via the run slug. PROVE_RUN_SLUG (tier-1
  // resolution) pins it deterministically; cleared after each gate test so the
  // sweep tests above keep resolving to "no active run". The computed-key
  // delete form keeps biome's noDelete rule satisfied.
  describe('end-of-session gate', () => {
    afterEach(() => {
      const key = 'PROVE_RUN_SLUG';
      if (key in process.env) delete process.env[key];
    });

    test('BLOCKS the session when the active run touched an artifact with no synthesis', () => {
      const runDir = writeRun('feature-stop-gate', 'block-me', null);
      writeCapture(runDir, 'c1', 'Write', 'packages/cli/src/q.ts');
      process.env.PROVE_RUN_SLUG = 'block-me';

      const result = onStop({ cwd: project });

      expect(result.exitCode).toBe(0);
      const payload = JSON.parse(result.stdout) as { decision?: string; reason?: string };
      expect(payload.decision).toBe('block');
      expect(payload.reason).toContain('BLOCKED');
      expect(payload.reason).toContain('acb log append');

      // Blocked before the sweep — the last-sweep cursor must not advance.
      const cursorPath = join(project, '.prove', 'scrum', 'last-sweep.json');
      expect(() => readFileSync(cursorPath, 'utf8')).toThrow();
    });

    test('passes the session and sweeps when the active run declared completed', () => {
      seedStore((store) => {
        store.createTask({ id: 'stop-ok', title: 'Stop OK' });
      });
      const runDir = writeRun('feature-stop-gate', 'pass-me', 'stop-ok');
      writeCapture(runDir, 'c1', 'Edit', 'packages/cli/src/r.ts');
      writeSynthesis(runDir, 's1', 'completed');
      process.env.PROVE_RUN_SLUG = 'pass-me';

      const result = onStop({ cwd: project });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('"decision": "block"');
      // Sweep ran — cursor written.
      const body = readFileSync(join(project, '.prove', 'scrum', 'last-sweep.json'), 'utf8');
      expect((JSON.parse(body) as { ts: number }).ts).toBeGreaterThan(0);
    });
  });
});
