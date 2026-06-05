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
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MACHINE_CONFIG_DIR_ENV_VAR } from '@claude-prove/store';

import { appendEntry } from '../../acb/reasoning-log-store';
import { runAlertsCmd } from './alerts-cmd';
import { runAnnotationCmd } from './annotation-cmd';
import { runAskCmd } from './ask-cmd';
import { runContributorCmd } from './contributor-cmd';
import { parseDecisionFile, runDecisionCmd } from './decision-cmd';
import { runEscalationCmd } from './escalation-cmd';
import { runGateCmd } from './gate-cmd';
import { runHookCmd } from './hook-cmd';
import { runInitCmd } from './init-cmd';
import { runLinkRunCmd } from './link-run-cmd';
import { runLoreCmd } from './lore-cmd';
import { runManifestCmd } from './manifest-cmd';
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
      expect(shown.task.provenance.schema_version).toBe(26);
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

  test('status: accepts the proposed/accepted decomposition-review states', () => {
    withCapture(() => runTaskCmd('create', [undefined, undefined], { title: 'R', id: 'r' }));
    expect(withCapture(() => runTaskCmd('status', ['r', 'proposed'], {})).exit).toBe(0);
    const accepted = withCapture(() => runTaskCmd('status', ['r', 'accepted'], {}));
    expect(accepted.exit).toBe(0);
    expect((JSON.parse(accepted.stdout.trim()) as { status: string }).status).toBe('accepted');
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

  function readCriteria(taskId = 'at') {
    const list = withCapture(() => runTaskCmd('acceptance', ['list', taskId], {}));
    return JSON.parse(list.stdout.trim()) as Array<{
      id: string;
      verification?: { verdict: string; reason?: string; verified_by?: string };
    }>;
  }

  test('verify --criterion stamps one recorded verdict the close floor reads', () => {
    seedAcTask();
    withCapture(() =>
      runTaskCmd('acceptance', ['add', 'at'], {
        text: 'reviewer confirms',
        verifiesBy: 'agent',
        check: 'judge it',
        criterion: 'c1',
      }),
    );
    const res = withCapture(() =>
      runTaskCmd('acceptance', ['verify', 'at'], {
        verdict: 'verified',
        criterion: 'c1',
        by: 'alice',
      }),
    );
    expect(res.exit).toBe(0);
    const v = readCriteria().find((c) => c.id === 'c1')?.verification;
    expect(v?.verdict).toBe('verified');
    expect(v?.verified_by).toBe('alice');
  });

  test('verify without --criterion stamps every applicable non-gate criterion', () => {
    seedAcTask();
    withCapture(() =>
      runTaskCmd('acceptance', ['add', 'at'], {
        text: 'a',
        verifiesBy: 'agent',
        check: 'x',
        criterion: 'c1',
      }),
    );
    withCapture(() =>
      runTaskCmd('acceptance', ['add', 'at'], {
        text: 'b',
        verifiesBy: 'bash',
        check: 'true',
        criterion: 'c2',
      }),
    );
    const res = withCapture(() =>
      runTaskCmd('acceptance', ['verify', 'at'], { verdict: 'verified' }),
    );
    expect(res.exit).toBe(0);
    expect(res.stderr).toContain('c1, c2');
    expect(readCriteria().every((c) => c.verification?.verdict === 'verified')).toBe(true);
  });

  test('verify failed records a failed verdict with --reason', () => {
    seedAcTask();
    withCapture(() =>
      runTaskCmd('acceptance', ['add', 'at'], {
        text: 'a',
        verifiesBy: 'agent',
        check: 'x',
        criterion: 'c1',
      }),
    );
    const res = withCapture(() =>
      runTaskCmd('acceptance', ['verify', 'at'], {
        verdict: 'failed',
        criterion: 'c1',
        reason: 'regression found',
      }),
    );
    expect(res.exit).toBe(0);
    const v = readCriteria().find((c) => c.id === 'c1')?.verification;
    expect(v?.verdict).toBe('failed');
    expect(v?.reason).toBe('regression found');
  });

  test('verify rejects an invalid --verdict', () => {
    seedAcTask();
    const res = withCapture(() => runTaskCmd('acceptance', ['verify', 'at'], { verdict: 'maybe' }));
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('--verdict must be one of');
  });

  test('verify on a gate criterion is rejected (verdict lives in gate.verdict)', () => {
    seedAcTask();
    withCapture(() =>
      runTaskCmd('acceptance', ['add', 'at'], {
        text: 'operator approves',
        verifiesBy: 'gate',
        check: 'approve',
        criterion: 'g1',
      }),
    );
    const res = withCapture(() =>
      runTaskCmd('acceptance', ['verify', 'at'], { verdict: 'verified', criterion: 'g1' }),
    );
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('is a gate');
  });

  test('verify with no applicable non-gate criterion exits 1 with guidance', () => {
    seedAcTask();
    withCapture(() =>
      runTaskCmd('acceptance', ['add', 'at'], {
        text: 'operator approves',
        verifiesBy: 'gate',
        check: 'approve',
        criterion: 'g1',
      }),
    );
    const res = withCapture(() =>
      runTaskCmd('acceptance', ['verify', 'at'], { verdict: 'verified' }),
    );
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('no active non-gate criterion');
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

  test('an auto-bubbled escalation surfaces in alerts via the blocker_raised bridge', () => {
    withCapture(() => runTaskCmd('create', [undefined, undefined], { title: 'AB', id: 'ab' }));
    withCapture(() => runTaskCmd('status', ['ab', 'ready'], {}));
    // biome-ignore lint/suspicious/noExplicitAny: test-only store reach-in to seed + bubble an escalation.
    const { openScrumStore } = require('../store') as any;
    const s = openScrumStore({ override: join(workspace, '.prove', 'prove.db') });
    try {
      const raised = s.raiseEscalation({
        taskId: 'ab',
        escalationType: 'blocked',
        summary: 'aged out, no receiver',
        createdAt: '2026-01-01T00:00:00Z',
      });
      // Staleness floor promotes it one rung; this emits a blocker_raised event.
      s.autoBubbleEscalation(raised.id, '2026-06-01T00:00:00Z');
    } finally {
      s.close();
    }

    const json = withCapture(() => runAlertsCmd({ workspaceRoot: workspace }));
    const payload = JSON.parse(json.stdout.trim()) as {
      stale_escalations: Array<{ id: string; escalation_type: string }>;
    };
    const e = payload.stale_escalations.find((x) => x.id === 'ab');
    expect(e?.escalation_type).toBe('blocked');
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
// decision approve / reject — gated Codex write protocol (v21)
// ---------------------------------------------------------------------------

describe('runDecisionCmd approve / reject (gated write)', () => {
  /** Write a decision file and record it under `kind`. Returns the decision id. */
  function recordKind(id: string, kind: string): string {
    const rel = join('.prove', 'decisions', `${id}.md`);
    mkdirSync(join(workspace, '.prove', 'decisions'), { recursive: true });
    writeFileSync(join(workspace, rel), `# ${id}\n\nBody\n`, 'utf8');
    withCapture(() => runDecisionCmd('record', [rel, undefined], { kind }));
    return id;
  }

  test('record of a gated kind reports a draft on stderr', () => {
    const rel = join('.prove', 'decisions', 'draft-adr.md');
    mkdirSync(join(workspace, '.prove', 'decisions'), { recursive: true });
    writeFileSync(join(workspace, rel), '# draft-adr\n\nBody\n', 'utf8');
    const res = withCapture(() => runDecisionCmd('record', [rel, undefined], { kind: 'adr' }));
    expect(res.exit).toBe(0);
    const row = JSON.parse(res.stdout.trim()) as { status: string; write_status: string };
    expect(row.status).toBe('draft');
    expect(row.write_status).toBe('draft');
    expect(res.stderr).toContain('draft — awaiting approve');
  });

  test('approve accepts an adr draft (human gate, any responder)', () => {
    recordKind('a1', 'adr');
    const res = withCapture(() =>
      runDecisionCmd('approve', ['a1', undefined], { by: 'ct-anyone' }),
    );
    expect(res.exit).toBe(0);
    const row = JSON.parse(res.stdout.trim()) as { status: string; write_status: string };
    expect(row.status).toBe('accepted');
    expect(row.write_status).toBe('approved');
    expect(res.stderr).toContain('-> accepted (by ct-anyone)');
  });

  test('approve of a glossary requires a tech_lead responder', () => {
    withCapture(() =>
      runTeamCmd('create', [undefined], { slug: 'payments', teamType: 'stream_aligned' }),
    );
    withCapture(() =>
      runTeamCmd('rotate', ['payments'], { role: 'tech_lead', contributor: 'ct-lead' }),
    );
    recordKind('g1', 'glossary');

    // A non-tech_lead responder is rejected (exit 1, no acceptance).
    const denied = withCapture(() =>
      runDecisionCmd('approve', ['g1', undefined], { by: 'ct-eng' }),
    );
    expect(denied.exit).toBe(1);
    expect(denied.stderr).toContain('requires a tech_lead review');

    // The tech_lead approves successfully.
    const ok = withCapture(() => runDecisionCmd('approve', ['g1', undefined], { by: 'ct-lead' }));
    expect(ok.exit).toBe(0);
    expect((JSON.parse(ok.stdout.trim()) as { status: string }).status).toBe('accepted');
  });

  test('reject blocks a gated draft and records the reason', () => {
    recordKind('p1', 'pattern');
    const res = withCapture(() =>
      runDecisionCmd('reject', ['p1', undefined], { by: 'ct-rev', reason: 'duplicate' }),
    );
    expect(res.exit).toBe(0);
    const row = JSON.parse(res.stdout.trim()) as {
      status: string;
      write_status: string;
      reason: string | null;
    };
    expect(row.write_status).toBe('rejected');
    expect(row.status).toBe('draft');
    expect(row.reason).toBe('duplicate');
    expect(res.stderr).toContain('-> blocked (by ct-rev)');
  });

  test('approve / reject require --by (no PROVE_AGENT fallback set)', () => {
    recordKind('a1', 'adr');
    const savedAgent = process.env.PROVE_AGENT;
    restoreEnv('PROVE_AGENT', undefined);
    try {
      const a = withCapture(() => runDecisionCmd('approve', ['a1', undefined], {}));
      expect(a.exit).toBe(1);
      expect(a.stderr).toContain('--by <responder> is required');
      const r = withCapture(() => runDecisionCmd('reject', ['a1', undefined], {}));
      expect(r.exit).toBe(1);
      expect(r.stderr).toContain('--by <responder> is required');
    } finally {
      restoreEnv('PROVE_AGENT', savedAgent);
    }
  });

  test('approve refuses a non-gated decision', () => {
    const rel = join('.prove', 'decisions', 'plain.md');
    mkdirSync(join(workspace, '.prove', 'decisions'), { recursive: true });
    writeFileSync(join(workspace, rel), '# plain\n\nBody\n', 'utf8');
    withCapture(() => runDecisionCmd('record', [rel, undefined], {}));
    const res = withCapture(() => runDecisionCmd('approve', ['plain', undefined], { by: 'ct-x' }));
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('is not gated');
  });

  test('re-deciding an already-resolved gate exits 1', () => {
    recordKind('a1', 'adr');
    withCapture(() => runDecisionCmd('approve', ['a1', undefined], { by: 'ct-x' }));
    const res = withCapture(() => runDecisionCmd('reject', ['a1', undefined], { by: 'ct-y' }));
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain("already resolved ('approved')");
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

  test('register merges into an existing artifact, preserving the authored body', () => {
    // Simulate the bootstrap-then-author flow: a frontmatter-headed artifact
    // whose skeleton body the operator has replaced with real prose.
    const dir = join(workspace, 'contributors');
    mkdirSync(dir, { recursive: true });
    const authored = [
      '---',
      'schema_version: 1',
      'provenance:',
      '  created_by: null',
      '  created_at: 2026-01-01T00:00:00.000Z',
      '  last_modified_by: null',
      '  last_modified_at: 2026-01-01T00:00:00.000Z',
      '---',
      '',
      '# Contributor: Jane Doe',
      '',
      '## Identity',
      '',
      'Principal engineer; drives the auth roadmap.',
      '',
      '## Focus',
      '',
      'OAuth migration and session hardening.',
      '',
    ].join('\n');
    writeFileSync(join(dir, 'jane-doe.md'), authored, 'utf8');

    const res = withCapture(() =>
      runContributorCmd('register', {
        slug: 'jane-doe',
        github: 'janedoe',
        workspaceRoot: workspace,
      }),
    );
    expect(res.exit).toBe(0);
    const row = JSON.parse(res.stdout.trim()) as ContributorRow;

    const content = readFileSync(join(dir, 'jane-doe.md'), 'utf8');
    // Registry fields landed in the frontmatter mirror...
    expect(content).toContain('contributor:');
    expect(content).toContain(`id: ${row.id}`);
    expect(content).toContain('github: janedoe');
    // ...the original scaffold stamp survives...
    expect(content).toContain('created_at: 2026-01-01T00:00:00.000Z');
    // ...and the authored body is preserved verbatim — never the skeleton.
    expect(content).toContain('Principal engineer; drives the auth roadmap.');
    expect(content).toContain('OAuth migration and session hardening.');
    expect(content).not.toContain('<!-- Areas of ownership and current focus. -->');
  });

  test('register replaces a stale contributor block instead of stacking a second one', () => {
    // An artifact carrying an out-of-date contributor block (e.g. files
    // survived a store reset) — the merge must re-assert the fresh registry
    // mirror, not append a duplicate `contributor:` key.
    const dir = join(workspace, 'contributors');
    mkdirSync(dir, { recursive: true });
    const stale = [
      '---',
      'schema_version: 1',
      'provenance:',
      '  created_by: null',
      '  created_at: 2026-01-01T00:00:00.000Z',
      '  last_modified_by: null',
      '  last_modified_at: 2026-01-01T00:00:00.000Z',
      'contributor:',
      '  id: ct-amy-stale',
      '  slug: amy',
      '  status: active',
      '  display_name: null',
      '  github: amy-old',
      '  email: null',
      '---',
      '',
      '# Contributor: Amy',
      '',
      'Owns the data pipeline.',
      '',
    ].join('\n');
    writeFileSync(join(dir, 'amy.md'), stale, 'utf8');

    const res = withCapture(() =>
      runContributorCmd('register', { slug: 'amy', github: 'amy-new', workspaceRoot: workspace }),
    );
    expect(res.exit).toBe(0);
    const row = JSON.parse(res.stdout.trim()) as ContributorRow;

    const content = readFileSync(join(dir, 'amy.md'), 'utf8');
    expect(content.match(/^contributor:$/gm)).toHaveLength(1);
    expect(content).toContain(`id: ${row.id}`);
    expect(content).not.toContain('ct-amy-stale');
    expect(content).toContain('github: amy-new');
    expect(content).toContain('Owns the data pipeline.');
  });

  test('register rejecting a duplicate slug leaves the existing artifact untouched', () => {
    withCapture(() =>
      runContributorCmd('register', { slug: 'zoe', github: 'zoe-gh', workspaceRoot: workspace }),
    );
    const path = join(workspace, 'contributors', 'zoe.md');
    const before = readFileSync(path, 'utf8');

    const res = withCapture(() =>
      runContributorCmd('register', { slug: 'zoe', github: 'zoe-new', workspaceRoot: workspace }),
    );
    expect(res.exit).toBe(1);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  test('register prepends frontmatter onto a bare-markdown artifact, keeping its content', () => {
    const dir = join(workspace, 'contributors');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'bob.md'), '# Bob\n\nHand-written notes.\n', 'utf8');

    const res = withCapture(() =>
      runContributorCmd('register', { slug: 'bob', workspaceRoot: workspace }),
    );
    expect(res.exit).toBe(0);

    const content = readFileSync(join(dir, 'bob.md'), 'utf8');
    expect(content.startsWith('---\n')).toBe(true);
    expect(content).toContain('contributor:');
    expect(content).toContain('# Bob\n\nHand-written notes.\n');
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

  // `default <set|show>` is store-independent: it never opens `.prove/prove.db`.
  // `set` writes to the machine-global `~/.claude-prove/config.json` only;
  // `show` resolves from there and falls back per-key to the legacy XDG
  // location. Every test pins `configBase` (the machine-global root, the
  // workspace here) — and where the legacy fallback is exercised, a separate
  // `legacyConfigBase` — to tmp dirs so the developer's real home dotfiles are
  // never touched.
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

    test('set writes the mapping to the machine-global ~/.claude-prove location', () => {
      const setRes = withCapture(() =>
        runContributorCmd(
          'default',
          { projectRoot: workspace, id: 'ct-machine-global-1', configBase: workspace },
          'set',
        ),
      );
      expect(setRes.exit).toBe(0);

      // The machine-global file is `<base>/config.json` (no `claude-prove/`
      // subdir — that subdir is the LEGACY XDG layout, which `set` never writes).
      const machinePath = join(workspace, 'config.json');
      expect(existsSync(machinePath)).toBe(true);
      const written = JSON.parse(readFileSync(machinePath, 'utf8')) as {
        default_contributors: Record<string, string>;
      };
      expect(written.default_contributors[workspace]).toBe('ct-machine-global-1');

      // The legacy XDG file must NOT have been created by `set`.
      expect(existsSync(join(workspace, 'claude-prove', 'config.json'))).toBe(false);
    });

    test('show resolves a legacy-only mapping via the XDG fallback', () => {
      // Seed ONLY the legacy XDG location (`<legacyBase>/claude-prove/config.json`)
      // with no machine-global file present, so resolution must fall back.
      const legacyBase = mkdtempSync(join(tmpdir(), 'scrum-cli-legacy-'));
      mkdirSync(join(legacyBase, 'claude-prove'), { recursive: true });
      writeFileSync(
        join(legacyBase, 'claude-prove', 'config.json'),
        JSON.stringify({ default_contributors: { [workspace]: 'ct-legacy-only-7' } }),
        'utf8',
      );

      try {
        const res = withCapture(() =>
          runContributorCmd(
            'default',
            { projectRoot: workspace, configBase: workspace, legacyConfigBase: legacyBase },
            'show',
          ),
        );
        expect(res.exit).toBe(0);
        expect(JSON.parse(res.stdout.trim())).toBe('ct-legacy-only-7');
      } finally {
        rmSync(legacyBase, { recursive: true, force: true });
      }
    });

    test('show prefers the machine-global location over a legacy mapping', () => {
      const legacyBase = mkdtempSync(join(tmpdir(), 'scrum-cli-legacy-'));
      mkdirSync(join(legacyBase, 'claude-prove'), { recursive: true });
      writeFileSync(
        join(legacyBase, 'claude-prove', 'config.json'),
        JSON.stringify({ default_contributors: { [workspace]: 'ct-legacy-shadowed' } }),
        'utf8',
      );

      try {
        // The machine-global value for the SAME root must shadow the legacy one.
        withCapture(() =>
          runContributorCmd(
            'default',
            { projectRoot: workspace, id: 'ct-new-wins', configBase: workspace },
            'set',
          ),
        );

        const res = withCapture(() =>
          runContributorCmd(
            'default',
            { projectRoot: workspace, configBase: workspace, legacyConfigBase: legacyBase },
            'show',
          ),
        );
        expect(res.exit).toBe(0);
        expect(JSON.parse(res.stdout.trim())).toBe('ct-new-wins');
      } finally {
        rmSync(legacyBase, { recursive: true, force: true });
      }
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
// Default-contributor provenance stamping — the cli-store seam end-to-end
// ---------------------------------------------------------------------------

describe('default-contributor provenance stamping', () => {
  // The handlers resolve the ambient actor from the machine-global config and
  // never thread an explicit base, so pin the env seam at the tmp workspace —
  // the developer's real ~/.claude-prove is never read or written. Pin
  // XDG_CONFIG_HOME too so the legacy read fallback is equally hermetic, and
  // unset PROVE_AGENT so the mapping tier is what's exercised.
  let savedMachineDir: string | undefined;
  let savedXdg: string | undefined;
  let savedAgent: string | undefined;

  beforeEach(() => {
    savedMachineDir = process.env[MACHINE_CONFIG_DIR_ENV_VAR];
    savedXdg = process.env.XDG_CONFIG_HOME;
    savedAgent = process.env.PROVE_AGENT;
    process.env[MACHINE_CONFIG_DIR_ENV_VAR] = join(workspace, 'machine');
    process.env.XDG_CONFIG_HOME = join(workspace, 'xdg');
    restoreEnv('PROVE_AGENT', undefined);
  });
  afterEach(() => {
    restoreEnv(MACHINE_CONFIG_DIR_ENV_VAR, savedMachineDir);
    restoreEnv('XDG_CONFIG_HOME', savedXdg);
    restoreEnv('PROVE_AGENT', savedAgent);
  });

  interface TaskJson {
    id: string;
    provenance: { created_by: string | null; last_modified_by: string | null };
  }

  test('cold task create/status writes stamp the mapped CT-UUID', () => {
    const set = withCapture(() =>
      runContributorCmd('default', { projectRoot: workspace, id: 'ct-operator-1' }, 'set'),
    );
    expect(set.exit).toBe(0);

    const created = withCapture(() =>
      runTaskCmd('create', [], { title: 'Attributed task', workspaceRoot: workspace }),
    );
    expect(created.exit).toBe(0);
    const task = JSON.parse(created.stdout.trim()) as TaskJson;
    expect(task.provenance.created_by).toBe('ct-operator-1');

    const status = withCapture(() =>
      runTaskCmd('status', [task.id, 'ready'], { workspaceRoot: workspace }),
    );
    expect(status.exit).toBe(0);
    const updated = JSON.parse(status.stdout.trim()) as TaskJson;
    expect(updated.provenance.last_modified_by).toBe('ct-operator-1');
  });

  test('an unmapped project root keeps writes unattributed (NULL)', () => {
    const created = withCapture(() =>
      runTaskCmd('create', [], { title: 'Unattributed task', workspaceRoot: workspace }),
    );
    expect(created.exit).toBe(0);
    const task = JSON.parse(created.stdout.trim()) as TaskJson;
    expect(task.provenance.created_by).toBeNull();
  });

  test('PROVE_AGENT wins over the mapped default contributor', () => {
    withCapture(() =>
      runContributorCmd('default', { projectRoot: workspace, id: 'ct-operator-1' }, 'set'),
    );
    process.env.PROVE_AGENT = 'orchestrator-worker';
    const created = withCapture(() =>
      runTaskCmd('create', [], { title: 'Env-attributed task', workspaceRoot: workspace }),
    );
    const task = JSON.parse(created.stdout.trim()) as TaskJson;
    expect(task.provenance.created_by).toBe('orchestrator-worker');
  });

  test('a malformed machine config self-heals: write succeeds unattributed, corrupt file backed aside', () => {
    const cfgDir = join(workspace, 'machine');
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(join(cfgDir, 'config.json'), '{ not json', 'utf8');

    const created = withCapture(() =>
      runTaskCmd('create', [], { title: 'Still works', workspaceRoot: workspace }),
    );
    expect(created.exit).toBe(0);
    const task = JSON.parse(created.stdout.trim()) as TaskJson;
    expect(task.provenance.created_by).toBeNull();
    // The reader backs the corrupt file aside (never deletes) and proceeds
    // with an empty config — corruption must not wedge store writes.
    const entries = readdirSync(cfgDir);
    expect(entries.some((name) => name.startsWith('config.json.corrupt-'))).toBe(true);
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
  terminates_on_milestone: string | null;
  status: string;
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
    expect(content).toContain('schema_version: 26');
    expect(content).toContain('team:');
    expect(content).toContain('slug: payments');
    expect(content).toContain('team_type: stream_aligned');
    expect(content).toContain('lifetime: persistent');
    // v18 lifecycle fields mirror a freshly-created (persistent, active) team.
    expect(content).toContain('terminates_on_milestone: null');
    expect(content).toContain('status: active');
    // v15 scope block mirrors the (empty) scope rows of a freshly-created team.
    expect(content).toContain('scope:');
    expect(content).toContain('read: []');
    expect(content).toContain('write: []');
    // v16 roster block mirrors the (vacant) role slots of a freshly-created team.
    expect(content).toContain('roster:');
    expect(content).toContain('tech_lead: null');
    expect(content).toContain('engineer: null');
    expect(content).toContain('implementer: null');
    // v17 interface block mirrors the (empty) accept/expose rows of a fresh team.
    expect(content).toContain('interface:');
    expect(content).toContain('accepts: []');
    expect(content).toContain('exposes:');
    // v19 lore block mirrors the (empty) Lore of a freshly-created team.
    expect(content).toContain('lore:');
    expect(content).toContain('count: 0');
  });

  test('create honors an explicit --lifetime + --terminates-on', () => {
    const res = withCapture(() =>
      runTeamCmd('create', [undefined], {
        slug: 'migration-squad',
        teamType: 'enabling',
        lifetime: 'terminates_on_milestone',
        terminatesOn: 'migrate-v2',
        workspaceRoot: workspace,
      }),
    );
    expect(res.exit).toBe(0);
    const row = JSON.parse(res.stdout.trim()) as TeamRow;
    expect(row.lifetime).toBe('terminates_on_milestone');
    expect(row.terminates_on_milestone).toBe('migrate-v2');
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

  // --- scope-set / scope-show (v15) ---

  interface ScopeRow {
    read: string[];
    write: string[];
  }

  function createTeamFixture(slug: string, teamType = 'stream_aligned'): void {
    withCapture(() =>
      runTeamCmd('create', [undefined], { slug, teamType, workspaceRoot: workspace }),
    );
  }

  test('scope-set replaces read/write globs, reflects into the artifact', () => {
    createTeamFixture('payments');
    const res = withCapture(() =>
      runTeamCmd('scope-set', ['payments'], {
        read: 'src/shared/**',
        write: 'src/payments/**',
        workspaceRoot: workspace,
      }),
    );
    expect(res.exit).toBe(0);
    const scopes = JSON.parse(res.stdout.trim()) as ScopeRow;
    expect(scopes).toEqual({ read: ['src/shared/**'], write: ['src/payments/**'] });

    const content = readFileSync(join(workspace, 'teams', 'payments.md'), 'utf8');
    expect(content).toContain('scope:');
    expect(content).toContain('"src/payments/**"');
    expect(content).toContain('"src/shared/**"');
  });

  test('scope-set accepts disjoint writes + overlapping reads across teams', () => {
    createTeamFixture('payments');
    createTeamFixture('identity');
    const a = withCapture(() =>
      runTeamCmd('scope-set', ['payments'], {
        read: 'src/shared/**',
        write: 'src/payments/**',
        workspaceRoot: workspace,
      }),
    );
    const b = withCapture(() =>
      runTeamCmd('scope-set', ['identity'], {
        read: 'src/shared/**',
        write: 'src/identity/**',
        workspaceRoot: workspace,
      }),
    );
    expect(a.exit).toBe(0);
    expect(b.exit).toBe(0);
  });

  test('scope-set rejects a write overlap, naming both teams + the glob', () => {
    createTeamFixture('payments');
    createTeamFixture('identity');
    withCapture(() =>
      runTeamCmd('scope-set', ['payments'], { write: 'src/shared/**', workspaceRoot: workspace }),
    );
    const res = withCapture(() =>
      runTeamCmd('scope-set', ['identity'], { write: 'src/shared/**', workspaceRoot: workspace }),
    );
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('write-scope overlap');
    expect(res.stderr).toContain("'identity'");
    expect(res.stderr).toContain("'payments'");
    expect(res.stderr).toContain('src/shared/**');
  });

  test('scope-show prints the scope JSON, exit 0', () => {
    createTeamFixture('payments');
    withCapture(() =>
      runTeamCmd('scope-set', ['payments'], { write: 'src/payments/**', workspaceRoot: workspace }),
    );
    const res = withCapture(() =>
      runTeamCmd('scope-show', ['payments'], { workspaceRoot: workspace }),
    );
    expect(res.exit).toBe(0);
    expect((JSON.parse(res.stdout.trim()) as ScopeRow).write).toEqual(['src/payments/**']);
  });

  test('scope-show on an unknown slug exits 1 with null on stdout', () => {
    const res = withCapture(() =>
      runTeamCmd('scope-show', ['ghost'], { workspaceRoot: workspace }),
    );
    expect(res.exit).toBe(1);
    expect(res.stdout.trim()).toBe('null');
    expect(res.stderr).toContain("no team 'ghost'");
  });

  test('scope-set on an unknown slug exits 1', () => {
    const res = withCapture(() =>
      runTeamCmd('scope-set', ['ghost'], { write: 'src/x/**', workspaceRoot: workspace }),
    );
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain("unknown team 'ghost'");
  });

  // --- rotate / roster (v16) ---

  interface MemberRow {
    id: number;
    team_slug: string;
    role: string;
    contributor_id: string;
    from_ts: string;
    to_ts: string | null;
    reason: string | null;
  }

  interface RosterResult {
    slug: string;
    current: Record<string, MemberRow | null>;
  }

  test('rotate appends an open interval, prints the row, reflects the artifact', () => {
    createTeamFixture('payments');
    const res = withCapture(() =>
      runTeamCmd('rotate', ['payments'], {
        role: 'tech_lead',
        contributor: 'ct-jane',
        reason: 'founding lead',
        workspaceRoot: workspace,
      }),
    );
    expect(res.exit).toBe(0);
    const row = JSON.parse(res.stdout.trim()) as MemberRow;
    expect(row.role).toBe('tech_lead');
    expect(row.contributor_id).toBe('ct-jane');
    expect(row.to_ts).toBeNull();
    expect(row.reason).toBe('founding lead');

    const content = readFileSync(join(workspace, 'teams', 'payments.md'), 'utf8');
    expect(content).toContain('roster:');
    expect(content).toContain('tech_lead: ct-jane');
  });

  test('rotate without --role exits 1', () => {
    createTeamFixture('payments');
    const res = withCapture(() =>
      runTeamCmd('rotate', ['payments'], { contributor: 'ct-jane', workspaceRoot: workspace }),
    );
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('--role');
  });

  test('rotate without --contributor exits 1', () => {
    createTeamFixture('payments');
    const res = withCapture(() =>
      runTeamCmd('rotate', ['payments'], { role: 'engineer', workspaceRoot: workspace }),
    );
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('--contributor');
  });

  test('rotate rejects an off-vocabulary --role', () => {
    createTeamFixture('payments');
    const res = withCapture(() =>
      runTeamCmd('rotate', ['payments'], {
        role: 'overlord',
        contributor: 'ct-jane',
        workspaceRoot: workspace,
      }),
    );
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('unknown --role');
  });

  test('rotate on an unknown team exits 1', () => {
    const res = withCapture(() =>
      runTeamCmd('rotate', ['ghost'], {
        role: 'engineer',
        contributor: 'ct-jane',
        workspaceRoot: workspace,
      }),
    );
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain("unknown team 'ghost'");
  });

  test('rotate warns (exit 0) when one contributor fills a second slot', () => {
    createTeamFixture('payments');
    withCapture(() =>
      runTeamCmd('rotate', ['payments'], {
        role: 'tech_lead',
        contributor: 'ct-solo',
        workspaceRoot: workspace,
      }),
    );
    const res = withCapture(() =>
      runTeamCmd('rotate', ['payments'], {
        role: 'engineer',
        contributor: 'ct-solo',
        workspaceRoot: workspace,
      }),
    );
    // The rotation still completes — multi-slot WARNS, never rejects.
    expect(res.exit).toBe(0);
    expect(res.stderr).toContain('WARNING');
    expect(res.stderr).toContain('ct-solo');
  });

  test('roster prints the current holder per role, exit 0', () => {
    createTeamFixture('payments');
    withCapture(() =>
      runTeamCmd('rotate', ['payments'], {
        role: 'engineer',
        contributor: 'ct-bob',
        workspaceRoot: workspace,
      }),
    );
    const res = withCapture(() => runTeamCmd('roster', ['payments'], { workspaceRoot: workspace }));
    expect(res.exit).toBe(0);
    const roster = JSON.parse(res.stdout.trim()) as RosterResult;
    expect(roster.slug).toBe('payments');
    expect(roster.current.engineer?.contributor_id).toBe('ct-bob');
    expect(roster.current.tech_lead).toBeNull();
    expect(roster.current.implementer).toBeNull();
  });

  test('roster on an unknown slug exits 1 with null on stdout', () => {
    const res = withCapture(() => runTeamCmd('roster', ['ghost'], { workspaceRoot: workspace }));
    expect(res.exit).toBe(1);
    expect(res.stdout.trim()).toBe('null');
    expect(res.stderr).toContain("no team 'ghost'");
  });

  // --- accept-add / accept-supersede / expose-add / expose-supersede / interface (v17) ---

  interface AcceptRow {
    id: number;
    team_slug: string;
    ask_type: string;
    status: string;
    superseded_by: number | null;
    reason: string | null;
  }

  interface ExposeRow {
    id: number;
    team_slug: string;
    name: string;
    schema_ref: string;
    status: string;
  }

  interface InterfaceResult {
    slug: string;
    accepts: AcceptRow[];
    exposes: ExposeRow[];
  }

  test('accept-add appends an active row, prints JSON, reflects the artifact', () => {
    createTeamFixture('payments');
    const res = withCapture(() =>
      runTeamCmd('accept-add', ['payments'], {
        askType: 'schema-change',
        workspaceRoot: workspace,
      }),
    );
    expect(res.exit).toBe(0);
    const row = JSON.parse(res.stdout.trim()) as AcceptRow;
    expect(row.ask_type).toBe('schema-change');
    expect(row.status).toBe('active');

    const content = readFileSync(join(workspace, 'teams', 'payments.md'), 'utf8');
    expect(content).toContain('interface:');
    expect(content).toContain('schema-change');
  });

  test('accept-add without --ask-type exits 1', () => {
    createTeamFixture('payments');
    const res = withCapture(() =>
      runTeamCmd('accept-add', ['payments'], { workspaceRoot: workspace }),
    );
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('--ask-type');
  });

  test('accept-add rejects a non-kebab-case ask type', () => {
    createTeamFixture('payments');
    const res = withCapture(() =>
      runTeamCmd('accept-add', ['payments'], { askType: 'SchemaChange', workspaceRoot: workspace }),
    );
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('invalid ask_type');
  });

  test('accept-add on an unknown team exits 1', () => {
    const res = withCapture(() =>
      runTeamCmd('accept-add', ['ghost'], { askType: 'api-review', workspaceRoot: workspace }),
    );
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain("unknown team 'ghost'");
  });

  test('accept-supersede retires an entry in place (status + reason), exit 0', () => {
    createTeamFixture('payments');
    const added = withCapture(() =>
      runTeamCmd('accept-add', ['payments'], {
        askType: 'schema-change',
        workspaceRoot: workspace,
      }),
    );
    const id = (JSON.parse(added.stdout.trim()) as AcceptRow).id;
    const res = withCapture(() =>
      runTeamCmd('accept-supersede', ['payments'], {
        id: String(id),
        reason: 'renamed',
        workspaceRoot: workspace,
      }),
    );
    expect(res.exit).toBe(0);
    const row = JSON.parse(res.stdout.trim()) as AcceptRow;
    expect(row.status).toBe('superseded');
    expect(row.reason).toBe('renamed');

    // The active interface no longer carries the retired entry.
    const iface = withCapture(() =>
      runTeamCmd('interface', ['payments'], { workspaceRoot: workspace }),
    );
    expect((JSON.parse(iface.stdout.trim()) as InterfaceResult).accepts).toEqual([]);
  });

  test('accept-supersede without --reason exits 1', () => {
    createTeamFixture('payments');
    const res = withCapture(() =>
      runTeamCmd('accept-supersede', ['payments'], { id: '1', workspaceRoot: workspace }),
    );
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('--reason');
  });

  test('accept-supersede on an unknown id exits 1', () => {
    createTeamFixture('payments');
    const res = withCapture(() =>
      runTeamCmd('accept-supersede', ['payments'], {
        id: '9999',
        reason: 'gone',
        workspaceRoot: workspace,
      }),
    );
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain("unknown accept id '9999'");
  });

  test('expose-add appends an active row, prints JSON', () => {
    createTeamFixture('payments');
    const res = withCapture(() =>
      runTeamCmd('expose-add', ['payments'], {
        name: 'PaymentEvent',
        schemaRef: 'schemas/payment-event.json',
        workspaceRoot: workspace,
      }),
    );
    expect(res.exit).toBe(0);
    const row = JSON.parse(res.stdout.trim()) as ExposeRow;
    expect(row.name).toBe('PaymentEvent');
    expect(row.schema_ref).toBe('schemas/payment-event.json');
    expect(row.status).toBe('active');
  });

  test('expose-add without --name or --schema-ref exits 1', () => {
    createTeamFixture('payments');
    const noName = withCapture(() =>
      runTeamCmd('expose-add', ['payments'], { schemaRef: 'x.json', workspaceRoot: workspace }),
    );
    expect(noName.exit).toBe(1);
    expect(noName.stderr).toContain('--name');
    const noRef = withCapture(() =>
      runTeamCmd('expose-add', ['payments'], { name: 'X', workspaceRoot: workspace }),
    );
    expect(noRef.exit).toBe(1);
    expect(noRef.stderr).toContain('--schema-ref');
  });

  test('expose-supersede retires an entry in place, exit 0', () => {
    createTeamFixture('payments');
    const added = withCapture(() =>
      runTeamCmd('expose-add', ['payments'], {
        name: 'Old',
        schemaRef: 'old.json',
        workspaceRoot: workspace,
      }),
    );
    const id = (JSON.parse(added.stdout.trim()) as ExposeRow).id;
    const res = withCapture(() =>
      runTeamCmd('expose-supersede', ['payments'], {
        id: String(id),
        reason: 'deprecated',
        workspaceRoot: workspace,
      }),
    );
    expect(res.exit).toBe(0);
    expect((JSON.parse(res.stdout.trim()) as ExposeRow).status).toBe('superseded');
  });

  test('interface prints active accepts[] + exposes[], exit 0', () => {
    createTeamFixture('payments');
    withCapture(() =>
      runTeamCmd('accept-add', ['payments'], {
        askType: 'schema-change',
        workspaceRoot: workspace,
      }),
    );
    withCapture(() =>
      runTeamCmd('expose-add', ['payments'], {
        name: 'PaymentEvent',
        schemaRef: 'pe.json',
        workspaceRoot: workspace,
      }),
    );
    const res = withCapture(() =>
      runTeamCmd('interface', ['payments'], { workspaceRoot: workspace }),
    );
    expect(res.exit).toBe(0);
    const iface = JSON.parse(res.stdout.trim()) as InterfaceResult;
    expect(iface.slug).toBe('payments');
    expect(iface.accepts.map((a) => a.ask_type)).toEqual(['schema-change']);
    expect(iface.exposes.map((e) => e.name)).toEqual(['PaymentEvent']);
  });

  test('interface on an unknown slug exits 1 with null on stdout', () => {
    const res = withCapture(() => runTeamCmd('interface', ['ghost'], { workspaceRoot: workspace }));
    expect(res.exit).toBe(1);
    expect(res.stdout.trim()).toBe('null');
    expect(res.stderr).toContain("no team 'ghost'");
  });

  // --- create --terminates-on consistency guard + terminate (v18) ---

  interface TerminateResult {
    slug: string;
    exposesRetired: number;
    rosterVacated: number;
    scopesCleared: number;
  }

  test('create with --lifetime terminates_on_milestone but no --terminates-on exits 1', () => {
    const res = withCapture(() =>
      runTeamCmd('create', [undefined], {
        slug: 'squad',
        teamType: 'enabling',
        lifetime: 'terminates_on_milestone',
        workspaceRoot: workspace,
      }),
    );
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('requires a terminates_on_milestone target');
  });

  test('create --terminates-on reflects the target into the artifact', () => {
    const res = withCapture(() =>
      runTeamCmd('create', [undefined], {
        slug: 'squad',
        teamType: 'enabling',
        lifetime: 'terminates_on_milestone',
        terminatesOn: 'migrate-v2',
        workspaceRoot: workspace,
      }),
    );
    expect(res.exit).toBe(0);
    const content = readFileSync(join(workspace, 'teams', 'squad.md'), 'utf8');
    expect(content).toContain('terminates_on_milestone: migrate-v2');
    expect(content).toContain('status: active');
  });

  test('terminate disbands the team, prints counts, flips the artifact to inactive', () => {
    createTeamFixture('payments');
    withCapture(() =>
      runTeamCmd('scope-set', ['payments'], { write: 'src/payments/**', workspaceRoot: workspace }),
    );
    withCapture(() =>
      runTeamCmd('rotate', ['payments'], {
        role: 'tech_lead',
        contributor: 'ct-jane',
        workspaceRoot: workspace,
      }),
    );
    withCapture(() =>
      runTeamCmd('expose-add', ['payments'], {
        name: 'PaymentEvent',
        schemaRef: 'pe.json',
        workspaceRoot: workspace,
      }),
    );

    const res = withCapture(() =>
      runTeamCmd('terminate', ['payments'], { reason: 'work complete', workspaceRoot: workspace }),
    );
    expect(res.exit).toBe(0);
    const result = JSON.parse(res.stdout.trim()) as TerminateResult;
    expect(result).toEqual({
      slug: 'payments',
      exposesRetired: 1,
      rosterVacated: 1,
      scopesCleared: 1,
    });

    const content = readFileSync(join(workspace, 'teams', 'payments.md'), 'utf8');
    expect(content).toContain('status: inactive');
    expect(content).toContain('write: []');
    expect(content).toContain('tech_lead: null');
  });

  test('terminate on an unknown team exits 1', () => {
    const res = withCapture(() => runTeamCmd('terminate', ['ghost'], { workspaceRoot: workspace }));
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain("unknown team 'ghost'");
  });

  test('terminate on an already-inactive team exits 1', () => {
    createTeamFixture('payments');
    withCapture(() => runTeamCmd('terminate', ['payments'], { workspaceRoot: workspace }));
    const res = withCapture(() =>
      runTeamCmd('terminate', ['payments'], { workspaceRoot: workspace }),
    );
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('already inactive');
  });

  test('milestone close disbands a pinned team end-to-end through the CLI', () => {
    withCapture(() =>
      runMilestoneCmd('create', [undefined, undefined], {
        title: 'Migrate v2',
        id: 'migrate-v2',
        workspaceRoot: workspace,
      }),
    );
    withCapture(() =>
      runTeamCmd('create', [undefined], {
        slug: 'squad',
        teamType: 'enabling',
        lifetime: 'terminates_on_milestone',
        terminatesOn: 'migrate-v2',
        workspaceRoot: workspace,
      }),
    );

    const cl = withCapture(() =>
      runMilestoneCmd('close', ['migrate-v2', undefined], { workspaceRoot: workspace }),
    );
    expect(cl.exit).toBe(0);

    const shown = withCapture(() => runTeamCmd('show', ['squad'], { workspaceRoot: workspace }));
    expect((JSON.parse(shown.stdout.trim()) as TeamRow).status).toBe('inactive');
  });
});

// ---------------------------------------------------------------------------
// runLoreCmd — team Lore layer record / list / show (v19)
// ---------------------------------------------------------------------------

interface LoreRow {
  id: number;
  team_slug: string;
  body: string;
  author_contributor_id: string;
  created_at: string;
}

describe('runLoreCmd', () => {
  function createTeam(slug: string): void {
    withCapture(() =>
      runTeamCmd('create', [undefined], {
        slug,
        teamType: 'stream_aligned',
        workspaceRoot: workspace,
      }),
    );
  }

  function seatTechLead(slug: string, contributor: string): void {
    withCapture(() =>
      runTeamCmd('rotate', [slug], {
        role: 'tech_lead',
        contributor,
        workspaceRoot: workspace,
      }),
    );
  }

  test('record by the seated tech_lead appends an entry and reflects into the artifact', () => {
    createTeam('payments');
    seatTechLead('payments', 'CT-lead');
    const res = withCapture(() =>
      runLoreCmd('record', ['payments'], {
        body: 'prefer idempotent migrations',
        author: 'CT-lead',
        workspaceRoot: workspace,
      }),
    );
    expect(res.exit).toBe(0);
    const row = JSON.parse(res.stdout.trim()) as LoreRow;
    expect(row.team_slug).toBe('payments');
    expect(row.body).toBe('prefer idempotent migrations');
    expect(row.author_contributor_id).toBe('CT-lead');

    // The lore block in the artifact carries the new entry.
    const content = readFileSync(join(workspace, 'teams', 'payments.md'), 'utf8');
    expect(content).toContain('lore:');
    expect(content).toContain('count: 1');
    expect(content).toContain('prefer idempotent migrations');
  });

  test('record by a non-tech_lead author exits 1, naming the expected tech_lead', () => {
    createTeam('payments');
    seatTechLead('payments', 'CT-lead');
    const res = withCapture(() =>
      runLoreCmd('record', ['payments'], {
        body: 'sneaky note',
        author: 'CT-impostor',
        workspaceRoot: workspace,
      }),
    );
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('not the current tech_lead');
    expect(res.stderr).toContain('CT-lead');
    // The rejected write left no entry.
    const list = withCapture(() => runLoreCmd('list', ['payments'], { workspaceRoot: workspace }));
    expect(JSON.parse(list.stdout.trim())).toEqual([]);
  });

  test('record with no tech_lead seated WARNS on stderr but exits 0 (bootstrapping)', () => {
    createTeam('payments');
    const res = withCapture(() =>
      runLoreCmd('record', ['payments'], {
        body: 'first convention',
        author: 'CT-solo',
        workspaceRoot: workspace,
      }),
    );
    expect(res.exit).toBe(0);
    expect(res.stderr).toContain('WARNING');
    expect(res.stderr).toContain('no current tech_lead');
    const row = JSON.parse(res.stdout.trim()) as LoreRow;
    expect(row.body).toBe('first convention');
  });

  test('record on an unknown team exits 1', () => {
    const res = withCapture(() =>
      runLoreCmd('record', ['ghost'], { body: 'x', author: 'CT-lead', workspaceRoot: workspace }),
    );
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain("unknown team 'ghost'");
  });

  test('record requires --body and --author', () => {
    createTeam('payments');
    const noBody = withCapture(() =>
      runLoreCmd('record', ['payments'], { author: 'CT-lead', workspaceRoot: workspace }),
    );
    expect(noBody.exit).toBe(1);
    expect(noBody.stderr).toContain('--body');
    const noAuthor = withCapture(() =>
      runLoreCmd('record', ['payments'], { body: 'x', workspaceRoot: workspace }),
    );
    expect(noAuthor.exit).toBe(1);
    expect(noAuthor.stderr).toContain('--author');
  });

  test('list returns the team entries oldest-first as JSON', () => {
    createTeam('payments');
    seatTechLead('payments', 'CT-lead');
    withCapture(() =>
      runLoreCmd('record', ['payments'], {
        body: 'first',
        author: 'CT-lead',
        workspaceRoot: workspace,
      }),
    );
    withCapture(() =>
      runLoreCmd('record', ['payments'], {
        body: 'second',
        author: 'CT-lead',
        workspaceRoot: workspace,
      }),
    );
    const res = withCapture(() => runLoreCmd('list', ['payments'], { workspaceRoot: workspace }));
    expect(res.exit).toBe(0);
    const rows = JSON.parse(res.stdout.trim()) as LoreRow[];
    expect(rows.map((r) => r.body)).toEqual(['first', 'second']);
  });

  test('list on an unknown team returns an empty array, exit 0', () => {
    const res = withCapture(() => runLoreCmd('list', ['ghost'], { workspaceRoot: workspace }));
    expect(res.exit).toBe(0);
    expect(JSON.parse(res.stdout.trim())).toEqual([]);
  });

  test('show returns one entry by id, exit 0', () => {
    createTeam('payments');
    seatTechLead('payments', 'CT-lead');
    const recorded = withCapture(() =>
      runLoreCmd('record', ['payments'], {
        body: 'pin the schema version',
        author: 'CT-lead',
        workspaceRoot: workspace,
      }),
    );
    const id = (JSON.parse(recorded.stdout.trim()) as LoreRow).id;
    const res = withCapture(() => runLoreCmd('show', [String(id)], { workspaceRoot: workspace }));
    expect(res.exit).toBe(0);
    expect((JSON.parse(res.stdout.trim()) as LoreRow).body).toBe('pin the schema version');
  });

  test('show on an unknown id exits 1 with null on stdout', () => {
    const res = withCapture(() => runLoreCmd('show', ['999999'], { workspaceRoot: workspace }));
    expect(res.exit).toBe(1);
    expect(res.stdout.trim()).toBe('null');
    expect(res.stderr).toContain("no entry '999999'");
  });

  test('an unknown lore action exits 1', () => {
    const res = withCapture(() => runLoreCmd('bogus', ['payments'], { workspaceRoot: workspace }));
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('unknown lore action');
  });
});

// ---------------------------------------------------------------------------
// runAnnotationCmd — per-artifact note add / list (v20)
// ---------------------------------------------------------------------------

interface AnnotationRow {
  id: number;
  target_kind: string;
  target_ref: string;
  body: string;
  author: string;
  created_at: string;
}

describe('runAnnotationCmd', () => {
  test('add appends a note and prints the JSON row (no authorship gate)', () => {
    const res = withCapture(() =>
      runAnnotationCmd('add', {
        targetKind: 'task',
        target: 't1',
        body: 'watch the off-by-one',
        author: 'CT-a',
        workspaceRoot: workspace,
      }),
    );
    expect(res.exit).toBe(0);
    const row = JSON.parse(res.stdout.trim()) as AnnotationRow;
    expect(row.target_kind).toBe('task');
    expect(row.target_ref).toBe('t1');
    expect(row.body).toBe('watch the off-by-one');
    expect(row.author).toBe('CT-a');
  });

  test('add on a soft target_ref succeeds even though no such target row exists', () => {
    const res = withCapture(() =>
      runAnnotationCmd('add', {
        targetKind: 'decision',
        target: 'ghost',
        body: 'note on a phantom decision',
        author: 'CT-a',
        workspaceRoot: workspace,
      }),
    );
    expect(res.exit).toBe(0);
    expect((JSON.parse(res.stdout.trim()) as AnnotationRow).target_ref).toBe('ghost');
  });

  test('add rejects a target_kind outside the closed enum, naming the valid set', () => {
    const res = withCapture(() =>
      runAnnotationCmd('add', {
        targetKind: 'milestone',
        target: 'm1',
        body: 'x',
        author: 'CT-a',
        workspaceRoot: workspace,
      }),
    );
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('--target-kind');
    expect(res.stderr).toContain('task|team|decision');
  });

  test('add requires --target, --body, and --author', () => {
    const noTarget = withCapture(() =>
      runAnnotationCmd('add', {
        targetKind: 'task',
        body: 'x',
        author: 'CT-a',
        workspaceRoot: workspace,
      }),
    );
    expect(noTarget.exit).toBe(1);
    expect(noTarget.stderr).toContain('--target');

    const noBody = withCapture(() =>
      runAnnotationCmd('add', {
        targetKind: 'task',
        target: 't1',
        author: 'CT-a',
        workspaceRoot: workspace,
      }),
    );
    expect(noBody.exit).toBe(1);
    expect(noBody.stderr).toContain('--body');

    const noAuthor = withCapture(() =>
      runAnnotationCmd('add', {
        targetKind: 'task',
        target: 't1',
        body: 'x',
        workspaceRoot: workspace,
      }),
    );
    expect(noAuthor.exit).toBe(1);
    expect(noAuthor.stderr).toContain('--author');
  });

  test('list returns a target notes oldest-first as JSON', () => {
    withCapture(() =>
      runAnnotationCmd('add', {
        targetKind: 'team',
        target: 'payments',
        body: 'first',
        author: 'CT-a',
        workspaceRoot: workspace,
      }),
    );
    withCapture(() =>
      runAnnotationCmd('add', {
        targetKind: 'team',
        target: 'payments',
        body: 'second',
        author: 'CT-b',
        workspaceRoot: workspace,
      }),
    );
    const res = withCapture(() =>
      runAnnotationCmd('list', {
        targetKind: 'team',
        target: 'payments',
        workspaceRoot: workspace,
      }),
    );
    expect(res.exit).toBe(0);
    const rows = JSON.parse(res.stdout.trim()) as AnnotationRow[];
    expect(rows.map((r) => r.body)).toEqual(['first', 'second']);
  });

  test('list scopes by (target_kind, target_ref) — a different kind, same ref, does not bleed', () => {
    withCapture(() =>
      runAnnotationCmd('add', {
        targetKind: 'task',
        target: 'x',
        body: 'task note',
        author: 'CT-a',
        workspaceRoot: workspace,
      }),
    );
    withCapture(() =>
      runAnnotationCmd('add', {
        targetKind: 'team',
        target: 'x',
        body: 'team note',
        author: 'CT-b',
        workspaceRoot: workspace,
      }),
    );
    const res = withCapture(() =>
      runAnnotationCmd('list', { targetKind: 'task', target: 'x', workspaceRoot: workspace }),
    );
    expect((JSON.parse(res.stdout.trim()) as AnnotationRow[]).map((r) => r.body)).toEqual([
      'task note',
    ]);
  });

  test('list on a target with no notes returns an empty array, exit 0', () => {
    const res = withCapture(() =>
      runAnnotationCmd('list', { targetKind: 'task', target: 'ghost', workspaceRoot: workspace }),
    );
    expect(res.exit).toBe(0);
    expect(JSON.parse(res.stdout.trim())).toEqual([]);
  });

  test('list requires --target-kind and --target', () => {
    const noKind = withCapture(() =>
      runAnnotationCmd('list', { target: 't1', workspaceRoot: workspace }),
    );
    expect(noKind.exit).toBe(1);
    expect(noKind.stderr).toContain('--target-kind');

    const noTarget = withCapture(() =>
      runAnnotationCmd('list', { targetKind: 'task', workspaceRoot: workspace }),
    );
    expect(noTarget.exit).toBe(1);
    expect(noTarget.stderr).toContain('--target');
  });

  test('an unknown annotation action exits 1', () => {
    const res = withCapture(() =>
      runAnnotationCmd('bogus', { targetKind: 'task', target: 't1', workspaceRoot: workspace }),
    );
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('unknown annotation action');
  });
});

// ---------------------------------------------------------------------------
// runEscalationCmd — escalation protocol walk-up + resolution modes (v23)
// ---------------------------------------------------------------------------

interface EscalationRowJson {
  id: number;
  task_id: string;
  escalation_type: string;
  layer: string;
  state: string;
  summary: string;
  resolution_mode: string | null;
  walked_up_from: number | null;
}

interface ResolveResultJson {
  row: EscalationRowJson;
  walkedUpTo: EscalationRowJson | null;
  reDecomposeTriggered: boolean;
}

describe('runEscalationCmd', () => {
  test('raise lands an open escalation at the implementer rung and prints the JSON row', () => {
    const res = withCapture(() =>
      runEscalationCmd('raise', [undefined], {
        task: 't1',
        type: 'blocked',
        summary: 'cannot satisfy dep',
        by: 'CT-impl',
        workspaceRoot: workspace,
      }),
    );
    expect(res.exit).toBe(0);
    const row = JSON.parse(res.stdout.trim()) as EscalationRowJson;
    expect(row.task_id).toBe('t1');
    expect(row.escalation_type).toBe('blocked');
    expect(row.layer).toBe('implementer');
    expect(row.state).toBe('open');
    expect(row.walked_up_from).toBeNull();
  });

  test('raise honors an explicit --layer', () => {
    const res = withCapture(() =>
      runEscalationCmd('raise', [undefined], {
        task: 't1',
        type: 'conflict',
        summary: 's',
        layer: 'tech_lead',
        workspaceRoot: workspace,
      }),
    );
    expect(res.exit).toBe(0);
    expect((JSON.parse(res.stdout.trim()) as EscalationRowJson).layer).toBe('tech_lead');
  });

  test('raise requires --task, --type, and --summary', () => {
    const noTask = withCapture(() =>
      runEscalationCmd('raise', [undefined], {
        type: 'blocked',
        summary: 's',
        workspaceRoot: workspace,
      }),
    );
    expect(noTask.exit).toBe(1);
    expect(noTask.stderr).toContain('--task');

    const noType = withCapture(() =>
      runEscalationCmd('raise', [undefined], {
        task: 't1',
        summary: 's',
        workspaceRoot: workspace,
      }),
    );
    expect(noType.exit).toBe(1);
    expect(noType.stderr).toContain('--type');

    const noSummary = withCapture(() =>
      runEscalationCmd('raise', [undefined], {
        task: 't1',
        type: 'blocked',
        workspaceRoot: workspace,
      }),
    );
    expect(noSummary.exit).toBe(1);
    expect(noSummary.stderr).toContain('--summary');
  });

  test('raise rejects an off-enum --type as a usage error', () => {
    const res = withCapture(() =>
      runEscalationCmd('raise', [undefined], {
        task: 't1',
        type: 'bogus',
        summary: 's',
        workspaceRoot: workspace,
      }),
    );
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('--type');
  });

  test('raise rejects an off-chain --layer as a usage error', () => {
    const res = withCapture(() =>
      runEscalationCmd('raise', [undefined], {
        task: 't1',
        type: 'blocked',
        summary: 's',
        layer: 'ceo',
        workspaceRoot: workspace,
      }),
    );
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain("invalid --layer 'ceo'");
  });

  test('resolve with --mode resolve transitions the row to resolved, no walk-up', () => {
    const raised = JSON.parse(
      withCapture(() =>
        runEscalationCmd('raise', [undefined], {
          task: 't1',
          type: 'ambiguous',
          summary: 's',
          workspaceRoot: workspace,
        }),
      ).stdout.trim(),
    ) as EscalationRowJson;

    const res = withCapture(() =>
      runEscalationCmd('resolve', [String(raised.id)], {
        mode: 'resolve',
        note: 'answered',
        by: 'CT-eng',
        workspaceRoot: workspace,
      }),
    );
    expect(res.exit).toBe(0);
    const result = JSON.parse(res.stdout.trim()) as ResolveResultJson;
    expect(result.row.state).toBe('resolved');
    expect(result.row.resolution_mode).toBe('resolve');
    expect(result.walkedUpTo).toBeNull();
    expect(result.reDecomposeTriggered).toBe(false);
  });

  test('resolve with --mode re_decompose discharges the row and flags re-decomposition', () => {
    const raised = JSON.parse(
      withCapture(() =>
        runEscalationCmd('raise', [undefined], {
          task: 't1',
          type: 'blocked',
          summary: 's',
          workspaceRoot: workspace,
        }),
      ).stdout.trim(),
    ) as EscalationRowJson;

    const res = withCapture(() =>
      runEscalationCmd('resolve', [String(raised.id)], {
        mode: 're_decompose',
        workspaceRoot: workspace,
      }),
    );
    const result = JSON.parse(res.stdout.trim()) as ResolveResultJson;
    expect(result.row.state).toBe('resolved');
    expect(result.reDecomposeTriggered).toBe(true);
    expect(result.walkedUpTo).toBeNull();
  });

  test('resolve with --mode re_escalate closes the row and walks one rung up', () => {
    const raised = JSON.parse(
      withCapture(() =>
        runEscalationCmd('raise', [undefined], {
          task: 't1',
          type: 'conflict',
          summary: 's',
          workspaceRoot: workspace,
        }),
      ).stdout.trim(),
    ) as EscalationRowJson;

    const res = withCapture(() =>
      runEscalationCmd('resolve', [String(raised.id)], {
        mode: 're_escalate',
        workspaceRoot: workspace,
      }),
    );
    const result = JSON.parse(res.stdout.trim()) as ResolveResultJson;
    expect(result.row.state).toBe('re_escalated');
    expect(result.walkedUpTo?.layer).toBe('engineer');
    expect(result.walkedUpTo?.state).toBe('open');
    expect(result.walkedUpTo?.walked_up_from).toBe(raised.id);
  });

  test('resolve requires --mode and rejects an off-enum mode', () => {
    const raised = JSON.parse(
      withCapture(() =>
        runEscalationCmd('raise', [undefined], {
          task: 't1',
          type: 'blocked',
          summary: 's',
          workspaceRoot: workspace,
        }),
      ).stdout.trim(),
    ) as EscalationRowJson;

    const noMode = withCapture(() =>
      runEscalationCmd('resolve', [String(raised.id)], { workspaceRoot: workspace }),
    );
    expect(noMode.exit).toBe(1);
    expect(noMode.stderr).toContain('--mode');

    const badMode = withCapture(() =>
      runEscalationCmd('resolve', [String(raised.id)], {
        mode: 'ignore',
        workspaceRoot: workspace,
      }),
    );
    expect(badMode.exit).toBe(1);
    expect(badMode.stderr).toContain('--mode');
  });

  test('resolve on an unknown id exits 1', () => {
    const res = withCapture(() =>
      runEscalationCmd('resolve', ['999'], { mode: 'resolve', workspaceRoot: workspace }),
    );
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain("unknown escalation id '999'");
  });

  test('list --task shows a task full history; list without --task shows only open rows', () => {
    const raised = JSON.parse(
      withCapture(() =>
        runEscalationCmd('raise', [undefined], {
          task: 't1',
          type: 'blocked',
          summary: 's',
          workspaceRoot: workspace,
        }),
      ).stdout.trim(),
    ) as EscalationRowJson;
    // Walk it up: the root closes, a fresh open row appears at engineer.
    withCapture(() =>
      runEscalationCmd('resolve', [String(raised.id)], {
        mode: 're_escalate',
        workspaceRoot: workspace,
      }),
    );

    const perTask = withCapture(() =>
      runEscalationCmd('list', [undefined], { task: 't1', workspaceRoot: workspace }),
    );
    const histRows = JSON.parse(perTask.stdout.trim()) as EscalationRowJson[];
    expect(histRows.map((r) => r.state)).toEqual(['re_escalated', 'open']);

    const openOnly = withCapture(() =>
      runEscalationCmd('list', [undefined], { workspaceRoot: workspace }),
    );
    const openRows = JSON.parse(openOnly.stdout.trim()) as EscalationRowJson[];
    expect(openRows.every((r) => r.state === 'open')).toBe(true);
    expect(openRows).toHaveLength(1);
    expect(openRows[0]?.layer).toBe('engineer');
  });

  test('chain reconstructs the full walk-up root-rung-first', () => {
    const raised = JSON.parse(
      withCapture(() =>
        runEscalationCmd('raise', [undefined], {
          task: 't1',
          type: 'ambiguous',
          summary: 's',
          workspaceRoot: workspace,
        }),
      ).stdout.trim(),
    ) as EscalationRowJson;
    const walked = JSON.parse(
      withCapture(() =>
        runEscalationCmd('resolve', [String(raised.id)], {
          mode: 're_escalate',
          workspaceRoot: workspace,
        }),
      ).stdout.trim(),
    ) as ResolveResultJson;

    const res = withCapture(() =>
      runEscalationCmd('chain', [String(walked.walkedUpTo?.id)], { workspaceRoot: workspace }),
    );
    expect(res.exit).toBe(0);
    const chain = JSON.parse(res.stdout.trim()) as EscalationRowJson[];
    expect(chain.map((r) => r.layer)).toEqual(['implementer', 'engineer']);
  });

  test('show and chain on an unknown id exit 1', () => {
    const show = withCapture(() => runEscalationCmd('show', ['999'], { workspaceRoot: workspace }));
    expect(show.exit).toBe(1);
    const chain = withCapture(() =>
      runEscalationCmd('chain', ['999'], { workspaceRoot: workspace }),
    );
    expect(chain.exit).toBe(1);
  });

  test('an unknown escalation action exits 1', () => {
    const res = withCapture(() =>
      runEscalationCmd('bogus', [undefined], { workspaceRoot: workspace }),
    );
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('unknown escalation action');
  });
});

// ---------------------------------------------------------------------------
// runManifestCmd — cross-team contracts read surface
// ---------------------------------------------------------------------------

interface ManifestJson {
  teams: { slug: string; accepts: { ask_type: string }[]; exposes: { name: string }[] }[];
  asks: unknown[];
}

describe('runManifestCmd', () => {
  function seedTeam(slug: string, teamType: string): void {
    withCapture(() =>
      runTeamCmd('create', [undefined], { slug, teamType, workspaceRoot: workspace }),
    );
  }

  test('show prints the cross-team JSON: every team, active accepts + exposes, slug-ordered', () => {
    seedTeam('payments', 'stream_aligned');
    seedTeam('identity', 'platform');
    withCapture(() =>
      runTeamCmd('accept-add', ['payments'], {
        askType: 'schema-change',
        workspaceRoot: workspace,
      }),
    );
    withCapture(() =>
      runTeamCmd('expose-add', ['payments'], {
        name: 'PaymentEvent',
        schemaRef: 'pe.json',
        workspaceRoot: workspace,
      }),
    );
    withCapture(() =>
      runTeamCmd('accept-add', ['identity'], { askType: 'api-review', workspaceRoot: workspace }),
    );

    const res = withCapture(() => runManifestCmd('show', { workspaceRoot: workspace }));
    expect(res.exit).toBe(0);
    const manifest = JSON.parse(res.stdout.trim()) as ManifestJson;
    expect(manifest.teams.map((t) => t.slug)).toEqual(['identity', 'payments']);
    const payments = manifest.teams.find((t) => t.slug === 'payments');
    expect(payments?.accepts.map((a) => a.ask_type)).toEqual(['schema-change']);
    expect(payments?.exposes.map((e) => e.name)).toEqual(['PaymentEvent']);
    // The asks surface is always empty until an ask protocol sources it.
    expect(manifest.asks).toEqual([]);
    expect(res.stderr).toContain('2 teams, 0 asks');
  });

  test('show tolerates zero teams (empty manifest)', () => {
    const res = withCapture(() => runManifestCmd('show', { workspaceRoot: workspace }));
    expect(res.exit).toBe(0);
    const manifest = JSON.parse(res.stdout.trim()) as ManifestJson;
    expect(manifest.teams).toEqual([]);
    expect(manifest.asks).toEqual([]);
  });

  test('show --human renders a per-team table', () => {
    seedTeam('payments', 'stream_aligned');
    withCapture(() =>
      runTeamCmd('accept-add', ['payments'], {
        askType: 'schema-change',
        workspaceRoot: workspace,
      }),
    );
    const res = withCapture(() =>
      runManifestCmd('show', { human: true, workspaceRoot: workspace }),
    );
    expect(res.exit).toBe(0);
    expect(res.stdout).toContain('TEAM');
    expect(res.stdout).toContain('ACCEPTS');
    expect(res.stdout).toContain('EXPOSES');
    expect(res.stdout).toContain('payments');
    expect(res.stdout).toContain('schema-change');
  });

  test('an unknown manifest action exits 1', () => {
    const res = withCapture(() => runManifestCmd('bogus', { workspaceRoot: workspace }));
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('unknown manifest action');
  });
});

describe('runAskCmd', () => {
  interface AskJson {
    id: number;
    from_team: string;
    to_team: string;
    ask_type: string;
    blocking_artifact: string;
    state: string;
    mapped_artifact: string | null;
    rejected_reason: string | null;
    counter_proposal: string | null;
  }

  /** File one ask and return its parsed JSON row (assumes seedAskFixture ran). */
  function fileOneAsk(): AskJson {
    const res = withCapture(() =>
      runAskCmd('file', [undefined], {
        fromTeam: 'payments',
        toTeam: 'identity',
        askType: 'schema-change',
        blockingArtifact: 'blocked-1',
        workspaceRoot: workspace,
      }),
    );
    return JSON.parse(res.stdout.trim().split('\n')[0] ?? '') as AskJson;
  }

  /** Seed two sibling teams (identity accepts schema-change) + a blocked task. */
  function seedAskFixture(): void {
    withCapture(() =>
      runTeamCmd('create', [undefined], {
        slug: 'payments',
        teamType: 'stream_aligned',
        workspaceRoot: workspace,
      }),
    );
    withCapture(() =>
      runTeamCmd('create', [undefined], {
        slug: 'identity',
        teamType: 'platform',
        workspaceRoot: workspace,
      }),
    );
    withCapture(() =>
      runTeamCmd('accept-add', ['identity'], {
        askType: 'schema-change',
        workspaceRoot: workspace,
      }),
    );
    withCapture(() =>
      runTeamCmd('expose-add', ['identity'], {
        name: 'UserRecord',
        schemaRef: 'schemas/user.json',
        workspaceRoot: workspace,
      }),
    );
    withCapture(() =>
      runTaskCmd('create', [undefined, undefined], {
        title: 'Blocked work',
        id: 'blocked-1',
        workspaceRoot: workspace,
      }),
    );
  }

  test('file persists a filed row, prints JSON + the id, exit 0', () => {
    seedAskFixture();
    const res = withCapture(() =>
      runAskCmd('file', [undefined], {
        fromTeam: 'payments',
        toTeam: 'identity',
        askType: 'schema-change',
        blockingArtifact: 'blocked-1',
        workspaceRoot: workspace,
      }),
    );
    expect(res.exit).toBe(0);
    const lines = res.stdout.trim().split('\n');
    const row = JSON.parse(lines[0] ?? '') as AskJson;
    expect(row.from_team).toBe('payments');
    expect(row.to_team).toBe('identity');
    expect(row.ask_type).toBe('schema-change');
    expect(row.blocking_artifact).toBe('blocked-1');
    expect(row.state).toBe('filed');
    // The final stdout line is the bare new ask id.
    expect(lines[lines.length - 1]).toBe(String(row.id));
  });

  test('file without --from-team exits 1', () => {
    seedAskFixture();
    const res = withCapture(() =>
      runAskCmd('file', [undefined], {
        toTeam: 'identity',
        askType: 'schema-change',
        blockingArtifact: 'blocked-1',
        workspaceRoot: workspace,
      }),
    );
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('--from-team');
  });

  test('file on an unknown to_team exits 1', () => {
    seedAskFixture();
    const res = withCapture(() =>
      runAskCmd('file', [undefined], {
        fromTeam: 'payments',
        toTeam: 'ghost',
        askType: 'schema-change',
        blockingArtifact: 'blocked-1',
        workspaceRoot: workspace,
      }),
    );
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain("unknown to_team 'ghost'");
  });

  test('file with a non-accepted ask_type exits 1', () => {
    seedAskFixture();
    const res = withCapture(() =>
      runAskCmd('file', [undefined], {
        fromTeam: 'payments',
        toTeam: 'identity',
        askType: 'api-review',
        blockingArtifact: 'blocked-1',
        workspaceRoot: workspace,
      }),
    );
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain("not accepted by to_team 'identity'");
  });

  test('file with a missing blocking_artifact exits 1', () => {
    seedAskFixture();
    const res = withCapture(() =>
      runAskCmd('file', [undefined], {
        fromTeam: 'payments',
        toTeam: 'identity',
        askType: 'schema-change',
        blockingArtifact: 'no-such-task',
        workspaceRoot: workspace,
      }),
    );
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain("unknown blocking_artifact 'no-such-task'");
  });

  test('respond accept creates a mapped child, sets state, prints the row, exit 0', () => {
    seedAskFixture();
    const filed = fileOneAsk();
    const res = withCapture(() =>
      runAskCmd('respond', [String(filed.id)], {
        verdict: 'accept',
        workspaceRoot: workspace,
      }),
    );
    expect(res.exit).toBe(0);
    const row = JSON.parse(res.stdout.trim().split('\n')[0] ?? '') as AskJson;
    expect(row.state).toBe('accepted');
    expect(row.mapped_artifact).not.toBeNull();
    expect(row.rejected_reason).toBeNull();
    expect(row.counter_proposal).toBeNull();
    // The mapped child is a real `story` task tagged with the to-team slug.
    const show = withCapture(() =>
      runTaskCmd('show', [row.mapped_artifact as string, undefined], { workspaceRoot: workspace }),
    );
    expect(show.exit).toBe(0);
    const child = JSON.parse(show.stdout.trim()) as {
      task: { id: string; layer: string | null };
      tags: Array<{ tag: string }>;
    };
    expect(child.task.id).toBe(row.mapped_artifact);
    expect(child.task.layer).toBe('story');
    expect(child.tags.map((t) => t.tag)).toContain('identity');
    // The from-team's blocking artifact is now blocked_by the new child.
    const blockedShow = withCapture(() =>
      runTaskCmd('show', ['blocked-1', undefined], { workspaceRoot: workspace }),
    );
    const blocked = JSON.parse(blockedShow.stdout.trim()) as {
      blocked_by: Array<{ from_task_id: string; to_task_id: string }>;
      events: Array<{ kind: string }>;
    };
    expect(blocked.blocked_by.some((d) => d.from_task_id === row.mapped_artifact)).toBe(true);
    expect(blocked.events.some((e) => e.kind === 'ask_responded')).toBe(true);
  });

  test('respond reject records --comment as rejected_reason, no child, exit 0', () => {
    seedAskFixture();
    const filed = fileOneAsk();
    const res = withCapture(() =>
      runAskCmd('respond', [String(filed.id)], {
        verdict: 'reject',
        comment: 'out of scope this milestone',
        workspaceRoot: workspace,
      }),
    );
    expect(res.exit).toBe(0);
    const row = JSON.parse(res.stdout.trim().split('\n')[0] ?? '') as AskJson;
    expect(row.state).toBe('rejected');
    expect(row.rejected_reason).toBe('out of scope this milestone');
    expect(row.mapped_artifact).toBeNull();
    expect(row.counter_proposal).toBeNull();
  });

  test('respond counter records --comment as counter_proposal, no child, exit 0', () => {
    seedAskFixture();
    const filed = fileOneAsk();
    const res = withCapture(() =>
      runAskCmd('respond', [String(filed.id)], {
        verdict: 'counter',
        comment: 'expose a read-only view instead',
        workspaceRoot: workspace,
      }),
    );
    expect(res.exit).toBe(0);
    const row = JSON.parse(res.stdout.trim().split('\n')[0] ?? '') as AskJson;
    expect(row.state).toBe('countered');
    expect(row.counter_proposal).toBe('expose a read-only view instead');
    expect(row.mapped_artifact).toBeNull();
    expect(row.rejected_reason).toBeNull();
  });

  test('respond without a valid --verdict exits 1', () => {
    seedAskFixture();
    const filed = fileOneAsk();
    const res = withCapture(() =>
      runAskCmd('respond', [String(filed.id)], { workspaceRoot: workspace }),
    );
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('--verdict');
  });

  test('respond on an unknown ask id exits 1', () => {
    seedAskFixture();
    const res = withCapture(() =>
      runAskCmd('respond', ['9999'], { verdict: 'accept', workspaceRoot: workspace }),
    );
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain("unknown ask id '9999'");
  });

  test('respond twice on the same ask exits 1 (already responded)', () => {
    seedAskFixture();
    const filed = fileOneAsk();
    withCapture(() =>
      runAskCmd('respond', [String(filed.id)], { verdict: 'reject', workspaceRoot: workspace }),
    );
    const res = withCapture(() =>
      runAskCmd('respond', [String(filed.id)], { verdict: 'accept', workspaceRoot: workspace }),
    );
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain("not 'filed'");
  });

  // --- await: the team-as-workflow-kind mechanical poll ---

  interface AwaitJson {
    ask_id: number;
    phase: string;
    terminal: boolean;
    state: string;
    mapped_artifact: string | null;
    artifact_status: string | null;
    to_team: string;
    outputs: Array<{ name: string; team_slug: string }>;
    reason: string | null;
  }

  /** Run `ask await <id>` and return the parsed JSON report. */
  function awaitAsk(id: number): { res: Captured; report: AwaitJson } {
    const res = withCapture(() => runAskCmd('await', [String(id)], { workspaceRoot: workspace }));
    return { res, report: JSON.parse(res.stdout.trim().split('\n')[0] ?? '') as AwaitJson };
  }

  test('await on a filed ask reports phase=pending, non-terminal, exit 0', () => {
    seedAskFixture();
    const filed = fileOneAsk();
    const { res, report } = awaitAsk(filed.id);
    expect(res.exit).toBe(0);
    expect(report.phase).toBe('pending');
    expect(report.terminal).toBe(false);
    expect(report.to_team).toBe('identity');
    expect(report.outputs).toEqual([]);
  });

  test('await on an accepted-but-not-done ask reports phase=waiting, non-terminal', () => {
    seedAskFixture();
    const filed = fileOneAsk();
    withCapture(() =>
      runAskCmd('respond', [String(filed.id)], { verdict: 'accept', workspaceRoot: workspace }),
    );
    const { res, report } = awaitAsk(filed.id);
    expect(res.exit).toBe(0);
    expect(report.phase).toBe('waiting');
    expect(report.terminal).toBe(false);
    expect(report.mapped_artifact).not.toBeNull();
    expect(report.outputs).toEqual([]);
  });

  test('await on a rejected ask surfaces phase=rejected with the reason (no hang), exit 0', () => {
    seedAskFixture();
    const filed = fileOneAsk();
    withCapture(() =>
      runAskCmd('respond', [String(filed.id)], {
        verdict: 'reject',
        comment: 'out of scope this milestone',
        workspaceRoot: workspace,
      }),
    );
    const { res, report } = awaitAsk(filed.id);
    expect(res.exit).toBe(0);
    expect(report.phase).toBe('rejected');
    expect(report.terminal).toBe(true);
    expect(report.reason).toBe('out of scope this milestone');
    expect(report.outputs).toEqual([]);
  });

  test('await on a countered ask surfaces phase=countered with the reason (no hang), exit 0', () => {
    seedAskFixture();
    const filed = fileOneAsk();
    withCapture(() =>
      runAskCmd('respond', [String(filed.id)], {
        verdict: 'counter',
        comment: 'expose a read-only view instead',
        workspaceRoot: workspace,
      }),
    );
    const { res, report } = awaitAsk(filed.id);
    expect(res.exit).toBe(0);
    expect(report.phase).toBe('countered');
    expect(report.terminal).toBe(true);
    expect(report.reason).toBe('expose a read-only view instead');
  });

  test('await without a valid <ask-id> exits 1', () => {
    seedAskFixture();
    const res = withCapture(() => runAskCmd('await', [undefined], { workspaceRoot: workspace }));
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('<ask-id>');
  });

  test('await on an unknown ask id exits 1', () => {
    seedAskFixture();
    const res = withCapture(() => runAskCmd('await', ['9999'], { workspaceRoot: workspace }));
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain("unknown ask id '9999'");
  });

  test('an unknown ask action exits 1', () => {
    const res = withCapture(() => runAskCmd('bogus', [undefined], { workspaceRoot: workspace }));
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('unknown ask action');
  });
});
