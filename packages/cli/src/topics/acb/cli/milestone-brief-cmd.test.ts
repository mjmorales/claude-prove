/**
 * milestone-brief-cmd.ts CLI-contract tests.
 *
 * Verifies `acb milestone-brief render|validate` follow the
 * stdout=document/JSON, stderr=summary, exit-code contract, gathering the
 * milestone's constituent stories from a real scrum store. Stories are seeded
 * by linking a run dir (whose reasoning log is written via the canonical
 * `appendEntry` ingest path) to a milestone task.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openScrumStore } from '../../scrum/store';
import { appendEntry } from '../reasoning-log-store';
import { runMilestoneBrief } from './milestone-brief-cmd';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'acb-milestone-brief-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

interface Captured {
  stdout: string;
  stderr: string;
  exit: number;
}

function withCapture(fn: () => number): Captured {
  let stdout = '';
  let stderr = '';
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string | Uint8Array) => {
    stdout += typeof c === 'string' ? c : Buffer.from(c).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => {
    stderr += typeof c === 'string' ? c : Buffer.from(c).toString('utf8');
    return true;
  }) as typeof process.stderr.write;
  try {
    const exit = fn();
    return { stdout, stderr, exit };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

/**
 * Seed a milestone `m1` with one shipped story (a hack + synthesis) and one
 * cancelled story (a risk it raised before being cut). Returns the abs db path.
 */
function seedMilestone(): void {
  const shippedRunRel = join('.prove', 'runs', 'main', 'story-1');
  const cancelledRunRel = join('.prove', 'runs', 'main', 'story-2');
  const shippedRunDir = join(root, shippedRunRel);
  const cancelledRunDir = join(root, cancelledRunRel);

  appendEntry(shippedRunDir, {
    id: 'h1',
    ts: '2026-06-01T01:00:00Z',
    type: 'hack',
    agent: 'engineer',
    run_path: shippedRunDir,
    body: 'temporary shim',
    file_refs: ['x.ts'],
    cleanup_condition: 'when upstream lands',
  });
  appendEntry(shippedRunDir, {
    id: 's1',
    ts: '2026-06-01T02:00:00Z',
    type: 'synthesis',
    agent: 'engineer',
    run_path: shippedRunDir,
    body: 'shipped',
    outcome: 'login works end to end',
  });
  appendEntry(cancelledRunDir, {
    id: 'r-cut',
    ts: '2026-06-01T03:00:00Z',
    type: 'risk',
    agent: 'engineer',
    run_path: cancelledRunDir,
    body: 'rate-limit exposure',
    severity: 'high',
    mitigation: 'add a limiter',
  });

  const store = openScrumStore({ override: join(root, '.prove', 'prove.db') });
  store.createMilestone({
    id: 'm1',
    title: 'Milestone One',
    description: null,
    targetState: null,
    initiative: null,
  });
  store.createTask({ id: 't1', title: 'Auth login', milestoneId: 'm1' });
  store.createTask({ id: 't2', title: 'Magic links', milestoneId: 'm1' });
  store.linkRun({ taskId: 't1', runPath: shippedRunRel });
  store.linkRun({ taskId: 't2', runPath: cancelledRunRel });
  // t1 ships; t2 is cancelled with a recorded reason.
  store.updateTaskStatus('t1', 'ready');
  store.updateTaskStatus('t1', 'in_progress');
  store.updateTaskStatus('t1', 'done');
  store.cancelTask('t2', { reason: 'cancelled', detail: 'descoped to next milestone' });
  store.close();
}

describe('acb milestone-brief render', () => {
  test('rolls up the four sections from the milestone stories, exit 0', () => {
    seedMilestone();
    const res = withCapture(() =>
      runMilestoneBrief('render', { milestone: 'm1', workspaceRoot: root }),
    );
    expect(res.exit).toBe(0);
    expect(res.stdout).toContain('## 1. Needs your attention');
    expect(res.stdout).toContain('(h1)'); // shipped story's hack
    expect(res.stdout).toContain('(r-cut)'); // cancelled story's risk preserved
    expect(res.stdout).toContain('login works end to end'); // outcome
    expect(res.stdout).toContain('descoped to next milestone'); // did-not-ship reason
    expect(res.stderr).toContain('Milestone brief rendered');
  });

  test('missing --milestone → exit 1', () => {
    const res = withCapture(() => runMilestoneBrief('render', { workspaceRoot: root }));
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('--milestone is required');
  });

  test('unknown milestone → exit 1', () => {
    seedMilestone();
    const res = withCapture(() =>
      runMilestoneBrief('render', { milestone: 'nope', workspaceRoot: root }),
    );
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain("milestone 'nope' not found");
  });
});

describe('acb milestone-brief validate', () => {
  test('PASS: a preserving brief → JSON ok:true, exit 0', () => {
    seedMilestone();
    const rendered = withCapture(() =>
      runMilestoneBrief('render', { milestone: 'm1', workspaceRoot: root }),
    ).stdout;
    const briefFile = join(root, 'mbrief.md');
    writeFileSync(briefFile, rendered, 'utf8');

    const res = withCapture(() =>
      runMilestoneBrief('validate', { milestone: 'm1', file: briefFile, workspaceRoot: root }),
    );
    expect(res.exit).toBe(0);
    const payload = JSON.parse(res.stdout.trim()) as { ok: boolean; required: number };
    expect(payload.ok).toBe(true);
    expect(payload.required).toBe(2); // h1 + r-cut
    expect(res.stderr).toContain('preserves all 2');
  });

  test('FAIL: a brief dropping the cancelled story risk → ok:false, exit 1', () => {
    seedMilestone();
    const badFile = join(root, 'bad.md');
    // Mentions the shipped hack but omits the cancelled story's risk id.
    writeFileSync(badFile, 'we kept h1 but said nothing about the cut risk', 'utf8');

    const res = withCapture(() =>
      runMilestoneBrief('validate', { milestone: 'm1', file: badFile, workspaceRoot: root }),
    );
    expect(res.exit).toBe(1);
    const payload = JSON.parse(res.stdout.trim()) as { ok: boolean; missing: string[] };
    expect(payload.ok).toBe(false);
    expect(payload.missing).toContain('risk:r-cut');
    expect(res.stderr).toContain('DROPPED');
  });

  test('unknown sub-action → exit 1', () => {
    const res = withCapture(() =>
      runMilestoneBrief('bogus', { milestone: 'm1', workspaceRoot: root }),
    );
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('unknown milestone-brief sub-action');
  });
});
