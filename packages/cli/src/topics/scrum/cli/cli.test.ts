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
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { appendEntry } from '../../acb/reasoning-log-store';
import { runAlertsCmd } from './alerts-cmd';
import { runContributorCmd } from './contributor-cmd';
import { parseDecisionFile, runDecisionCmd } from './decision-cmd';
import { runGateCmd } from './gate-cmd';
import { runHookCmd } from './hook-cmd';
import { runInitCmd } from './init-cmd';
import { runLinkRunCmd } from './link-run-cmd';
import { runMilestoneCmd } from './milestone-cmd';
import { runNextReadyCmd } from './next-ready-cmd';
import { runOperatorCmd } from './operator-cmd';
import { runStatusCmd } from './status-cmd';
import { runTagCmd } from './tag-cmd';
import { runTaskCmd } from './task-cmd';
import { runTeamCmd } from './team-cmd';

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

/**
 * Restore an env var to a saved value, deleting it when it was previously
 * unset. Wraps the `delete` operator so it stays out of test bodies (biome
 * `noDelete`).
 */
function restoreEnv(key: string, saved: string | undefined): void {
  if (saved === undefined) {
    if (key in process.env) delete process.env[key];
  } else {
    process.env[key] = saved;
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

  test('a mid-import id collision rolls back the seed and leaves planning/ intact', () => {
    // Pre-create milestone `alpha` (matching the id the ROADMAP importer will
    // derive from `## Milestone: Alpha`). hasExistingTasks checks tasks only, so
    // the importer still runs, then its createMilestone({id:'alpha'}) throws a
    // UNIQUE conflict mid-import.
    withCapture(() =>
      runMilestoneCmd('create', [undefined, undefined], { title: 'Alpha', id: 'alpha' }),
    );

    mkdirSync(join(workspace, 'planning'), { recursive: true });
    const roadmapPath = join(workspace, 'planning', 'ROADMAP.md');
    writeFileSync(roadmapPath, ['## Milestone: Alpha', '- a real task', ''].join('\n'), 'utf8');

    expect(() => runInitCmd({ workspaceRoot: workspace })).toThrow();

    // The whole seed rolled back: no tasks landed, so the next invocation is
    // not wedged on already-seeded — the import stays retryable.
    const list = withCapture(() => runTaskCmd('list', [undefined, undefined], {}));
    const rows = JSON.parse(list.stdout.trim()) as Array<{ id: string }>;
    expect(rows).toHaveLength(0);

    // cleanupLegacyFiles ran OUTSIDE the transaction (after a commit that never
    // happened), so the planning file survives for the retry.
    expect(existsSync(roadmapPath)).toBe(true);
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

  test('task_tree nests children under parents with a rolled-up derived_status', () => {
    withCapture(() =>
      runTaskCmd('create', [undefined, undefined], { title: 'Epic', id: 'epic', layer: 'epic' }),
    );
    withCapture(() =>
      runTaskCmd('create', [undefined, undefined], {
        title: 'Leaf',
        id: 'leaf',
        parent: 'epic',
        layer: 'task',
      }),
    );
    withCapture(() => runTaskCmd('status', ['leaf', 'ready'], {}));
    withCapture(() => runTaskCmd('status', ['leaf', 'in_progress'], {}));

    const res = withCapture(() => runStatusCmd({}));
    const payload = JSON.parse(res.stdout.trim()) as {
      task_tree: Array<{ id: string; derived_status: string; children: Array<{ id: string }> }>;
    };
    const epic = payload.task_tree.find((n) => n.id === 'epic');
    expect(epic?.children.map((c) => c.id)).toEqual(['leaf']);
    // Epic is authored backlog but rolls up to in_progress from its leaf.
    expect(epic?.derived_status).toBe('in_progress');
    // A flat task is not duplicated as a child anywhere.
    expect(payload.task_tree.some((n) => n.id === 'leaf')).toBe(false);
  });

  test('--human renders the Task tree section', () => {
    withCapture(() =>
      runTaskCmd('create', [undefined, undefined], { title: 'Epic', id: 'epic', layer: 'epic' }),
    );
    const res = withCapture(() => runStatusCmd({ human: true }));
    expect(res.stdout).toContain('Task tree');
    expect(res.stdout).toContain('epic: epic');
  });
});

// ---------------------------------------------------------------------------
// milestone-cmd — close fires the curation trigger (1.2b)
// ---------------------------------------------------------------------------

describe('runMilestoneCmd close → curation trigger', () => {
  /** Seed milestone + task + a linked run carrying one `hack` finding. */
  function seedTaskWithFinding(milestoneId: string, taskId: string): void {
    withCapture(() =>
      runMilestoneCmd('create', [undefined, undefined], {
        title: `Milestone ${milestoneId}`,
        id: milestoneId,
        workspaceRoot: workspace,
      }),
    );
    withCapture(() =>
      runTaskCmd('create', [undefined, undefined], {
        title: `Task ${taskId}`,
        id: taskId,
        milestone: milestoneId,
      }),
    );
    const runRel = join('.prove', 'runs', 'feat', taskId);
    withCapture(() => runLinkRunCmd(taskId, runRel, { workspaceRoot: workspace }));
    appendEntry(join(workspace, runRel), {
      id: 'h1',
      ts: '2026-06-01T10:00:00Z',
      type: 'hack',
      agent: 'engineer',
      run_path: runRel,
      body: 'temporary shim',
      file_refs: ['x.ts'],
      cleanup_condition: 'when upstream lands',
    });
  }

  test('emits a curation note for a task carrying findings', () => {
    seedTaskWithFinding('mc1', 'cur-1');
    const res = withCapture(() =>
      runMilestoneCmd('close', ['mc1', undefined], { workspaceRoot: workspace }),
    );
    expect(res.exit).toBe(0);
    expect(res.stderr).toContain('curation: 1 task(s) proposed');
  });

  test('re-closing an already-closed milestone does not re-fire curation', () => {
    seedTaskWithFinding('mc2', 'cur-2');
    withCapture(() => runMilestoneCmd('close', ['mc2', undefined], { workspaceRoot: workspace }));
    const second = withCapture(() =>
      runMilestoneCmd('close', ['mc2', undefined], { workspaceRoot: workspace }),
    );
    expect(second.exit).toBe(0);
    expect(second.stderr).not.toContain('curation:');
  });

  test('reports zero proposals when no task carries findings', () => {
    withCapture(() =>
      runMilestoneCmd('create', [undefined, undefined], {
        title: 'M',
        id: 'mc3',
        workspaceRoot: workspace,
      }),
    );
    withCapture(() =>
      runTaskCmd('create', [undefined, undefined], { title: 'T', id: 'cur-3', milestone: 'mc3' }),
    );
    const res = withCapture(() =>
      runMilestoneCmd('close', ['mc3', undefined], { workspaceRoot: workspace }),
    );
    expect(res.stderr).toContain('curation: 0 task(s) proposed');
  });
});

// ---------------------------------------------------------------------------
// milestone-cmd — initiative grouping (the tier above milestone)
// ---------------------------------------------------------------------------

describe('runMilestoneCmd initiative grouping', () => {
  test('create --initiative persists the grouping label', () => {
    const res = withCapture(() =>
      runMilestoneCmd('create', [undefined, undefined], {
        title: 'M',
        id: 'm1',
        initiative: 'q3-growth',
      }),
    );
    expect(res.exit).toBe(0);
    expect((JSON.parse(res.stdout.trim()) as { initiative: string | null }).initiative).toBe(
      'q3-growth',
    );
  });

  test('list --initiative filters to the matching initiative', () => {
    withCapture(() =>
      runMilestoneCmd('create', [undefined, undefined], {
        title: 'A',
        id: 'ma',
        initiative: 'bet1',
      }),
    );
    withCapture(() =>
      runMilestoneCmd('create', [undefined, undefined], {
        title: 'B',
        id: 'mb',
        initiative: 'bet1',
      }),
    );
    withCapture(() =>
      runMilestoneCmd('create', [undefined, undefined], {
        title: 'C',
        id: 'mc',
        initiative: 'bet2',
      }),
    );

    const res = withCapture(() =>
      runMilestoneCmd('list', [undefined, undefined], { initiative: 'bet1' }),
    );
    const ids = (JSON.parse(res.stdout.trim()) as Array<{ id: string }>).map((m) => m.id).sort();
    expect(ids).toEqual(['ma', 'mb']);
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

  test('rationale surfaces escalation_boost + escalation_type for an open escalation', () => {
    withCapture(() => runTaskCmd('create', [undefined, undefined], { title: 'E', id: 'e' }));
    withCapture(() => runTaskCmd('status', ['e', 'ready'], {}));
    // biome-ignore lint/suspicious/noExplicitAny: test-only store reach-in to seed an escalation event.
    const { openScrumStore } = require('../store') as any;
    const s = openScrumStore({ override: join(workspace, '.prove', 'prove.db') });
    try {
      s.appendEvent({
        taskId: 'e',
        kind: 'blocker_raised',
        payload: { escalation_type: 'ambiguous', summary: 'spec unclear' },
      });
    } finally {
      s.close();
    }
    const json = withCapture(() => runNextReadyCmd({ workspaceRoot: workspace }));
    const rows = JSON.parse(json.stdout.trim()) as Array<{
      task: { id: string };
      rationale: { escalation_boost: number; escalation_type: string | null };
    }>;
    const row = rows.find((r) => r.task.id === 'e');
    expect(row?.rationale.escalation_boost).toBeGreaterThan(0);
    expect(row?.rationale.escalation_type).toBe('ambiguous');

    const human = withCapture(() => runNextReadyCmd({ workspaceRoot: workspace, human: true }));
    expect(human.stdout).toContain('escalation=');
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

  test('show surfaces v11 worker_id/run_id + the reusable provenance block', () => {
    const savedWorker = process.env.PROVE_WORKER_ID;
    const savedSlug = process.env.PROVE_RUN_SLUG;
    process.env.PROVE_WORKER_ID = 'worker-42';
    process.env.PROVE_RUN_SLUG = 'feat-prov';
    try {
      const c = withCapture(() =>
        runTaskCmd('create', [undefined, undefined], { title: 'Prov', id: 'prov' }),
      );
      expect(c.exit).toBe(0);

      const s = withCapture(() => runTaskCmd('show', ['prov', undefined], {}));
      expect(s.exit).toBe(0);
      const shown = JSON.parse(s.stdout.trim());
      expect(shown.task.worker_id).toBe('worker-42');
      expect(shown.task.run_id).toBe('feat-prov');
      expect(shown.task.provenance.worker_id).toBe('worker-42');
      expect(shown.task.provenance.run_id).toBe('feat-prov');
      expect(shown.task.provenance.schema_version).toBe(14);
    } finally {
      restoreEnv('PROVE_WORKER_ID', savedWorker);
      restoreEnv('PROVE_RUN_SLUG', savedSlug);
    }
  });

  test('create --parent --layer: persists the containment tree', () => {
    const epic = withCapture(() =>
      runTaskCmd('create', [undefined, undefined], {
        title: 'Auth epic',
        id: 'epic-1',
        layer: 'epic',
      }),
    );
    expect(epic.exit).toBe(0);
    expect(JSON.parse(epic.stdout.trim()).layer).toBe('epic');

    const story = withCapture(() =>
      runTaskCmd('create', [undefined, undefined], {
        title: 'Login story',
        id: 'story-1',
        parent: 'epic-1',
        layer: 'story',
      }),
    );
    expect(story.exit).toBe(0);
    const row = JSON.parse(story.stdout.trim());
    expect(row.parent_id).toBe('epic-1');
    expect(row.layer).toBe('story');
  });

  test('create --layer: rejects an off-vocabulary tier with exit 1', () => {
    const res = withCapture(() =>
      runTaskCmd('create', [undefined, undefined], { title: 'X', id: 'x-bad', layer: 'sprint' }),
    );
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain("invalid --layer 'sprint'");
  });

  test('create --parent: unknown parent surfaces the store error as exit 1', () => {
    const res = withCapture(() =>
      runTaskCmd('create', [undefined, undefined], {
        title: 'Orphan',
        id: 'orphan-1',
        parent: 'nonexistent',
      }),
    );
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain("unknown parent_id 'nonexistent'");
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
    // link-decision now reads the file — seed one so the handler succeeds.
    mkdirSync(join(workspace, '.prove', 'decisions'), { recursive: true });
    writeFileSync(join(workspace, '.prove', 'decisions', 'x.md'), '# X decision\n', 'utf8');
    const res = withCapture(() => runTaskCmd('link-decision', ['z', '.prove/decisions/x.md'], {}));
    expect(res.exit).toBe(0);
    const payload = JSON.parse(res.stdout.trim());
    expect(payload.linked).toBe(true);
    expect(payload.decision_path).toBe('.prove/decisions/x.md');
    expect(payload.decision_id).toBe('x');
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

  // -------------------------------------------------------------------------
  // cancel action (v7)
  // -------------------------------------------------------------------------

  test('cancel: single task records terminal provenance', () => {
    withCapture(() => runTaskCmd('create', [undefined, undefined], { title: 'C', id: 'c' }));
    const res = withCapture(() =>
      runTaskCmd('cancel', ['c', undefined], { reason: 'descoped', detail: 'cut from v1' }),
    );
    expect(res.exit).toBe(0);
    const task = JSON.parse(res.stdout.trim()) as {
      status: string;
      terminal_reason: string;
      terminal_detail: string;
    };
    expect(task.status).toBe('cancelled');
    expect(task.terminal_reason).toBe('descoped');
    expect(task.terminal_detail).toBe('cut from v1');
  });

  test('cancel --cascade cancels the subtree and reports the ids', () => {
    withCapture(() =>
      runTaskCmd('create', [undefined, undefined], { title: 'E', id: 'e', layer: 'epic' }),
    );
    withCapture(() =>
      runTaskCmd('create', [undefined, undefined], {
        title: 'S',
        id: 's',
        parent: 'e',
        layer: 'story',
      }),
    );
    const res = withCapture(() => runTaskCmd('cancel', ['e', undefined], { cascade: true }));
    expect(res.exit).toBe(0);
    const out = JSON.parse(res.stdout.trim()) as { cancelled: string[] };
    expect(out.cancelled.sort()).toEqual(['e', 's']);
  });

  test('cancel: missing <id> exits 1 with a usage hint', () => {
    const res = withCapture(() => runTaskCmd('cancel', [undefined, undefined], {}));
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('<id> positional argument required');
  });

  test('cancel: already-terminal task surfaces the store error as exit 1', () => {
    withCapture(() => runTaskCmd('create', [undefined, undefined], { title: 'C2', id: 'c2' }));
    withCapture(() => runTaskCmd('cancel', ['c2', undefined], {}));
    const res = withCapture(() => runTaskCmd('cancel', ['c2', undefined], {}));
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('already terminal');
  });

  // -------------------------------------------------------------------------
  // move action
  // -------------------------------------------------------------------------

  function seedMove(taskId: string, milestoneId?: string, milestoneStatus?: 'closed') {
    if (milestoneId) {
      withCapture(() =>
        runMilestoneCmd('create', [undefined, undefined], {
          title: `Milestone ${milestoneId}`,
          id: milestoneId,
        }),
      );
      if (milestoneStatus === 'closed') {
        withCapture(() => runMilestoneCmd('close', [milestoneId, undefined], {}));
      }
    }
    withCapture(() =>
      runTaskCmd('create', [undefined, undefined], {
        title: `Task ${taskId}`,
        id: taskId,
        milestone: milestoneId,
      }),
    );
  }

  test('move: reassigns milestone and returns updated task JSON', () => {
    seedMove('mv-1', 'm1');
    withCapture(() => runMilestoneCmd('create', [undefined, undefined], { title: 'M2', id: 'm2' }));

    const res = withCapture(() => runTaskCmd('move', ['mv-1', undefined], { milestone: 'm2' }));
    expect(res.exit).toBe(0);
    const task = JSON.parse(res.stdout.trim()) as { id: string; milestone_id: string };
    expect(task.id).toBe('mv-1');
    expect(task.milestone_id).toBe('m2');
    expect(res.stderr).toContain('mv-1 -> m2');
  });

  test('move: --unassign clears milestone_id', () => {
    seedMove('mv-2', 'm1');

    const res = withCapture(() => runTaskCmd('move', ['mv-2', undefined], { unassign: true }));
    expect(res.exit).toBe(0);
    const task = JSON.parse(res.stdout.trim()) as { milestone_id: string | null };
    expect(task.milestone_id).toBeNull();
    expect(res.stderr).toContain('mv-2 -> unassigned');
  });

  test('move: --milestone="" also clears milestone_id', () => {
    seedMove('mv-3', 'm1');

    const res = withCapture(() => runTaskCmd('move', ['mv-3', undefined], { milestone: '' }));
    expect(res.exit).toBe(0);
    const task = JSON.parse(res.stdout.trim()) as { milestone_id: string | null };
    expect(task.milestone_id).toBeNull();
    expect(res.stderr).toContain('mv-3 -> unassigned');
  });

  test('move: neither --milestone nor --unassign → exit 1 with usage hint', () => {
    seedMove('mv-4');

    const res = withCapture(() => runTaskCmd('move', ['mv-4', undefined], {}));
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('--milestone <id> or --unassign is required');
  });

  test('move: missing <id> exits 1 with a usage hint', () => {
    const res = withCapture(() => runTaskCmd('move', [undefined, undefined], { milestone: 'm1' }));
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('<id> positional argument required');
  });

  test('move: unknown target milestone → exit 1, store error bubbles through', () => {
    seedMove('mv-5');

    const res = withCapture(() =>
      runTaskCmd('move', ['mv-5', undefined], { milestone: 'nonexistent' }),
    );
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain("unknown milestone_id 'nonexistent'");
  });

  test('move: unknown task id → exit 1', () => {
    withCapture(() => runMilestoneCmd('create', [undefined, undefined], { title: 'M1', id: 'm1' }));

    const res = withCapture(() => runTaskCmd('move', ['ghost', undefined], { milestone: 'm1' }));
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain("unknown task 'ghost'");
  });

  test('move: closed target milestone succeeds with stderr warning and exit 0', () => {
    seedMove('mv-6', 'm-closed', 'closed');
    withCapture(() => runTaskCmd('create', [undefined, undefined], { title: 'MV-7', id: 'mv-7' }));

    const res = withCapture(() =>
      runTaskCmd('move', ['mv-7', undefined], { milestone: 'm-closed' }),
    );
    expect(res.exit).toBe(0);
    expect(res.stderr).toContain("target milestone 'm-closed' is closed");
    expect(res.stderr).toContain('mv-7 -> m-closed');
    const task = JSON.parse(res.stdout.trim()) as { milestone_id: string };
    expect(task.milestone_id).toBe('m-closed');
  });

  test('move: --unassign beats --milestone when both provided', () => {
    seedMove('mv-8', 'm1');

    const res = withCapture(() =>
      runTaskCmd('move', ['mv-8', undefined], { milestone: 'm1', unassign: true }),
    );
    expect(res.exit).toBe(0);
    const task = JSON.parse(res.stdout.trim()) as { milestone_id: string | null };
    expect(task.milestone_id).toBeNull();
  });

  // -------------------------------------------------------------------------
  // add-dep / remove-dep actions
  // -------------------------------------------------------------------------

  function seedDepPair(): void {
    withCapture(() => runTaskCmd('create', [undefined, undefined], { title: 'A', id: 'a' }));
    withCapture(() => runTaskCmd('create', [undefined, undefined], { title: 'B', id: 'b' }));
  }

  test('add-dep: records a blocks edge (default kind) and shows up in show payload', () => {
    seedDepPair();
    const res = withCapture(() => runTaskCmd('add-dep', ['a', 'b'], {}));
    expect(res.exit).toBe(0);
    const payload = JSON.parse(res.stdout.trim()) as {
      added: boolean;
      from_task_id: string;
      to_task_id: string;
      kind: string;
    };
    expect(payload).toEqual({ added: true, from_task_id: 'a', to_task_id: 'b', kind: 'blocks' });

    const shown = withCapture(() => runTaskCmd('show', ['b', undefined], {}));
    const parsed = JSON.parse(shown.stdout.trim()) as {
      blocked_by: Array<{ from_task_id: string; to_task_id: string; kind: string }>;
      blocking: Array<{ from_task_id: string; to_task_id: string; kind: string }>;
    };
    expect(parsed.blocked_by).toEqual([{ from_task_id: 'a', to_task_id: 'b', kind: 'blocks' }]);
    expect(parsed.blocking).toEqual([]);

    const shownA = withCapture(() => runTaskCmd('show', ['a', undefined], {}));
    const parsedA = JSON.parse(shownA.stdout.trim()) as {
      blocking: Array<{ from_task_id: string; to_task_id: string; kind: string }>;
    };
    expect(parsedA.blocking).toEqual([{ from_task_id: 'a', to_task_id: 'b', kind: 'blocks' }]);
  });

  test('add-dep: idempotent — repeat insert is a no-op at the store layer', () => {
    seedDepPair();
    withCapture(() => runTaskCmd('add-dep', ['a', 'b'], {}));
    const second = withCapture(() => runTaskCmd('add-dep', ['a', 'b'], {}));
    expect(second.exit).toBe(0);
    const shown = withCapture(() => runTaskCmd('show', ['b', undefined], {}));
    const parsed = JSON.parse(shown.stdout.trim()) as { blocked_by: unknown[] };
    expect(parsed.blocked_by).toHaveLength(1);
  });

  test('add-dep: self-edge rejected with store error on stderr', () => {
    withCapture(() => runTaskCmd('create', [undefined, undefined], { title: 'S', id: 's' }));
    const res = withCapture(() => runTaskCmd('add-dep', ['s', 's'], {}));
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('self-dependency rejected');
  });

  test('add-dep: unknown task id bubbles up from the store', () => {
    withCapture(() => runTaskCmd('create', [undefined, undefined], { title: 'X', id: 'x' }));
    const res = withCapture(() => runTaskCmd('add-dep', ['x', 'ghost'], {}));
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain("unknown to_task 'ghost'");
  });

  test('add-dep: invalid --kind exits 1 with a usage hint', () => {
    seedDepPair();
    const res = withCapture(() => runTaskCmd('add-dep', ['a', 'b'], { kind: 'bogus' }));
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain("invalid --kind 'bogus'");
  });

  test('add-dep: missing <from>/<to> exits 1 with a usage hint', () => {
    const res = withCapture(() => runTaskCmd('add-dep', [undefined, undefined], {}));
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('<from> and <to> positional arguments required');
  });

  test('add-dep: --kind blocked_by stores the inverse edge', () => {
    seedDepPair();
    const res = withCapture(() => runTaskCmd('add-dep', ['a', 'b'], { kind: 'blocked_by' }));
    expect(res.exit).toBe(0);
    const payload = JSON.parse(res.stdout.trim()) as { kind: string };
    expect(payload.kind).toBe('blocked_by');
    // `blocks`-keyed reads ignore blocked_by rows, so show payload stays empty for both tasks.
    const shown = withCapture(() => runTaskCmd('show', ['b', undefined], {}));
    const parsed = JSON.parse(shown.stdout.trim()) as { blocked_by: unknown[] };
    expect(parsed.blocked_by).toEqual([]);
  });

  test('remove-dep: deletes the edge and show payload goes back to empty', () => {
    seedDepPair();
    withCapture(() => runTaskCmd('add-dep', ['a', 'b'], {}));
    const rm = withCapture(() => runTaskCmd('remove-dep', ['a', 'b'], {}));
    expect(rm.exit).toBe(0);
    const payload = JSON.parse(rm.stdout.trim()) as { removed: boolean; kind: string };
    expect(payload).toEqual({
      removed: true,
      from_task_id: 'a',
      to_task_id: 'b',
      kind: 'blocks',
    } as unknown as typeof payload);

    const shown = withCapture(() => runTaskCmd('show', ['b', undefined], {}));
    const parsed = JSON.parse(shown.stdout.trim()) as { blocked_by: unknown[] };
    expect(parsed.blocked_by).toEqual([]);
  });

  test('remove-dep: missing edge is a no-op (idempotent), exit 0', () => {
    seedDepPair();
    const res = withCapture(() => runTaskCmd('remove-dep', ['a', 'b'], {}));
    expect(res.exit).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// task acceptance (v5) — positional = [sub-action, task-id]
// ---------------------------------------------------------------------------

describe('runTaskCmd acceptance', () => {
  function seedAcTask(id = 'at') {
    withCapture(() => runTaskCmd('create', [undefined, undefined], { title: id, id }));
  }

  test('add + list round-trip', () => {
    seedAcTask();
    const add = withCapture(() =>
      runTaskCmd('acceptance', ['add', 'at'], {
        text: 'builds clean',
        verifiesBy: 'bash',
        check: 'bun run build',
        idempotent: true,
        criterion: 'c1',
      }),
    );
    expect(add.exit).toBe(0);

    const list = withCapture(() => runTaskCmd('acceptance', ['list', 'at'], {}));
    expect(list.exit).toBe(0);
    const criteria = JSON.parse(list.stdout.trim()) as Array<{ id: string; idempotent: boolean }>;
    expect(criteria.map((c) => c.id)).toEqual(['c1']);
    expect(criteria[0]?.idempotent).toBe(true);
  });

  test('add rejects an invalid --verifies-by', () => {
    seedAcTask();
    const res = withCapture(() =>
      runTaskCmd('acceptance', ['add', 'at'], { text: 't', verifiesBy: 'bogus', check: 'x' }),
    );
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('--verifies-by must be one of');
  });

  test('add threads --scope onto the criterion', () => {
    seedAcTask();
    const add = withCapture(() =>
      runTaskCmd('acceptance', ['add', 'at'], {
        text: 'parent-only gate',
        verifiesBy: 'bash',
        check: 'x',
        scope: 'self',
        criterion: 'c1',
      }),
    );
    expect(add.exit).toBe(0);
    const list = withCapture(() => runTaskCmd('acceptance', ['list', 'at'], {}));
    const criteria = JSON.parse(list.stdout.trim()) as Array<{ id: string; scope?: string }>;
    expect(criteria[0]?.scope).toBe('self');
  });

  test('add rejects an invalid --scope', () => {
    seedAcTask();
    const res = withCapture(() =>
      runTaskCmd('acceptance', ['add', 'at'], {
        text: 't',
        verifiesBy: 'bash',
        check: 'x',
        scope: 'children',
      }),
    );
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('--scope must be one of');
  });

  test('add requires --text and --check', () => {
    seedAcTask();
    const noText = withCapture(() =>
      runTaskCmd('acceptance', ['add', 'at'], { verifiesBy: 'bash', check: 'x' }),
    );
    expect(noText.exit).toBe(1);
    expect(noText.stderr).toContain('--text is required');
  });

  test('supersede flips status, retains the criterion (append-only)', () => {
    seedAcTask();
    withCapture(() =>
      runTaskCmd('acceptance', ['add', 'at'], {
        text: 'old',
        verifiesBy: 'bash',
        check: 'x',
        criterion: 'c1',
      }),
    );
    const res = withCapture(() =>
      runTaskCmd('acceptance', ['supersede', 'at'], { criterion: 'c1', reason: 'replaced' }),
    );
    expect(res.exit).toBe(0);

    const list = withCapture(() => runTaskCmd('acceptance', ['list', 'at'], {}));
    const criteria = JSON.parse(list.stdout.trim()) as Array<{ id: string; status: string }>;
    expect(criteria).toHaveLength(1);
    expect(criteria[0]?.status).toBe('superseded');
  });

  test('unknown acceptance sub-action: exit 1', () => {
    seedAcTask();
    const res = withCapture(() => runTaskCmd('acceptance', ['nope', 'at'], {}));
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('sub-action required');
  });
});

// ---------------------------------------------------------------------------
// gate respond — positional = [sub-action, criterion-id, verdict]
// ---------------------------------------------------------------------------

describe('runGateCmd respond', () => {
  function seedGateTask(taskId = 'gt', criterionId = 'g1') {
    withCapture(() => runTaskCmd('create', [undefined, undefined], { title: taskId, id: taskId }));
    withCapture(() =>
      runTaskCmd('acceptance', ['add', taskId], {
        text: 'operator approves',
        verifiesBy: 'gate',
        check: 'approve the design',
        criterion: criterionId,
      }),
    );
  }

  function readGate(taskId = 'gt', criterionId = 'g1') {
    const list = withCapture(() => runTaskCmd('acceptance', ['list', taskId], {}));
    const criteria = JSON.parse(list.stdout.trim()) as Array<{
      id: string;
      gate?: { verdict: string; responder?: string | null; comment?: string | null };
    }>;
    return criteria.find((c) => c.id === criterionId)?.gate;
  }

  test('approve persists verdict + responder + comment, round-trips through the store', () => {
    seedGateTask();
    const res = withCapture(() =>
      runGateCmd('respond', ['g1', 'approve'], { task: 'gt', by: 'alice', comment: 'LGTM' }),
    );
    expect(res.exit).toBe(0);
    const payload = JSON.parse(res.stdout.trim()) as { verdict: string; responder: string };
    expect(payload.verdict).toBe('approved');
    expect(payload.responder).toBe('alice');

    const gate = readGate();
    expect(gate?.verdict).toBe('approved');
    expect(gate?.responder).toBe('alice');
    expect(gate?.comment).toBe('LGTM');
  });

  test('reject persists rejected', () => {
    seedGateTask();
    const res = withCapture(() =>
      runGateCmd('respond', ['g1', 'reject'], { task: 'gt', by: 'bob' }),
    );
    expect(res.exit).toBe(0);
    expect(readGate()?.verdict).toBe('rejected');
  });

  test('rejects an unknown criterion id (exit 1)', () => {
    seedGateTask();
    const res = withCapture(() => runGateCmd('respond', ['nope', 'approve'], { task: 'gt' }));
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain("unknown criterion 'nope'");
  });

  test('rejects a non-gate criterion (exit 1)', () => {
    withCapture(() => runTaskCmd('create', [undefined, undefined], { title: 'bt', id: 'bt' }));
    withCapture(() =>
      runTaskCmd('acceptance', ['add', 'bt'], {
        text: 'builds',
        verifiesBy: 'bash',
        check: 'bun run build',
        criterion: 'c1',
      }),
    );
    const res = withCapture(() => runGateCmd('respond', ['c1', 'approve'], { task: 'bt' }));
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain("not 'gate'");
  });

  test('rejects an already-resolved gate (exit 1)', () => {
    seedGateTask();
    withCapture(() => runGateCmd('respond', ['g1', 'approve'], { task: 'gt', by: 'x' }));
    const res = withCapture(() => runGateCmd('respond', ['g1', 'reject'], { task: 'gt', by: 'y' }));
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('already resolved');
  });

  test('rejects an off-enum verdict (exit 1)', () => {
    seedGateTask();
    const res = withCapture(() => runGateCmd('respond', ['g1', 'maybe'], { task: 'gt' }));
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('<verdict> must be one of');
  });

  test('requires --task', () => {
    seedGateTask();
    const res = withCapture(() => runGateCmd('respond', ['g1', 'approve'], {}));
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('--task <task-id> is required');
  });

  test('unknown gate action: exit 1', () => {
    const res = withCapture(() => runGateCmd('nope', [undefined, undefined], {}));
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain("unknown gate action 'nope'");
  });
});

// ---------------------------------------------------------------------------
// task bounds (v6) — positional = [sub-action, task-id]
// ---------------------------------------------------------------------------

describe('runTaskCmd bounds', () => {
  function seedBoundsTask(id = 'bt') {
    withCapture(() => runTaskCmd('create', [undefined, undefined], { title: id, id }));
  }

  test('create --bounds round-trips into the task', () => {
    const bounds = JSON.stringify({ tools: { allow: ['Bash(go test *)'] } });
    const create = withCapture(() =>
      runTaskCmd('create', [undefined, undefined], { title: 'bt', id: 'bt', bounds }),
    );
    expect(create.exit).toBe(0);
    const task = JSON.parse(create.stdout.trim()) as { bounds: unknown };
    expect(task.bounds).toEqual({ tools: { allow: ['Bash(go test *)'] } });
  });

  test('create --bounds with malformed JSON exits 1', () => {
    const res = withCapture(() =>
      runTaskCmd('create', [undefined, undefined], { title: 'bt', id: 'bt', bounds: '{not json' }),
    );
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('not valid JSON');
  });

  test('create --bounds with unknown top-level key exits 1', () => {
    const res = withCapture(() =>
      runTaskCmd('create', [undefined, undefined], {
        title: 'bt',
        id: 'bt',
        bounds: JSON.stringify({ reads: ['oops'] }),
      }),
    );
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('unknown top-level key');
  });

  test('bounds set + show round-trip', () => {
    seedBoundsTask();
    const set = withCapture(() =>
      runTaskCmd('bounds', ['set', 'bt'], {
        bounds: JSON.stringify({ read: ['src/**'], budgets: { tokens: 1000 } }),
      }),
    );
    expect(set.exit).toBe(0);

    const show = withCapture(() => runTaskCmd('bounds', ['show', 'bt'], {}));
    expect(show.exit).toBe(0);
    const bounds = JSON.parse(show.stdout.trim()) as Record<string, unknown>;
    expect(bounds).toEqual({ read: ['src/**'], budgets: { tokens: 1000 } });
  });

  test('bounds set with empty --bounds clears the bounds', () => {
    seedBoundsTask();
    withCapture(() =>
      runTaskCmd('bounds', ['set', 'bt'], { bounds: JSON.stringify({ read: ['src/**'] }) }),
    );
    const cleared = withCapture(() => runTaskCmd('bounds', ['set', 'bt'], { bounds: '' }));
    expect(cleared.exit).toBe(0);

    const show = withCapture(() => runTaskCmd('bounds', ['show', 'bt'], {}));
    expect(show.stdout.trim()).toBe('null');
  });

  test('bounds set requires --bounds', () => {
    seedBoundsTask();
    const res = withCapture(() => runTaskCmd('bounds', ['set', 'bt'], {}));
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('--bounds <json> is required');
  });

  test('bounds set rejects an unknown top-level key', () => {
    seedBoundsTask();
    const res = withCapture(() =>
      runTaskCmd('bounds', ['set', 'bt'], { bounds: JSON.stringify({ tool: {} }) }),
    );
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('unknown top-level key');
  });

  test('bounds show on a task with no bounds prints null', () => {
    seedBoundsTask();
    const show = withCapture(() => runTaskCmd('bounds', ['show', 'bt'], {}));
    expect(show.exit).toBe(0);
    expect(show.stdout.trim()).toBe('null');
    expect(show.stderr).toContain('unbounded');
  });

  test('unknown bounds sub-action: exit 1', () => {
    seedBoundsTask();
    const res = withCapture(() => runTaskCmd('bounds', ['nope', 'bt'], {}));
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('sub-action required');
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
    expect(res.stderr).toContain('0 pending gates');
    expect(res.stderr).toContain('0 orphan runs');
  });

  test('pending gate surfaces with task + criterion id + resolution command; resolved one does not', () => {
    withCapture(() => runTaskCmd('create', [undefined, undefined], { title: 'G', id: 'g' }));
    // biome-ignore lint/suspicious/noExplicitAny: test-only store reach-in to seed a gate criterion.
    const { openScrumStore } = require('../store') as any;
    const s = openScrumStore({ override: join(workspace, '.prove', 'prove.db') });
    try {
      s.addCriterion('g', {
        id: 'gate-1',
        text: 'operator approves the design',
        verifies_by: 'gate',
        check: 'operator approves the design',
        status: 'active',
        idempotent: false,
        superseded_by: null,
        reason: null,
        inherited_from: null,
      });
    } finally {
      s.close();
    }

    const json = withCapture(() => runAlertsCmd({ workspaceRoot: workspace }));
    expect(json.exit).toBe(0);
    const payload = JSON.parse(json.stdout.trim()) as {
      pending_gates: Array<{
        task_id: string;
        criterion_id: string;
        criterion_text: string;
        resolve: string;
      }>;
    };
    expect(payload.pending_gates).toHaveLength(1);
    const gate = payload.pending_gates[0];
    expect(gate?.task_id).toBe('g');
    expect(gate?.criterion_id).toBe('gate-1');
    expect(gate?.criterion_text).toBe('operator approves the design');
    expect(gate?.resolve).toBe('scrum gate respond gate-1 approve|reject --task g');
    expect(json.stderr).toContain('1 pending gates');

    const human = withCapture(() => runAlertsCmd({ workspaceRoot: workspace, human: true }));
    expect(human.stdout).toContain('Pending gates (1)');
    expect(human.stdout).toContain('g / gate-1');
    expect(human.stdout).toContain('scrum gate respond gate-1');

    // Resolving the gate removes it from the next alerts report.
    const resolved = withCapture(() =>
      runGateCmd('respond', ['gate-1', 'approve'], { task: 'g', by: 'alice' }),
    );
    expect(resolved.exit).toBe(0);
    const after = withCapture(() => runAlertsCmd({ workspaceRoot: workspace }));
    const afterPayload = JSON.parse(after.stdout.trim()) as { pending_gates: unknown[] };
    expect(afterPayload.pending_gates).toHaveLength(0);
    expect(after.stderr).toContain('0 pending gates');
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
    s.store
      .getDb()
      .prepare('UPDATE scrum_tasks SET last_event_at = ? WHERE id = ?')
      .run(ancient, 'w');
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

  test('open escalations surface with type + age in JSON and --human', () => {
    withCapture(() => runTaskCmd('create', [undefined, undefined], { title: 'B', id: 'b' }));
    withCapture(() => runTaskCmd('status', ['b', 'ready'], {}));
    const old = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    // biome-ignore lint/suspicious/noExplicitAny: test-only store reach-in to seed an escalation event.
    const { openScrumStore } = require('../store') as any;
    const s = openScrumStore({ override: join(workspace, '.prove', 'prove.db') });
    try {
      s.appendEvent({
        taskId: 'b',
        kind: 'blocker_raised',
        payload: { escalation_type: 'conflict', summary: 'two reqs clash' },
        ts: old,
      });
    } finally {
      s.close();
    }
    const json = withCapture(() => runAlertsCmd({ workspaceRoot: workspace }));
    const payload = JSON.parse(json.stdout.trim()) as {
      stale_escalations: Array<{ id: string; escalation_type: string; escalated_days: number }>;
    };
    const e = payload.stale_escalations.find((x) => x.id === 'b');
    expect(e?.escalation_type).toBe('conflict');
    expect(e?.escalated_days).toBeGreaterThanOrEqual(4);
    expect(json.stderr).toContain('open escalations');

    const human = withCapture(() => runAlertsCmd({ workspaceRoot: workspace, human: true }));
    expect(human.stdout).toContain('Open escalations');
    expect(human.stdout).toContain('conflict');
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
      [
        '- parser: all depend on AST node type 9',
        '- see also: other doc',
        '- real backlog item',
        '',
      ].join('\n'),
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
      ['- M3 something to do later', '- M3 another thing in M3', '- no milestone here', ''].join(
        '\n',
      ),
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

// ---------------------------------------------------------------------------
// parseDecisionFile — pure extractor (no store, no I/O)
// ---------------------------------------------------------------------------

describe('parseDecisionFile', () => {
  test('extracts id from filename basename without .md', () => {
    const input = parseDecisionFile(
      '# Title\n',
      '.prove/decisions/2026-04-24-decision-persistence.md',
    );
    expect(input.id).toBe('2026-04-24-decision-persistence');
  });

  test('extracts title from the first H1', () => {
    const input = parseDecisionFile('# Use SQLite for persistence\n\n**Topic**: storage\n', 'x.md');
    expect(input.title).toBe('Use SQLite for persistence');
  });

  test('extracts **Topic** field', () => {
    const input = parseDecisionFile('# Foo\n\n**Topic**: architecture\n\nBody...', 'x.md');
    expect(input.topic).toBe('architecture');
  });

  test('extracts plain Topic: field when bold markers absent', () => {
    const input = parseDecisionFile('# Foo\n\nTopic: storage\n\nBody', 'x.md');
    expect(input.topic).toBe('storage');
  });

  test('extracts **Status** field', () => {
    const input = parseDecisionFile('# Foo\n\n**Status**: proposed\n', 'x.md');
    expect(input.status).toBe('proposed');
  });

  test('defaults status to accepted when absent', () => {
    const input = parseDecisionFile('# Foo\n', 'x.md');
    expect(input.status).toBe('accepted');
  });

  test('topic defaults to null when absent', () => {
    const input = parseDecisionFile('# Foo\n', 'x.md');
    expect(input.topic).toBeNull();
  });

  test('preserves full content byte-for-byte', () => {
    const content = '# Foo\n\nLine 1\nLine 2\n\n**Topic**: x\n';
    const input = parseDecisionFile(content, 'x.md');
    expect(input.content).toBe(content);
  });

  test('sourcePath is the input path, not resolved', () => {
    const input = parseDecisionFile('# Foo\n', '.prove/decisions/rel.md');
    expect(input.sourcePath).toBe('.prove/decisions/rel.md');
  });

  test('title falls back to id when no H1 is present', () => {
    const input = parseDecisionFile('No heading here\n', 'abc.md');
    expect(input.title).toBe('abc');
  });
});

// ---------------------------------------------------------------------------
// decision-cmd
// ---------------------------------------------------------------------------

describe('runDecisionCmd', () => {
  function writeDecision(relPath: string, body: string): string {
    const abs = join(workspace, relPath);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, body, 'utf8');
    return relPath;
  }

  test('record: happy path upserts row and prints JSON', () => {
    const rel = writeDecision(
      '.prove/decisions/2026-04-24-alpha.md',
      '# Alpha decision\n\n**Topic**: storage\n\nBody\n',
    );
    const res = withCapture(() => runDecisionCmd('record', [rel, undefined], {}));
    expect(res.exit).toBe(0);
    const row = JSON.parse(res.stdout.trim()) as {
      id: string;
      title: string;
      topic: string | null;
      status: string;
      content: string;
    };
    expect(row.id).toBe('2026-04-24-alpha');
    expect(row.title).toBe('Alpha decision');
    expect(row.topic).toBe('storage');
    expect(row.status).toBe('accepted');
    expect(res.stderr).toContain('scrum decision record: 2026-04-24-alpha');
    expect(res.stderr).toMatch(/\(\d+ bytes\)/);
  });

  test('record --kind: persists a canonical Codex subtype, case-normalized', () => {
    const rel = writeDecision('.prove/decisions/2026-06-01-kindly.md', '# Kindly\n\nBody\n');
    const res = withCapture(() => runDecisionCmd('record', [rel, undefined], { kind: 'ADR' }));
    expect(res.exit).toBe(0);
    const row = JSON.parse(res.stdout.trim()) as { id: string; kind: string | null };
    expect(row.kind).toBe('adr');
  });

  test('record --kind: unknown subtype → exit 1, no row recorded', () => {
    const rel = writeDecision('.prove/decisions/2026-06-01-bogus.md', '# Bogus\n\nBody\n');
    const res = withCapture(() => runDecisionCmd('record', [rel, undefined], { kind: 'lore' }));
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain("unknown --kind 'lore'");
    expect(res.stderr).toContain('adr, glossary, pattern');
    const list = withCapture(() => runDecisionCmd('list', [undefined, undefined], {}));
    expect(JSON.parse(list.stdout.trim()) as unknown[]).toHaveLength(0);
  });

  test('record without --kind: kind stays null', () => {
    const rel = writeDecision('.prove/decisions/2026-06-01-nokind.md', '# NoKind\n\nBody\n');
    const res = withCapture(() => runDecisionCmd('record', [rel, undefined], {}));
    expect(res.exit).toBe(0);
    expect((JSON.parse(res.stdout.trim()) as { kind: string | null }).kind).toBeNull();
  });

  test('list --kind: filters to the matching Codex subtype', () => {
    const a = writeDecision('.prove/decisions/2026-06-01-pat.md', '# Pat\n\nBody\n');
    const b = writeDecision('.prove/decisions/2026-06-01-adr.md', '# Adr\n\nBody\n');
    withCapture(() => runDecisionCmd('record', [a, undefined], { kind: 'pattern' }));
    withCapture(() => runDecisionCmd('record', [b, undefined], { kind: 'adr' }));

    const res = withCapture(() =>
      runDecisionCmd('list', [undefined, undefined], { kind: 'pattern' }),
    );
    const rows = JSON.parse(res.stdout.trim()) as Array<{ id: string; kind: string }>;
    expect(rows.map((r) => r.id)).toEqual(['2026-06-01-pat']);
  });

  test('record: nonexistent file → exit 1, no row', () => {
    const res = withCapture(() =>
      runDecisionCmd('record', ['.prove/decisions/ghost.md', undefined], {}),
    );
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain("file not found '.prove/decisions/ghost.md'");
    const list = withCapture(() => runDecisionCmd('list', [undefined, undefined], {}));
    const rows = JSON.parse(list.stdout.trim()) as unknown[];
    expect(rows).toHaveLength(0);
  });

  test('get: unknown id → exit 1', () => {
    const res = withCapture(() => runDecisionCmd('get', ['nope', undefined], {}));
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain("unknown decision 'nope'");
  });

  test('get: known id → stdout equals content byte-for-byte', () => {
    const content = '# Beta decision\n\n**Topic**: ui\n\nWhatever body text.\n';
    const rel = writeDecision('.prove/decisions/2026-04-24-beta.md', content);
    withCapture(() => runDecisionCmd('record', [rel, undefined], {}));

    const res = withCapture(() => runDecisionCmd('get', ['2026-04-24-beta', undefined], {}));
    expect(res.exit).toBe(0);
    expect(res.stdout).toBe(content);
  });

  test('list: empty workspace → empty JSON array', () => {
    const res = withCapture(() => runDecisionCmd('list', [undefined, undefined], {}));
    expect(res.exit).toBe(0);
    const rows = JSON.parse(res.stdout.trim()) as unknown[];
    expect(rows).toHaveLength(0);
    expect(res.stderr).toContain('0 decisions');
  });

  test('list: two seeded rows → JSON array of length 2', () => {
    const a = writeDecision('.prove/decisions/2026-04-24-a.md', '# A\n\n**Topic**: architecture\n');
    const b = writeDecision('.prove/decisions/2026-04-24-b.md', '# B\n\n**Topic**: ui\n');
    withCapture(() => runDecisionCmd('record', [a, undefined], {}));
    withCapture(() => runDecisionCmd('record', [b, undefined], {}));

    const res = withCapture(() => runDecisionCmd('list', [undefined, undefined], {}));
    expect(res.exit).toBe(0);
    const rows = JSON.parse(res.stdout.trim()) as Array<{ id: string }>;
    expect(rows).toHaveLength(2);
  });

  test('list --topic architecture: filters correctly', () => {
    const a = writeDecision(
      '.prove/decisions/2026-04-24-arch.md',
      '# Arch\n\n**Topic**: architecture\n',
    );
    const b = writeDecision('.prove/decisions/2026-04-24-ui.md', '# UI\n\n**Topic**: ui\n');
    withCapture(() => runDecisionCmd('record', [a, undefined], {}));
    withCapture(() => runDecisionCmd('record', [b, undefined], {}));

    const res = withCapture(() =>
      runDecisionCmd('list', [undefined, undefined], { topic: 'architecture' }),
    );
    expect(res.exit).toBe(0);
    const rows = JSON.parse(res.stdout.trim()) as Array<{ id: string; topic: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.topic).toBe('architecture');
  });

  test('list --human: emits a table header on stdout', () => {
    const rel = writeDecision('.prove/decisions/2026-04-24-h.md', '# H\n\n**Topic**: t\n');
    withCapture(() => runDecisionCmd('record', [rel, undefined], {}));

    const res = withCapture(() => runDecisionCmd('list', [undefined, undefined], { human: true }));
    expect(res.exit).toBe(0);
    expect(res.stdout).toContain('ID');
    expect(res.stdout).toContain('TITLE');
    expect(res.stdout).toContain('RECORDED_AT');
  });

  test('supersede: happy path flips old to superseded with pointer + reason', () => {
    const oldRel = writeDecision('.prove/decisions/2026-04-24-old.md', '# Old\n');
    const newRel = writeDecision('.prove/decisions/2026-04-24-new.md', '# New\n');
    withCapture(() => runDecisionCmd('record', [oldRel, undefined], {}));
    withCapture(() => runDecisionCmd('record', [newRel, undefined], {}));

    const res = withCapture(() =>
      runDecisionCmd('supersede', ['2026-04-24-old', undefined], {
        by: '2026-04-24-new',
        reason: 'better approach',
      }),
    );
    expect(res.exit).toBe(0);
    const row = JSON.parse(res.stdout.trim()) as {
      id: string;
      status: string;
      superseded_by: string | null;
      reason: string | null;
    };
    expect(row.status).toBe('superseded');
    expect(row.superseded_by).toBe('2026-04-24-new');
    expect(row.reason).toBe('better approach');

    // Append-only: the superseded row still lists.
    const list = withCapture(() => runDecisionCmd('list', [undefined, undefined], {}));
    const rows = JSON.parse(list.stdout.trim()) as Array<{ id: string }>;
    expect(rows.map((r) => r.id).sort()).toEqual(['2026-04-24-new', '2026-04-24-old']);
  });

  test('supersede: missing --by → exit 1', () => {
    const rel = writeDecision('.prove/decisions/2026-04-24-x.md', '# X\n');
    withCapture(() => runDecisionCmd('record', [rel, undefined], {}));
    const res = withCapture(() =>
      runDecisionCmd('supersede', ['2026-04-24-x', undefined], { reason: 'why' }),
    );
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('--by <new-id> is required');
  });

  test('supersede: missing --reason → exit 1', () => {
    const rel = writeDecision('.prove/decisions/2026-04-24-y.md', '# Y\n');
    withCapture(() => runDecisionCmd('record', [rel, undefined], {}));
    const res = withCapture(() =>
      runDecisionCmd('supersede', ['2026-04-24-y', undefined], { by: '2026-04-24-y' }),
    );
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('--reason <text> is required');
  });

  test('supersede: unknown replacement → exit 1', () => {
    const rel = writeDecision('.prove/decisions/2026-04-24-z.md', '# Z\n');
    withCapture(() => runDecisionCmd('record', [rel, undefined], {}));
    const res = withCapture(() =>
      runDecisionCmd('supersede', ['2026-04-24-z', undefined], { by: 'ghost', reason: 'why' }),
    );
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain("unknown replacement decision 'ghost'");
  });

  test('unknown action → exit 1', () => {
    const res = withCapture(() => runDecisionCmd('bogus', [undefined, undefined], {}));
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain("unknown decision action 'bogus'");
  });

  // -------------------------------------------------------------------------
  // review-stale (v7)
  // -------------------------------------------------------------------------

  /** Record a decision then backdate its `recorded_at` to `daysAgo` days old. */
  function recordStale(id: string, daysAgo: number): void {
    const rel = writeDecision(`.prove/decisions/${id}.md`, `# ${id}\n`);
    withCapture(() => runDecisionCmd('record', [rel, undefined], {}));
    // biome-ignore lint/suspicious/noExplicitAny: test-only store reach-in to backdate.
    const { openScrumStore } = require('../store') as any;
    const s = openScrumStore({ override: join(workspace, '.prove', 'prove.db') });
    try {
      const old = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
      s.getStore()
        .getDb()
        .prepare('UPDATE scrum_decisions SET recorded_at = ? WHERE id = ?')
        .run(old, id);
    } finally {
      s.close();
    }
  }

  test('review-stale flags decisions older than the threshold, oldest-first', () => {
    recordStale('old-1', 200);
    recordStale('old-2', 120);
    recordStale('fresh', 5);

    const res = withCapture(() => runDecisionCmd('review-stale', [undefined, undefined], {}));
    expect(res.exit).toBe(0);
    const rows = JSON.parse(res.stdout.trim()) as Array<{ id: string; age_days: number }>;
    expect(rows.map((r) => r.id)).toEqual(['old-1', 'old-2']);
    expect(rows[0]?.age_days).toBeGreaterThanOrEqual(rows[1]?.age_days ?? 0);
  });

  test('review-stale honors a custom --days threshold and mutates nothing', () => {
    recordStale('d', 30);
    const flagged = withCapture(() =>
      runDecisionCmd('review-stale', [undefined, undefined], { days: 20 }),
    );
    expect((JSON.parse(flagged.stdout.trim()) as unknown[]).length).toBe(1);

    const none = withCapture(() =>
      runDecisionCmd('review-stale', [undefined, undefined], { days: 60 }),
    );
    expect((JSON.parse(none.stdout.trim()) as unknown[]).length).toBe(0);

    // Report-only: the decision is untouched (still listed, still accepted).
    const list = withCapture(() => runDecisionCmd('list', [undefined, undefined], {}));
    const rows = JSON.parse(list.stdout.trim()) as Array<{ id: string; status: string }>;
    expect(rows.find((r) => r.id === 'd')?.status).toBe('accepted');
  });

  test('review-stale excludes superseded decisions', () => {
    recordStale('keep', 200);
    recordStale('gone', 200);
    withCapture(() =>
      runDecisionCmd('supersede', ['gone', undefined], { by: 'keep', reason: 'merged' }),
    );
    const res = withCapture(() => runDecisionCmd('review-stale', [undefined, undefined], {}));
    const rows = JSON.parse(res.stdout.trim()) as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual(['keep']);
  });

  test('review-stale rejects a non-positive --days with exit 1', () => {
    const res = withCapture(() =>
      runDecisionCmd('review-stale', [undefined, undefined], { days: 0 }),
    );
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('--days must be a positive integer');
  });
});

// ---------------------------------------------------------------------------
// task link-decision — auto-record + new-shape payload
// ---------------------------------------------------------------------------

describe('runTaskCmd link-decision (auto-record)', () => {
  test('auto-records decision when absent, payload carries decision_id + decision_path', () => {
    // Seed a task and an on-disk decision file.
    withCapture(() => runTaskCmd('create', [undefined, undefined], { title: 'T', id: 't' }));
    const rel = '.prove/decisions/2026-04-24-auto.md';
    mkdirSync(join(workspace, '.prove', 'decisions'), { recursive: true });
    writeFileSync(join(workspace, rel), '# Auto-recorded decision\n\n**Topic**: storage\n', 'utf8');

    const res = withCapture(() => runTaskCmd('link-decision', ['t', rel], {}));
    expect(res.exit).toBe(0);
    const payload = JSON.parse(res.stdout.trim()) as {
      linked: boolean;
      task_id: string;
      decision_id: string;
      decision_path: string;
    };
    expect(payload.linked).toBe(true);
    expect(payload.decision_id).toBe('2026-04-24-auto');
    expect(payload.decision_path).toBe(rel);

    // Decision row was upserted by the link step.
    const get = withCapture(() => runDecisionCmd('get', ['2026-04-24-auto', undefined], {}));
    expect(get.exit).toBe(0);
    expect(get.stdout).toContain('Auto-recorded decision');
  });

  test('nonexistent file → exit 1, no event appended', () => {
    withCapture(() => runTaskCmd('create', [undefined, undefined], { title: 'Z', id: 'z2' }));

    const res = withCapture(() =>
      runTaskCmd('link-decision', ['z2', '.prove/decisions/ghost.md'], {}),
    );
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain("file not found '.prove/decisions/ghost.md'");

    // No decision_linked event was appended.
    const show = withCapture(() => runTaskCmd('show', ['z2', undefined], {}));
    const payload = JSON.parse(show.stdout.trim()) as { events: Array<{ kind: string }> };
    expect(payload.events.some((e) => e.kind === 'decision_linked')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// decision recover --from-git — backfill from git history
// ---------------------------------------------------------------------------

describe('runDecisionCmd recover', () => {
  /**
   * The harness's default `workspace` only has a `.git` directory shell
   * (enough for `mainWorktreeRoot`), not a real repo. The recover path
   * needs an actual repo with commit history, so each test below creates
   * its own isolated tempdir inside the per-test `workspace` and runs the
   * handler with `--workspace-root` pointed at it.
   */

  function initRepo(dir: string): void {
    // `git init` writes .git/ into `dir`. -q suppresses the banner.
    const init = spawnSync('git', ['-C', dir, 'init', '-q', '-b', 'main'], { encoding: 'utf8' });
    expect(init.status).toBe(0);
    // Local identity so commits succeed without user-global git config.
    spawnSync('git', ['-C', dir, 'config', 'user.email', 'test@example.com'], {
      encoding: 'utf8',
    });
    spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test User'], { encoding: 'utf8' });
  }

  function commitFile(dir: string, relPath: string, content: string, message: string): void {
    const abs = join(dir, relPath);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content, 'utf8');
    const add = spawnSync('git', ['-C', dir, 'add', relPath], { encoding: 'utf8' });
    expect(add.status).toBe(0);
    const commit = spawnSync('git', ['-C', dir, 'commit', '-q', '-m', message], {
      encoding: 'utf8',
    });
    expect(commit.status).toBe(0);
  }

  test('missing --from-git → exit 1 with flag-usage hint', () => {
    // Note: we intentionally do NOT construct a real repo here — the flag
    // check must short-circuit before any git command runs.
    const res = withCapture(() =>
      runDecisionCmd('recover', [undefined, undefined], { workspaceRoot: workspace }),
    );
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('--from-git');
  });

  test('non-repo workspace → exit 1, no DB writes', () => {
    // `workspace` has only a `.git` dir shell; `git rev-parse
    // --is-inside-work-tree` rejects it because it's not a real repo.
    const nonRepo = mkdtempSync(join(tmpdir(), 'scrum-recover-nonrepo-'));
    try {
      const res = withCapture(() =>
        runDecisionCmd('recover', [undefined, undefined], {
          workspaceRoot: nonRepo,
          fromGit: true,
        }),
      );
      expect(res.exit).toBe(1);
      expect(res.stderr).toContain('not a git repository');
      // list against the tmpdir's own prove.db should be empty.
      const list = withCapture(() =>
        runDecisionCmd('list', [undefined, undefined], { workspaceRoot: nonRepo }),
      );
      const rows = JSON.parse(list.stdout.trim()) as unknown[];
      expect(rows).toHaveLength(0);
    } finally {
      rmSync(nonRepo, { recursive: true, force: true });
    }
  });

  test('empty repo (no ADR commits) → exit 0, recovered=0, no DB writes', () => {
    const repo = mkdtempSync(join(tmpdir(), 'scrum-recover-empty-'));
    try {
      initRepo(repo);
      // One commit that touches something other than decisions/ so git log
      // has at least one commit to walk.
      commitFile(repo, 'README.md', '# Not a decision\n', 'chore: init');

      const res = withCapture(() =>
        runDecisionCmd('recover', [undefined, undefined], {
          workspaceRoot: repo,
          fromGit: true,
        }),
      );
      expect(res.exit).toBe(0);
      const payload = JSON.parse(res.stdout.trim()) as { recovered: number; ids: string[] };
      expect(payload.recovered).toBe(0);
      expect(payload.ids).toEqual([]);
      expect(res.stderr).toContain('recovered 0 decisions');

      const list = withCapture(() =>
        runDecisionCmd('list', [undefined, undefined], { workspaceRoot: repo }),
      );
      const rows = JSON.parse(list.stdout.trim()) as unknown[];
      expect(rows).toHaveLength(0);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('happy path: v1 then v2 at same path → v2 content wins on id collision', () => {
    const repo = mkdtempSync(join(tmpdir(), 'scrum-recover-happy-'));
    try {
      initRepo(repo);
      const relPath = '.prove/decisions/2026-04-24-choice.md';

      commitFile(
        repo,
        relPath,
        '# V1 title\n\n**Topic**: storage\n\nFirst revision body.\n',
        'docs(adr): v1',
      );
      commitFile(
        repo,
        relPath,
        '# V2 title\n\n**Topic**: architecture\n\nSecond revision body.\n',
        'docs(adr): v2',
      );

      const res = withCapture(() =>
        runDecisionCmd('recover', [undefined, undefined], {
          workspaceRoot: repo,
          fromGit: true,
        }),
      );
      expect(res.exit).toBe(0);
      const payload = JSON.parse(res.stdout.trim()) as { recovered: number; ids: string[] };
      expect(payload.recovered).toBe(1);
      expect(payload.ids).toEqual(['2026-04-24-choice']);

      // Later commit wins: title, topic, and body all reflect v2.
      const get = withCapture(() =>
        runDecisionCmd('get', ['2026-04-24-choice', undefined], { workspaceRoot: repo }),
      );
      expect(get.exit).toBe(0);
      expect(get.stdout).toContain('V2 title');
      expect(get.stdout).toContain('Second revision body');
      expect(get.stdout).not.toContain('First revision body');

      const list = withCapture(() =>
        runDecisionCmd('list', [undefined, undefined], { workspaceRoot: repo }),
      );
      const rows = JSON.parse(list.stdout.trim()) as Array<{
        id: string;
        title: string;
        topic: string | null;
      }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.title).toBe('V2 title');
      expect(rows[0]?.topic).toBe('architecture');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('second run is a clean no-op: list length unchanged, v2 content preserved', () => {
    const repo = mkdtempSync(join(tmpdir(), 'scrum-recover-idempotent-'));
    try {
      initRepo(repo);
      const relPath = '.prove/decisions/2026-04-24-idem.md';
      commitFile(repo, relPath, '# V1\n\nBody v1.\n', 'docs(adr): v1');
      commitFile(repo, relPath, '# V2\n\nBody v2.\n', 'docs(adr): v2');

      const first = withCapture(() =>
        runDecisionCmd('recover', [undefined, undefined], {
          workspaceRoot: repo,
          fromGit: true,
        }),
      );
      expect(first.exit).toBe(0);

      const second = withCapture(() =>
        runDecisionCmd('recover', [undefined, undefined], {
          workspaceRoot: repo,
          fromGit: true,
        }),
      );
      expect(second.exit).toBe(0);

      // Upsert semantics: two runs do NOT duplicate rows.
      const list = withCapture(() =>
        runDecisionCmd('list', [undefined, undefined], { workspaceRoot: repo }),
      );
      const rows = JSON.parse(list.stdout.trim()) as Array<{ id: string; title: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.title).toBe('V2');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// runContributorCmd
// ---------------------------------------------------------------------------

interface ContributorRow {
  id: string;
  slug: string;
  status: string;
  display_name: string | null;
  github: string | null;
  email: string | null;
}

describe('runContributorCmd', () => {
  test('register mints a CT-UUID, prints the row, and scaffolds contributors/<slug>.md', () => {
    const res = withCapture(() =>
      runContributorCmd('register', {
        slug: 'jane-doe',
        displayName: 'Jane Doe',
        github: 'janedoe',
        email: 'jane@example.com',
        workspaceRoot: workspace,
      }),
    );
    expect(res.exit).toBe(0);
    const row = JSON.parse(res.stdout.trim()) as ContributorRow;
    expect(row.id).toMatch(/^ct-jane-doe-/);
    expect(row.slug).toBe('jane-doe');
    expect(row.github).toBe('janedoe');

    // The on-disk identity artifact mirrors the row in its frontmatter.
    const artifact = join(workspace, 'contributors', 'jane-doe.md');
    expect(existsSync(artifact)).toBe(true);
    const content = readFileSync(artifact, 'utf8');
    expect(content).toContain('schema_version: 1');
    expect(content).toContain('contributor:');
    expect(content).toContain(`id: ${row.id}`);
    expect(content).toContain('github: janedoe');
  });

  test('register without --slug exits 1', () => {
    const res = withCapture(() => runContributorCmd('register', { workspaceRoot: workspace }));
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('--slug');
  });

  test('register rejects an off-vocabulary --status', () => {
    const res = withCapture(() =>
      runContributorCmd('register', { slug: 'jane', status: 'retired', workspaceRoot: workspace }),
    );
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('unknown --status');
  });

  test('list returns the registered contributors as JSON', () => {
    withCapture(() => runContributorCmd('register', { slug: 'amy', workspaceRoot: workspace }));
    withCapture(() => runContributorCmd('register', { slug: 'zed', workspaceRoot: workspace }));
    const res = withCapture(() => runContributorCmd('list', { workspaceRoot: workspace }));
    expect(res.exit).toBe(0);
    const rows = JSON.parse(res.stdout.trim()) as ContributorRow[];
    expect(rows.map((r) => r.slug)).toEqual(['amy', 'zed']);
  });

  test('resolve matches by github first, then email', () => {
    const reg = withCapture(() =>
      runContributorCmd('register', {
        slug: 'jane',
        github: 'janedoe',
        email: 'jane@example.com',
        workspaceRoot: workspace,
      }),
    );
    const id = (JSON.parse(reg.stdout.trim()) as ContributorRow).id;

    const byGithub = withCapture(() =>
      runContributorCmd('resolve', { github: 'JaneDoe', workspaceRoot: workspace }),
    );
    expect(byGithub.exit).toBe(0);
    expect((JSON.parse(byGithub.stdout.trim()) as ContributorRow).id).toBe(id);
    expect(byGithub.stderr).toContain('via github');

    const byEmail = withCapture(() =>
      runContributorCmd('resolve', {
        github: 'nobody',
        email: 'jane@example.com',
        workspaceRoot: workspace,
      }),
    );
    expect(byEmail.exit).toBe(0);
    expect((JSON.parse(byEmail.stdout.trim()) as ContributorRow).id).toBe(id);
    expect(byEmail.stderr).toContain('via email');
  });

  test('resolve miss exits 1 with null on stdout', () => {
    withCapture(() =>
      runContributorCmd('register', {
        slug: 'jane',
        github: 'janedoe',
        workspaceRoot: workspace,
      }),
    );
    const res = withCapture(() =>
      runContributorCmd('resolve', {
        github: 'ghost',
        email: 'ghost@x.com',
        workspaceRoot: workspace,
      }),
    );
    expect(res.exit).toBe(1);
    expect(res.stdout.trim()).toBe('null');
    expect(res.stderr).toContain('no match');
  });

  test('resolve without --github or --email exits 1', () => {
    const res = withCapture(() => runContributorCmd('resolve', { workspaceRoot: workspace }));
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('at least one of --github or --email');
  });

  test('unknown sub-action exits 1', () => {
    const res = withCapture(() => runContributorCmd('frobnicate', { workspaceRoot: workspace }));
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('unknown contributor action');
  });

  // `default <set|show>` is store-independent: it reads/writes the home-dir
  // config, never `.prove/prove.db`. Every test pins `configBase` to a tmp dir
  // (the workspace) so the developer's real ~/.config is never touched.
  describe('default <set|show>', () => {
    test('set then show round-trips the mapped CT-UUID', () => {
      const setRes = withCapture(() =>
        runContributorCmd(
          'default',
          { projectRoot: workspace, id: 'ct-jane-doe-abc', configBase: workspace },
          'set',
        ),
      );
      expect(setRes.exit).toBe(0);

      const showRes = withCapture(() =>
        runContributorCmd('default', { projectRoot: workspace, configBase: workspace }, 'show'),
      );
      expect(showRes.exit).toBe(0);
      expect(JSON.parse(showRes.stdout.trim())).toBe('ct-jane-doe-abc');
    });

    test('show on an unmapped root prints null, exit 0', () => {
      const res = withCapture(() =>
        runContributorCmd(
          'default',
          { projectRoot: join(workspace, 'unmapped'), configBase: workspace },
          'show',
        ),
      );
      expect(res.exit).toBe(0);
      expect(res.stdout.trim()).toBe('null');
    });

    test('set without --id exits 1', () => {
      const res = withCapture(() =>
        runContributorCmd('default', { projectRoot: workspace, configBase: workspace }, 'set'),
      );
      expect(res.exit).toBe(1);
      expect(res.stderr).toContain('--id');
    });

    test('missing sub-action exits 1', () => {
      const res = withCapture(() =>
        runContributorCmd('default', { configBase: workspace }, undefined),
      );
      expect(res.exit).toBe(1);
      expect(res.stderr).toContain('sub-action required');
    });
  });
});

// ---------------------------------------------------------------------------
// runOperatorCmd — operator-of-record set / resolve / history
// ---------------------------------------------------------------------------

interface OperatorRow {
  id: number;
  contributor_id: string;
  from_ts: string;
  to_ts: string | null;
}

/** Register a contributor through the CLI and return its minted CT-UUID. */
function registerContributorCli(slug: string): string {
  const reg = withCapture(() => runContributorCmd('register', { slug, workspaceRoot: workspace }));
  return (JSON.parse(reg.stdout.trim()) as ContributorRow).id;
}

describe('runOperatorCmd', () => {
  test('set appends an open interval and syncs charter.md operator_of_record', () => {
    const jane = registerContributorCli('jane');
    // A scaffolded charter carrying the null operator_of_record field.
    writeFileSync(
      join(workspace, 'charter.md'),
      '---\nschema_version: 1\noperator_of_record: null\n---\n\n# Project Charter\n',
      'utf8',
    );

    const res = withCapture(() =>
      runOperatorCmd('set', {
        contributor: jane,
        fromTs: '2026-01-01T00:00:00Z',
        workspaceRoot: workspace,
      }),
    );
    expect(res.exit).toBe(0);
    const row = JSON.parse(res.stdout.trim()) as OperatorRow;
    expect(row.contributor_id).toBe(jane);
    expect(row.to_ts).toBeNull();

    // The charter frontmatter now mirrors the current holder.
    const charter = readFileSync(join(workspace, 'charter.md'), 'utf8');
    expect(charter).toContain(`operator_of_record: ${jane}`);
    expect(charter).not.toContain('operator_of_record: null');
  });

  test('set without --contributor exits 1', () => {
    const res = withCapture(() => runOperatorCmd('set', { workspaceRoot: workspace }));
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('--contributor');
  });

  test('set with an unknown contributor exits 1', () => {
    const res = withCapture(() =>
      runOperatorCmd('set', { contributor: 'ct-ghost', workspaceRoot: workspace }),
    );
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('unknown contributor');
  });

  test('resolve returns the point-in-time holder, not the current one', () => {
    const jane = registerContributorCli('jane');
    const bob = registerContributorCli('bob');
    withCapture(() =>
      runOperatorCmd('set', {
        contributor: jane,
        fromTs: '2026-01-01T00:00:00Z',
        workspaceRoot: workspace,
      }),
    );
    withCapture(() =>
      runOperatorCmd('set', {
        contributor: bob,
        fromTs: '2026-03-01T00:00:00Z',
        workspaceRoot: workspace,
      }),
    );

    // Before the handoff → Jane (the historical holder), even though Bob is current.
    const past = withCapture(() =>
      runOperatorCmd('resolve', { at: '2026-02-01T00:00:00Z', workspaceRoot: workspace }),
    );
    expect(past.exit).toBe(0);
    expect((JSON.parse(past.stdout.trim()) as ContributorRow).id).toBe(jane);

    // After the handoff → Bob.
    const present = withCapture(() =>
      runOperatorCmd('resolve', { at: '2026-04-01T00:00:00Z', workspaceRoot: workspace }),
    );
    expect((JSON.parse(present.stdout.trim()) as ContributorRow).id).toBe(bob);
  });

  test('resolve before any holder exits 1 with null on stdout', () => {
    const res = withCapture(() =>
      runOperatorCmd('resolve', { at: '2026-01-01T00:00:00Z', workspaceRoot: workspace }),
    );
    expect(res.exit).toBe(1);
    expect(res.stdout.trim()).toBe('null');
    expect(res.stderr).toContain('no holder in effect');
  });

  test('history lists intervals oldest-first', () => {
    const jane = registerContributorCli('jane');
    const bob = registerContributorCli('bob');
    withCapture(() =>
      runOperatorCmd('set', {
        contributor: jane,
        fromTs: '2026-01-01T00:00:00Z',
        workspaceRoot: workspace,
      }),
    );
    withCapture(() =>
      runOperatorCmd('set', {
        contributor: bob,
        fromTs: '2026-03-01T00:00:00Z',
        workspaceRoot: workspace,
      }),
    );
    const res = withCapture(() => runOperatorCmd('history', { workspaceRoot: workspace }));
    expect(res.exit).toBe(0);
    const rows = JSON.parse(res.stdout.trim()) as OperatorRow[];
    expect(rows.map((r) => r.contributor_id)).toEqual([jane, bob]);
    expect(rows[0]?.to_ts).toBe('2026-03-01T00:00:00Z');
    expect(rows[1]?.to_ts).toBeNull();
  });

  test('unknown sub-action exits 1', () => {
    const res = withCapture(() => runOperatorCmd('frobnicate', { workspaceRoot: workspace }));
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('unknown operator action');
  });
});

// ---------------------------------------------------------------------------
// runTeamCmd — team registry create / show / list
// ---------------------------------------------------------------------------

interface TeamRow {
  slug: string;
  team_type: string;
  charter: string | null;
  lifetime: string;
  created_at: string;
}

describe('runTeamCmd', () => {
  test('create inserts the row, prints JSON, and scaffolds teams/<slug>.md', () => {
    const res = withCapture(() =>
      runTeamCmd('create', [undefined], {
        slug: 'payments',
        teamType: 'stream_aligned',
        charter: 'Own the checkout flow',
        workspaceRoot: workspace,
      }),
    );
    expect(res.exit).toBe(0);
    const row = JSON.parse(res.stdout.trim()) as TeamRow;
    expect(row.slug).toBe('payments');
    expect(row.team_type).toBe('stream_aligned');
    expect(row.lifetime).toBe('persistent');
    expect(row.charter).toBe('Own the checkout flow');

    const artifact = join(workspace, 'teams', 'payments.md');
    expect(existsSync(artifact)).toBe(true);
    const content = readFileSync(artifact, 'utf8');
    expect(content).toContain('schema_version: 14');
    expect(content).toContain('team:');
    expect(content).toContain('slug: payments');
    expect(content).toContain('team_type: stream_aligned');
    expect(content).toContain('lifetime: persistent');
  });

  test('create honors an explicit --lifetime', () => {
    const res = withCapture(() =>
      runTeamCmd('create', [undefined], {
        slug: 'migration-squad',
        teamType: 'enabling',
        lifetime: 'terminates_on_milestone',
        workspaceRoot: workspace,
      }),
    );
    expect(res.exit).toBe(0);
    expect((JSON.parse(res.stdout.trim()) as TeamRow).lifetime).toBe('terminates_on_milestone');
  });

  test('create without --slug exits 1', () => {
    const res = withCapture(() =>
      runTeamCmd('create', [undefined], { teamType: 'platform', workspaceRoot: workspace }),
    );
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('--slug');
  });

  test('create without --team-type exits 1', () => {
    const res = withCapture(() =>
      runTeamCmd('create', [undefined], { slug: 'orphan', workspaceRoot: workspace }),
    );
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('--team-type');
  });

  test('create rejects an off-vocabulary --team-type', () => {
    const res = withCapture(() =>
      runTeamCmd('create', [undefined], {
        slug: 'rogue',
        teamType: 'wildcat',
        workspaceRoot: workspace,
      }),
    );
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('unknown --team-type');
  });

  test('create rejects an off-vocabulary --lifetime', () => {
    const res = withCapture(() =>
      runTeamCmd('create', [undefined], {
        slug: 'rogue',
        teamType: 'platform',
        lifetime: 'forever',
        workspaceRoot: workspace,
      }),
    );
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('unknown --lifetime');
  });

  test('show returns the JSON row, exit 0', () => {
    withCapture(() =>
      runTeamCmd('create', [undefined], {
        slug: 'payments',
        teamType: 'stream_aligned',
        workspaceRoot: workspace,
      }),
    );
    const res = withCapture(() => runTeamCmd('show', ['payments'], { workspaceRoot: workspace }));
    expect(res.exit).toBe(0);
    expect((JSON.parse(res.stdout.trim()) as TeamRow).slug).toBe('payments');
  });

  test('show on an unknown slug exits 1 with null on stdout', () => {
    const res = withCapture(() => runTeamCmd('show', ['ghost'], { workspaceRoot: workspace }));
    expect(res.exit).toBe(1);
    expect(res.stdout.trim()).toBe('null');
    expect(res.stderr).toContain("no team 'ghost'");
  });

  test('list returns the registered teams as JSON, ordered by slug', () => {
    withCapture(() =>
      runTeamCmd('create', [undefined], {
        slug: 'zeta',
        teamType: 'platform',
        workspaceRoot: workspace,
      }),
    );
    withCapture(() =>
      runTeamCmd('create', [undefined], {
        slug: 'alpha',
        teamType: 'enabling',
        workspaceRoot: workspace,
      }),
    );
    const res = withCapture(() => runTeamCmd('list', [undefined], { workspaceRoot: workspace }));
    expect(res.exit).toBe(0);
    const rows = JSON.parse(res.stdout.trim()) as TeamRow[];
    expect(rows.map((r) => r.slug)).toEqual(['alpha', 'zeta']);
  });

  test('unknown sub-action exits 1', () => {
    const res = withCapture(() =>
      runTeamCmd('frobnicate', [undefined], { workspaceRoot: workspace }),
    );
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('unknown team action');
  });
});
