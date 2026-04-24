/**
 * Unit tests for scrum CLI subcommand handlers.
 *
 * Each `runXCmd` function is invoked directly with a flags object. stdout
 * and stderr are captured by patching `process.stdout.write` and
 * `process.stderr.write` for the duration of the call. Every handler
 * opens its own `ScrumStore` against the unified prove.db — the test
 * harness chdir's into a fresh `.git`-shaped tmpdir so that
 * `mainWorktreeRoot()` resolves cleanly and the store lands under
 * `<tmp>/.prove/prove.db`.
 *
 * Hook dispatch is smoke-tested at the dispatch-function level; the
 * full hook payload shape belongs to Task 4.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runAlertsCmd } from './alerts-cmd';
import { runHookCmd } from './hook-cmd';
import { runInitCmd } from './init-cmd';
import { runLinkRunCmd } from './link-run-cmd';
import { runMilestoneCmd } from './milestone-cmd';
import { runNextReadyCmd } from './next-ready-cmd';
import { runStatusCmd } from './status-cmd';
import { runTagCmd } from './tag-cmd';
import { runTaskCmd } from './task-cmd';

// ---------------------------------------------------------------------------
// Harness: capture stdout/stderr + chdir to a fresh git workspace per test
// ---------------------------------------------------------------------------

interface Captured {
  stdout: string;
  stderr: string;
  exit: number;
}

function withCapture(fn: () => number): Captured {
  let stdout = '';
  let stderr = '';
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stderr.write;
  try {
    const exit = fn();
    return { stdout, stderr, exit };
  } finally {
    process.stdout.write = origStdout;
    process.stderr.write = origStderr;
  }
}

let workspace: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  workspace = mkdtempSync(join(tmpdir(), 'scrum-cli-unit-'));
  // A `.git` dir is enough for mainWorktreeRoot()'s heuristic — tests
  // don't need an actual git repo since the handlers only read the
  // workspace root for store placement.
  mkdirSync(join(workspace, '.git'), { recursive: true });
  process.chdir(workspace);
});

afterEach(() => {
  process.chdir(originalCwd);
  try {
    rmSync(workspace, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

// ---------------------------------------------------------------------------
// init-cmd
// ---------------------------------------------------------------------------

describe('runInitCmd', () => {
  test('empty planning/: exit 0 with informational stderr + seeded=false JSON', () => {
    const res = withCapture(() => runInitCmd({ workspaceRoot: workspace }));
    expect(res.exit).toBe(0);
    expect(res.stderr).toContain('nothing to import (planning/ empty or absent)');
    const payload = JSON.parse(res.stdout.trim()) as { seeded: boolean; reason: string };
    expect(payload.seeded).toBe(false);
    expect(payload.reason).toBe('empty');
  });

  test('idempotent: second invocation with tasks already present no-ops', () => {
    mkdirSync(join(workspace, 'planning'), { recursive: true });
    writeFileSync(join(workspace, 'planning', 'BACKLOG.md'), '- A\n- B\n', 'utf8');

    const first = withCapture(() => runInitCmd({ workspaceRoot: workspace }));
    expect(first.exit).toBe(0);
    expect(JSON.parse(first.stdout.trim()).seeded).toBe(true);

    const second = withCapture(() => runInitCmd({ workspaceRoot: workspace }));
    expect(second.exit).toBe(0);
    const payload = JSON.parse(second.stdout.trim()) as { seeded: boolean; reason: string };
    expect(payload.seeded).toBe(false);
    expect(payload.reason).toBe('already-seeded');
  });
});

// ---------------------------------------------------------------------------
// status-cmd
// ---------------------------------------------------------------------------

describe('runStatusCmd', () => {
  test('default JSON has the three required keys', () => {
    const res = withCapture(() => runStatusCmd({}));
    expect(res.exit).toBe(0);
    const payload = JSON.parse(res.stdout.trim());
    expect(payload).toHaveProperty('active_tasks');
    expect(payload).toHaveProperty('milestones');
    expect(payload).toHaveProperty('recent_events');
  });

  test('--human emits a compact text table on stdout', () => {
    const res = withCapture(() => runStatusCmd({ human: true }));
    expect(res.exit).toBe(0);
    expect(res.stdout).toContain('Active tasks');
    expect(res.stdout).toContain('Active milestones');
  });

  test('JSON payload carries total_milestones alongside active milestones', () => {
    withCapture(() =>
      runMilestoneCmd('create', [undefined, undefined], { title: 'Alpha', id: 'alpha' }),
    );
    withCapture(() =>
      runMilestoneCmd('create', [undefined, undefined], { title: 'Beta', id: 'beta' }),
    );
    withCapture(() => runMilestoneCmd('close', ['alpha', undefined], {}));

    const res = withCapture(() => runStatusCmd({}));
    expect(res.exit).toBe(0);
    const payload = JSON.parse(res.stdout.trim()) as {
      milestones: unknown[];
      total_milestones: number;
    };
    expect(payload.total_milestones).toBe(2);
    expect(payload.milestones).toHaveLength(1);
    expect(res.stderr).toContain('1/2 active milestones');
  });
});

// ---------------------------------------------------------------------------
// next-ready-cmd
// ---------------------------------------------------------------------------

describe('runNextReadyCmd', () => {
  test('default JSON is an array shape', () => {
    withCapture(() => runTaskCmd('create', [undefined, undefined], { title: 'Foo', id: 'foo' }));
    const res = withCapture(() => runNextReadyCmd({}));
    expect(res.exit).toBe(0);
    const rows = JSON.parse(res.stdout.trim());
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  test('--limit is respected', () => {
    for (let i = 0; i < 3; i += 1) {
      withCapture(() =>
        runTaskCmd('create', [undefined, undefined], { title: `T${i}`, id: `t${i}` }),
      );
    }
    const res = withCapture(() => runNextReadyCmd({ limit: 2 }));
    expect(res.exit).toBe(0);
    const rows = JSON.parse(res.stdout.trim()) as unknown[];
    expect(rows.length).toBeLessThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// task-cmd
// ---------------------------------------------------------------------------

describe('runTaskCmd', () => {
  test('create without --title: exit 1', () => {
    const res = withCapture(() => runTaskCmd('create', [undefined, undefined], {}));
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('--title is required');
  });

  test('create + show round-trip', () => {
    const c = withCapture(() =>
      runTaskCmd('create', [undefined, undefined], { title: 'Hi', id: 'hi' }),
    );
    expect(c.exit).toBe(0);
    const task = JSON.parse(c.stdout.trim());
    expect(task.id).toBe('hi');

    const s = withCapture(() => runTaskCmd('show', ['hi', undefined], {}));
    expect(s.exit).toBe(0);
    const shown = JSON.parse(s.stdout.trim());
    expect(shown.task.id).toBe('hi');
  });

  test('unknown action: exit 1', () => {
    const res = withCapture(() => runTaskCmd('bogus', [undefined, undefined], {}));
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain("unknown task action 'bogus'");
  });

  test('tag + list --tag filter', () => {
    withCapture(() => runTaskCmd('create', [undefined, undefined], { title: 'U', id: 'u' }));
    const t = withCapture(() => runTaskCmd('tag', ['u', 'p0'], {}));
    expect(t.exit).toBe(0);
    const l = withCapture(() => runTaskCmd('list', [undefined, undefined], { tag: 'p0' }));
    expect(l.exit).toBe(0);
    const rows = JSON.parse(l.stdout.trim()) as Array<{ id: string }>;
    expect(rows.some((r) => r.id === 'u')).toBe(true);
  });

  test('link-decision: appends event', () => {
    withCapture(() => runTaskCmd('create', [undefined, undefined], { title: 'Z', id: 'z' }));
    const res = withCapture(() => runTaskCmd('link-decision', ['z', '.prove/decisions/x.md'], {}));
    expect(res.exit).toBe(0);
    const payload = JSON.parse(res.stdout.trim());
    expect(payload.linked).toBe(true);
    expect(payload.decision_path).toBe('.prove/decisions/x.md');
  });

  test('status: drives a valid transition and returns the updated task', () => {
    withCapture(() => runTaskCmd('create', [undefined, undefined], { title: 'S', id: 's' }));
    const res = withCapture(() => runTaskCmd('status', ['s', 'ready'], {}));
    expect(res.exit).toBe(0);
    const task = JSON.parse(res.stdout.trim()) as { id: string; status: string };
    expect(task.id).toBe('s');
    expect(task.status).toBe('ready');
    expect(res.stderr).toContain('s -> ready');
  });

  test('status: rejects an unknown status string with exit 1', () => {
    withCapture(() => runTaskCmd('create', [undefined, undefined], { title: 'S2', id: 's2' }));
    const res = withCapture(() => runTaskCmd('status', ['s2', 'bogus'], {}));
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain("invalid status 'bogus'");
  });

  test('status: surfaces invalid-transition errors from the store', () => {
    withCapture(() => runTaskCmd('create', [undefined, undefined], { title: 'S3', id: 's3' }));
    // backlog -> done is not allowed; must go through ready/in_progress first
    const res = withCapture(() => runTaskCmd('status', ['s3', 'done'], {}));
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('invalid transition');
  });

  test('delete: soft-deletes and hides the task from list', () => {
    withCapture(() => runTaskCmd('create', [undefined, undefined], { title: 'D', id: 'd' }));
    const del = withCapture(() => runTaskCmd('delete', ['d', undefined], {}));
    expect(del.exit).toBe(0);
    const payload = JSON.parse(del.stdout.trim()) as { deleted: boolean; task_id: string };
    expect(payload.deleted).toBe(true);
    expect(payload.task_id).toBe('d');

    const l = withCapture(() => runTaskCmd('list', [undefined, undefined], {}));
    const rows = JSON.parse(l.stdout.trim()) as Array<{ id: string }>;
    expect(rows.some((r) => r.id === 'd')).toBe(false);
  });

  test('delete: missing <id> exits 1 with a usage hint', () => {
    const res = withCapture(() => runTaskCmd('delete', [undefined, undefined], {}));
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('<id> positional argument required');
  });
});

// ---------------------------------------------------------------------------
// milestone-cmd
// ---------------------------------------------------------------------------

describe('runMilestoneCmd', () => {
  test('create + list + close flow', () => {
    const c = withCapture(() =>
      runMilestoneCmd('create', [undefined, undefined], { title: 'M', id: 'm' }),
    );
    expect(c.exit).toBe(0);
    const created = JSON.parse(c.stdout.trim());
    expect(created.id).toBe('m');

    const l = withCapture(() => runMilestoneCmd('list', [undefined, undefined], {}));
    expect(l.exit).toBe(0);
    const rows = JSON.parse(l.stdout.trim()) as Array<{ id: string }>;
    expect(rows.some((r) => r.id === 'm')).toBe(true);

    const cl = withCapture(() => runMilestoneCmd('close', ['m', undefined], {}));
    expect(cl.exit).toBe(0);
    const closed = JSON.parse(cl.stdout.trim());
    expect(closed.status).toBe('closed');
  });

  test('create without --title: exit 1', () => {
    const res = withCapture(() => runMilestoneCmd('create', [undefined, undefined], {}));
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('--title is required');
  });
});

// ---------------------------------------------------------------------------
// tag-cmd
// ---------------------------------------------------------------------------

describe('runTagCmd', () => {
  test('add + list + remove round-trip', () => {
    withCapture(() => runTaskCmd('create', [undefined, undefined], { title: 'TT', id: 'tt' }));
    const a = withCapture(() => runTagCmd('add', ['tt', 'bug'], {}));
    expect(a.exit).toBe(0);
    const l = withCapture(() => runTagCmd('list', [undefined, undefined], { task: 'tt' }));
    expect(l.exit).toBe(0);
    const tags = JSON.parse(l.stdout.trim()) as Array<{ tag: string }>;
    expect(tags.some((r) => r.tag === 'bug')).toBe(true);

    const r = withCapture(() => runTagCmd('remove', ['tt', 'bug'], {}));
    expect(r.exit).toBe(0);
  });

  test('list without --task or --tag: exit 1', () => {
    const res = withCapture(() => runTagCmd('list', [undefined, undefined], {}));
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('--task or --tag is required');
  });
});

// ---------------------------------------------------------------------------
// link-run-cmd
// ---------------------------------------------------------------------------

describe('runLinkRunCmd', () => {
  test('happy path: JSON payload with linked=true', () => {
    withCapture(() => runTaskCmd('create', [undefined, undefined], { title: 'L', id: 'l' }));
    const res = withCapture(() => runLinkRunCmd('l', '.prove/runs/main/l/', { branch: 'main' }));
    expect(res.exit).toBe(0);
    const payload = JSON.parse(res.stdout.trim());
    expect(payload.linked).toBe(true);
    expect(payload.task_id).toBe('l');
    expect(payload.branch).toBe('main');
  });

  test('missing task-id: exit 1', () => {
    const res = withCapture(() => runLinkRunCmd(undefined, '.prove/runs/x/', {}));
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('<task-id> positional argument required');
  });

  test('missing run-path: exit 1', () => {
    const res = withCapture(() => runLinkRunCmd('l', undefined, {}));
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('<run-path> positional argument required');
  });
});

// ---------------------------------------------------------------------------
// hook-cmd — dispatch-shape smoke (handler body owned by Task 4)
// ---------------------------------------------------------------------------

describe('runHookCmd', () => {
  test('unknown event: exit 1 with guidance', () => {
    const res = withCapture(() => runHookCmd('not-real', {}));
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('unknown hook event');
  });

  test('empty stdin (no real stdin in test harness): exit 0 silent pass', () => {
    // Bun tests inherit a drained stdin — readStdinSync() returns '' and
    // the handler short-circuits before touching the Task-4 stub.
    const res = withCapture(() => runHookCmd('session-start', { workspaceRoot: workspace }));
    expect(res.exit).toBe(0);
    expect(res.stdout).toBe('');
  });
});

// ---------------------------------------------------------------------------
// alerts-cmd
// ---------------------------------------------------------------------------

describe('runAlertsCmd', () => {
  test('empty workspace: zero alerts, stderr summarizes counts', () => {
    const res = withCapture(() => runAlertsCmd({ workspaceRoot: workspace }));
    expect(res.exit).toBe(0);
    const payload = JSON.parse(res.stdout.trim()) as {
      stalled_wip: unknown[];
      orphan_runs: unknown[];
      stalled_after_days: number;
    };
    expect(payload.stalled_wip).toHaveLength(0);
    expect(payload.orphan_runs).toHaveLength(0);
    expect(payload.stalled_after_days).toBe(7);
    expect(res.stderr).toContain('0 stalled WIP');
    expect(res.stderr).toContain('0 orphan runs');
  });

  test('stalled WIP: in_progress task with an old last_event_at surfaces', () => {
    // Create task, transition it, then rewrite last_event_at directly
    // so it looks like it's been stalled for 14 days.
    withCapture(() => runTaskCmd('create', [undefined, undefined], { title: 'W', id: 'w' }));
    withCapture(() => runTaskCmd('status', ['w', 'ready'], {}));
    withCapture(() => runTaskCmd('status', ['w', 'in_progress'], {}));

    const ancient = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    // biome-ignore lint/suspicious/noExplicitAny: test-only escape hatch into the unified store
    const { openScrumStore } = require('../store') as any;
    const s = openScrumStore({ override: join(workspace, '.prove', 'prove.db') });
    s.getDb?.() ?? null;
    // The store doesn't expose a direct last_event_at setter, so edit
    // the underlying sqlite row to simulate the stalled condition.
    s.store.getDb().prepare('UPDATE scrum_tasks SET last_event_at = ? WHERE id = ?').run(ancient, 'w');
    s.close();

    const res = withCapture(() => runAlertsCmd({ workspaceRoot: workspace, stalledAfterDays: 7 }));
    expect(res.exit).toBe(0);
    const payload = JSON.parse(res.stdout.trim()) as {
      stalled_wip: Array<{ id: string; stalled_days: number; status: string }>;
    };
    expect(payload.stalled_wip.some((e) => e.id === 'w' && e.status === 'in_progress')).toBe(true);
    const entry = payload.stalled_wip.find((e) => e.id === 'w');
    expect(entry?.stalled_days).toBeGreaterThanOrEqual(13);
  });

  test('orphan runs: untracked .prove/runs/* directories surface', () => {
    mkdirSync(join(workspace, '.prove', 'runs', 'main', 'ghost-run'), { recursive: true });
    const res = withCapture(() => runAlertsCmd({ workspaceRoot: workspace }));
    expect(res.exit).toBe(0);
    const payload = JSON.parse(res.stdout.trim()) as {
      orphan_runs: Array<{ branch: string; slug: string }>;
    };
    expect(payload.orphan_runs).toHaveLength(1);
    expect(payload.orphan_runs[0]?.branch).toBe('main');
    expect(payload.orphan_runs[0]?.slug).toBe('ghost-run');
  });

  test('orphan runs: runs linked in scrum_run_links are NOT flagged', () => {
    mkdirSync(join(workspace, '.prove', 'runs', 'main', 'tracked-run'), { recursive: true });
    withCapture(() => runTaskCmd('create', [undefined, undefined], { title: 'L', id: 'l' }));
    const linked = withCapture(() =>
      runLinkRunCmd('l', join('.prove', 'runs', 'main', 'tracked-run'), { branch: 'main' }),
    );
    expect(linked.exit).toBe(0);

    const res = withCapture(() => runAlertsCmd({ workspaceRoot: workspace }));
    const payload = JSON.parse(res.stdout.trim()) as {
      orphan_runs: Array<{ slug: string }>;
    };
    expect(payload.orphan_runs.some((r) => r.slug === 'tracked-run')).toBe(false);
  });

  test('--human table is produced when the flag is set', () => {
    const res = withCapture(() => runAlertsCmd({ workspaceRoot: workspace, human: true }));
    expect(res.exit).toBe(0);
    expect(res.stdout).toContain('Stalled WIP');
    expect(res.stdout).toContain('Orphan runs');
  });
});

// ---------------------------------------------------------------------------
// init-cmd — importer precision (noise filter + ICE dedup + milestone lift)
// ---------------------------------------------------------------------------

describe('runInitCmd (importer precision)', () => {
  test('filters section-header noise rows (trailing colon, bare bold)', () => {
    mkdirSync(join(workspace, 'planning'), { recursive: true });
    writeFileSync(
      join(workspace, 'planning', 'ROADMAP.md'),
      [
        '## Milestone: Alpha',
        '- **M1 capstone (2026-04-19)**:',
        '- **Alpha**',
        '- real task that should land',
        '',
      ].join('\n'),
      'utf8',
    );

    const res = withCapture(() => runInitCmd({ workspaceRoot: workspace }));
    expect(res.exit).toBe(0);
    const payload = JSON.parse(res.stdout.trim()) as { tasks: number };
    expect(payload.tasks).toBe(1);

    const list = withCapture(() => runTaskCmd('list', [undefined, undefined], {}));
    const rows = JSON.parse(list.stdout.trim()) as Array<{ title: string }>;
    expect(rows.some((r) => r.title.includes('capstone'))).toBe(false);
    expect(rows.some((r) => r.title === 'real task that should land')).toBe(true);
  });

  test('filters dependency-prose rows from BACKLOG', () => {
    mkdirSync(join(workspace, 'planning'), { recursive: true });
    writeFileSync(
      join(workspace, 'planning', 'BACKLOG.md'),
      ['- parser: all depend on AST node type 9', '- see also: other doc', '- real backlog item', ''].join(
        '\n',
      ),
      'utf8',
    );

    const res = withCapture(() => runInitCmd({ workspaceRoot: workspace }));
    expect(res.exit).toBe(0);
    const list = withCapture(() => runTaskCmd('list', [undefined, undefined], {}));
    const rows = JSON.parse(list.stdout.trim()) as Array<{ title: string }>;
    expect(rows.map((r) => r.title)).toEqual(['real backlog item']);
  });

  test('dedupes ICE-tagged entries between ROADMAP and BACKLOG', () => {
    mkdirSync(join(workspace, 'planning'), { recursive: true });
    writeFileSync(
      join(workspace, 'planning', 'ROADMAP.md'),
      ['## Milestone: M1', '- ICE 100 parse negative literals', ''].join('\n'),
      'utf8',
    );
    writeFileSync(
      join(workspace, 'planning', 'BACKLOG.md'),
      ['- ICE 100 parse negative literals (merge note)', '- ICE 200 distinct item', ''].join('\n'),
      'utf8',
    );

    const res = withCapture(() => runInitCmd({ workspaceRoot: workspace }));
    expect(res.exit).toBe(0);

    const list = withCapture(() => runTaskCmd('list', [undefined, undefined], {}));
    const rows = JSON.parse(list.stdout.trim()) as Array<{ title: string }>;
    const ice100 = rows.filter((r) => /ICE 100/.test(r.title));
    expect(ice100).toHaveLength(1);
    const ice200 = rows.filter((r) => /ICE 200/.test(r.title));
    expect(ice200).toHaveLength(1);
  });

  test('raises referenced milestone rows via `## M<n>` anchors', () => {
    mkdirSync(join(workspace, 'planning'), { recursive: true });
    writeFileSync(
      join(workspace, 'planning', 'ROADMAP.md'),
      [
        '## M1 capstone (2026-04-19)',
        '- real task alpha',
        '',
        '## M2 later milestone',
        '- real task beta',
        '',
      ].join('\n'),
      'utf8',
    );

    const res = withCapture(() => runInitCmd({ workspaceRoot: workspace }));
    expect(res.exit).toBe(0);
    const payload = JSON.parse(res.stdout.trim()) as { milestones: number; tasks: number };
    expect(payload.milestones).toBe(2);
    expect(payload.tasks).toBe(2);

    const ml = withCapture(() => runMilestoneCmd('list', [undefined, undefined], {}));
    const milestones = JSON.parse(ml.stdout.trim()) as Array<{ id: string }>;
    expect(milestones.map((m) => m.id).sort()).toEqual(['m1', 'm2']);
  });

  test('infers milestone from `M<n>` token in BACKLOG titles, creating placeholder rows', () => {
    mkdirSync(join(workspace, 'planning'), { recursive: true });
    writeFileSync(
      join(workspace, 'planning', 'BACKLOG.md'),
      ['- M3 something to do later', '- M3 another thing in M3', '- no milestone here', ''].join('\n'),
      'utf8',
    );

    const res = withCapture(() => runInitCmd({ workspaceRoot: workspace }));
    expect(res.exit).toBe(0);
    const payload = JSON.parse(res.stdout.trim()) as { milestones: number; tasks: number };
    expect(payload.milestones).toBe(1);
    expect(payload.tasks).toBe(3);

    const ml = withCapture(() => runMilestoneCmd('list', [undefined, undefined], {}));
    const milestones = JSON.parse(ml.stdout.trim()) as Array<{ id: string }>;
    expect(milestones.map((m) => m.id)).toContain('m3');
  });
});
