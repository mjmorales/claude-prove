/**
 * End-to-end integration tests for the `prove scrum` CLI topic.
 *
 * Spawns `bun run bin/run.ts scrum <subcommand>` in a tmpdir git repo so
 * the full cac dispatch + stdin/stdout/stderr split + exit code contract
 * is exercised. Covers every subcommand landed in Task 5:
 *   init / status / next-ready / task / milestone / tag / link-run / hook
 *
 * Hook dispatch is smoke-tested at the dispatch-function level — the
 * actual handler shape is owned by Task 4; we assert that `scrum hook
 * <unknown-event>` errors cleanly, and that an empty-stdin invocation
 * returns 0 (matches acb hook-cmd's silent-pass contract).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUN_TS = resolve(__dirname, '..', 'bin', 'run.ts');
const BUN_BIN = process.execPath;

interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runScrum(args: string[], cwd: string, stdin = ''): SpawnResult {
  const proc = Bun.spawnSync({
    cmd: [BUN_BIN, 'run', RUN_TS, 'scrum', ...args],
    cwd,
    stdin: Buffer.from(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, PROVE_RUN_SLUG: '' },
  });
  return {
    exitCode: proc.exitCode ?? -1,
    stdout: proc.stdout?.toString() ?? '',
    stderr: proc.stderr?.toString() ?? '',
  };
}

function runCmd(cmd: string[], cwd: string): void {
  const proc = Bun.spawnSync({ cmd, cwd, stdout: 'pipe', stderr: 'pipe' });
  if (proc.exitCode !== 0) {
    const err = proc.stderr?.toString() ?? '';
    throw new Error(`${cmd.join(' ')} failed (exit ${proc.exitCode}): ${err}`);
  }
}

function initRepo(dir: string): void {
  runCmd(['git', '-c', 'init.defaultBranch=main', 'init', '--quiet'], dir);
  runCmd(['git', 'config', 'user.email', 'test@example.com'], dir);
  runCmd(['git', 'config', 'user.name', 'test'], dir);
  runCmd(['git', 'config', 'commit.gpgsign', 'false'], dir);
  writeFileSync(join(dir, 'README.md'), '# test\n', 'utf8');
  runCmd(['git', 'add', '.'], dir);
  runCmd(['git', 'commit', '--quiet', '-m', 'init'], dir);
}

const tmpDirs: string[] = [];
function trackRepo(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `scrum-int-${label}-`));
  initRepo(dir);
  tmpDirs.push(dir);
  return dir;
}

beforeAll(() => {
  if (!existsSync(RUN_TS)) {
    throw new Error(`bin/run.ts not found at expected path: ${RUN_TS}`);
  }
});

afterAll(() => {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

describe('prove scrum init', () => {
  test('empty planning/: clean no-op with informational stderr', () => {
    const repo = trackRepo('init-empty');
    const res = runScrum(['init'], repo);
    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain('scrum init: nothing to import (planning/ empty or absent)');
    const payload = JSON.parse(res.stdout.trim()) as { seeded: boolean; reason: string };
    expect(payload.seeded).toBe(false);
    expect(payload.reason).toBe('empty');
  });

  test('populated planning/: seeds tasks, deletes legacy files, preserves VISION.md', () => {
    const repo = trackRepo('init-seeded');
    const planning = join(repo, 'planning');
    mkdirSync(planning, { recursive: true });
    writeFileSync(
      join(planning, 'ROADMAP.md'),
      ['# Roadmap', '', '## Milestone: Phase Twelve', '- Build scrum CLI', '- Wire hooks'].join(
        '\n',
      ),
      'utf8',
    );
    writeFileSync(
      join(planning, 'BACKLOG.md'),
      ['# Backlog', '', '- Write docs', '- Polish UX'].join('\n'),
      'utf8',
    );
    writeFileSync(join(planning, 'VISION.md'), '# Vision\n\nShip scrum.\n', 'utf8');

    const res = runScrum(['init', '--workspace-root', repo], repo);
    expect(res.exitCode).toBe(0);
    const payload = JSON.parse(res.stdout.trim()) as {
      seeded: boolean;
      milestones: number;
      tasks: number;
    };
    expect(payload.seeded).toBe(true);
    expect(payload.milestones).toBeGreaterThanOrEqual(1);
    expect(payload.tasks).toBeGreaterThanOrEqual(2);
    expect(existsSync(join(planning, 'ROADMAP.md'))).toBe(false);
    expect(existsSync(join(planning, 'BACKLOG.md'))).toBe(false);
    expect(existsSync(join(planning, 'VISION.md'))).toBe(true);
  });

  test('idempotent second run: no-op, reports already-seeded', () => {
    const repo = trackRepo('init-idempotent');
    mkdirSync(join(repo, 'planning'), { recursive: true });
    writeFileSync(
      join(repo, 'planning', 'BACKLOG.md'),
      ['- Task one', '- Task two'].join('\n'),
      'utf8',
    );
    const first = runScrum(['init', '--workspace-root', repo], repo);
    expect(first.exitCode).toBe(0);
    const second = runScrum(['init', '--workspace-root', repo], repo);
    expect(second.exitCode).toBe(0);
    const payload = JSON.parse(second.stdout.trim()) as { seeded: boolean; reason: string };
    expect(payload.seeded).toBe(false);
    expect(payload.reason).toBe('already-seeded');
  });
});

// ---------------------------------------------------------------------------
// task + milestone + tag + link-run lifecycle
// ---------------------------------------------------------------------------

describe('prove scrum task lifecycle', () => {
  test('create -> show -> list -> tag -> link-decision flow', () => {
    const repo = trackRepo('task-lifecycle');

    // Seed a milestone so --milestone resolves.
    const mCreate = runScrum(
      ['milestone', 'create', '--title', 'Phase 12', '--id', 'phase-12'],
      repo,
    );
    expect(mCreate.exitCode).toBe(0);
    const milestone = JSON.parse(mCreate.stdout.trim()) as { id: string; status: string };
    expect(milestone.id).toBe('phase-12');
    expect(milestone.status).toBe('planned');

    // Create a task under the milestone.
    const tCreate = runScrum(
      ['task', 'create', '--title', 'Ship it', '--id', 'ship-it', '--milestone', 'phase-12'],
      repo,
    );
    expect(tCreate.exitCode).toBe(0);
    const task = JSON.parse(tCreate.stdout.trim()) as { id: string; milestone_id: string | null };
    expect(task.id).toBe('ship-it');
    expect(task.milestone_id).toBe('phase-12');

    // Show the task (JSON bundle of task + tags + events + runs).
    const tShow = runScrum(['task', 'show', 'ship-it'], repo);
    expect(tShow.exitCode).toBe(0);
    const showPayload = JSON.parse(tShow.stdout.trim()) as {
      task: { id: string };
      tags: unknown[];
      events: unknown[];
    };
    expect(showPayload.task.id).toBe('ship-it');
    expect(Array.isArray(showPayload.tags)).toBe(true);
    expect(showPayload.events.length).toBeGreaterThanOrEqual(1);

    // Tag + list by tag.
    const tTag = runScrum(['task', 'tag', 'ship-it', 'p0'], repo);
    expect(tTag.exitCode).toBe(0);
    const tList = runScrum(['task', 'list', '--tag', 'p0'], repo);
    expect(tList.exitCode).toBe(0);
    const listed = JSON.parse(tList.stdout.trim()) as Array<{ id: string }>;
    expect(listed.some((t) => t.id === 'ship-it')).toBe(true);

    // Link a decision.
    const tLinkDec = runScrum(
      ['task', 'link-decision', 'ship-it', '.prove/decisions/2026-04-23-scrum.md'],
      repo,
    );
    expect(tLinkDec.exitCode).toBe(0);
    const linked = JSON.parse(tLinkDec.stdout.trim()) as {
      linked: boolean;
      event_id: number;
    };
    expect(linked.linked).toBe(true);
    expect(typeof linked.event_id).toBe('number');

    // Link a run retroactively.
    const lRun = runScrum(
      ['link-run', 'ship-it', '.prove/runs/main/ship-it/', '--branch', 'main'],
      repo,
    );
    expect(lRun.exitCode).toBe(0);
    const linkRunPayload = JSON.parse(lRun.stdout.trim()) as {
      linked: boolean;
      task_id: string;
      run_path: string;
    };
    expect(linkRunPayload.linked).toBe(true);
    expect(linkRunPayload.task_id).toBe('ship-it');
  });

  test('task create without --title: exit 1', () => {
    const repo = trackRepo('task-no-title');
    const res = runScrum(['task', 'create'], repo);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain('--title is required');
  });

  test('task show with unknown id: exit 1', () => {
    const repo = trackRepo('task-unknown');
    const res = runScrum(['task', 'show', 'nope'], repo);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("task 'nope' not found");
  });
});

// ---------------------------------------------------------------------------
// status + next-ready
// ---------------------------------------------------------------------------

describe('prove scrum status', () => {
  test('default JSON shape has the three documented keys', () => {
    const repo = trackRepo('status-json');
    // Seed a single task so there's something to report.
    const created = runScrum(['task', 'create', '--title', 'A', '--id', 'a'], repo);
    expect(created.exitCode).toBe(0);

    const res = runScrum(['status'], repo);
    expect(res.exitCode).toBe(0);
    const payload = JSON.parse(res.stdout.trim()) as {
      active_tasks: unknown[];
      milestones: unknown[];
      recent_events: unknown[];
    };
    expect(Array.isArray(payload.active_tasks)).toBe(true);
    expect(Array.isArray(payload.milestones)).toBe(true);
    expect(Array.isArray(payload.recent_events)).toBe(true);
    expect(payload.active_tasks.length).toBeGreaterThanOrEqual(1);
  });

  test('--human emits a text table on stdout', () => {
    const repo = trackRepo('status-human');
    const res = runScrum(['status', '--human'], repo);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('Active tasks');
    expect(res.stdout).toContain('Active milestones');
    expect(res.stdout).toContain('Recent events');
  });
});

describe('prove scrum next-ready', () => {
  test('returns ranked JSON array by default', () => {
    const repo = trackRepo('nr-default');
    // Seed two ready tasks so nextReady has candidates.
    for (const id of ['a', 'b']) {
      const created = runScrum(['task', 'create', '--title', id, '--id', id], repo);
      expect(created.exitCode).toBe(0);
    }
    const res = runScrum(['next-ready', '--limit', '5'], repo);
    expect(res.exitCode).toBe(0);
    const rows = JSON.parse(res.stdout.trim()) as Array<{
      task: { id: string };
      score: number;
      rationale: { unblock_depth: number };
    }>;
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(typeof rows[0]?.score).toBe('number');
    expect(rows[0]?.rationale.unblock_depth).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// milestone close + status-filtered list
// ---------------------------------------------------------------------------

describe('prove scrum milestone', () => {
  test('create -> list -> show -> close flow', () => {
    const repo = trackRepo('mlstone-flow');
    runScrum(['milestone', 'create', '--title', 'M1', '--id', 'm1'], repo);

    const list = runScrum(['milestone', 'list'], repo);
    expect(list.exitCode).toBe(0);
    const rows = JSON.parse(list.stdout.trim()) as Array<{ id: string; status: string }>;
    expect(rows.some((m) => m.id === 'm1')).toBe(true);

    const show = runScrum(['milestone', 'show', 'm1'], repo);
    expect(show.exitCode).toBe(0);
    const detail = JSON.parse(show.stdout.trim()) as {
      milestone: { id: string; status: string };
      tasks: unknown[];
    };
    expect(detail.milestone.id).toBe('m1');

    const close = runScrum(['milestone', 'close', 'm1'], repo);
    expect(close.exitCode).toBe(0);
    const closed = JSON.parse(close.stdout.trim()) as { id: string; status: string };
    expect(closed.status).toBe('closed');
  });
});

// ---------------------------------------------------------------------------
// tag add/remove/list
// ---------------------------------------------------------------------------

describe('prove scrum tag', () => {
  test('add -> list -> remove round-trip', () => {
    const repo = trackRepo('tag-flow');
    runScrum(['task', 'create', '--title', 'T', '--id', 't'], repo);

    const add = runScrum(['tag', 'add', 't', 'urgent'], repo);
    expect(add.exitCode).toBe(0);

    const listByTask = runScrum(['tag', 'list', '--task', 't'], repo);
    expect(listByTask.exitCode).toBe(0);
    const taskTags = JSON.parse(listByTask.stdout.trim()) as Array<{ tag: string }>;
    expect(taskTags.some((r) => r.tag === 'urgent')).toBe(true);

    const listByTag = runScrum(['tag', 'list', '--tag', 'urgent'], repo);
    expect(listByTag.exitCode).toBe(0);
    const taggedTasks = JSON.parse(listByTag.stdout.trim()) as Array<{ id: string }>;
    expect(taggedTasks.some((t) => t.id === 't')).toBe(true);

    const remove = runScrum(['tag', 'remove', 't', 'urgent'], repo);
    expect(remove.exitCode).toBe(0);
  });

  test('tag list without --task or --tag: exit 1', () => {
    const repo = trackRepo('tag-no-filter');
    const res = runScrum(['tag', 'list'], repo);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain('--task or --tag is required');
  });
});

// ---------------------------------------------------------------------------
// link-run standalone
// ---------------------------------------------------------------------------

describe('prove scrum link-run', () => {
  test('missing positional: exit 1', () => {
    const repo = trackRepo('lr-missing');
    const res = runScrum(['link-run'], repo);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain('<task-id> positional argument required');
  });

  test('unknown task: exit 1', () => {
    const repo = trackRepo('lr-unknown');
    const res = runScrum(['link-run', 'ghost', '.prove/runs/x/'], repo);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("unknown task 'ghost'");
  });
});

// ---------------------------------------------------------------------------
// hook — dispatch-function smoke
// ---------------------------------------------------------------------------

describe('prove scrum hook', () => {
  test('unknown event: exit 1 with guidance', () => {
    const repo = trackRepo('hook-bad-event');
    const res = runScrum(['hook', 'not-a-real-event'], repo);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain('unknown hook event');
  });

  test('empty stdin: silent pass (exit 0) even without Task 4 handlers', () => {
    const repo = trackRepo('hook-empty');
    const res = runScrum(['hook', 'session-start'], repo, '');
    // Empty stdin short-circuits before the handler is invoked, so the
    // Task-4-not-yet-available throw is never reached.
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe('');
  });

  test('malformed JSON on stdin: silent pass (exit 0)', () => {
    const repo = trackRepo('hook-bad-json');
    const res = runScrum(['hook', 'stop'], repo, 'not json');
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe('');
  });

  test('valid JSON dispatch: onStop exits 0 on success', () => {
    const repo = trackRepo('hook-stop');
    const res = runScrum(['hook', 'stop'], repo, JSON.stringify({ cwd: repo }));
    expect(res.exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// --workspace-root threading — regression for review-round-2 blocking finding
// ---------------------------------------------------------------------------

describe('prove scrum --workspace-root', () => {
  test('writes land in --workspace-root repo, not cwd', () => {
    // repoA is the target workspace; repoB is where we invoke the CLI from.
    // Before the fix, every handler bare-called openScrumStore() which
    // resolved via process.cwd() -> repoB, silently ignoring the flag.
    const repoA = trackRepo('wsroot-target');
    const repoB = trackRepo('wsroot-cwd');

    const created = runScrum(
      ['task', 'create', '--title', 'routed task', '--id', 'routed', '--workspace-root', repoA],
      repoB,
    );
    expect(created.exitCode).toBe(0);

    // The DB must be written under repoA, never repoB.
    expect(existsSync(join(repoA, '.prove', 'prove.db'))).toBe(true);
    expect(existsSync(join(repoB, '.prove', 'prove.db'))).toBe(false);

    // And a subsequent read from repoB with --workspace-root repoA must
    // see the row — otherwise the flag isn't threaded on the read path.
    const shown = runScrum(['task', 'show', 'routed', '--workspace-root', repoA], repoB);
    expect(shown.exitCode).toBe(0);
    const payload = JSON.parse(shown.stdout.trim()) as { task: { id: string } };
    expect(payload.task.id).toBe('routed');
  });
});

// ---------------------------------------------------------------------------
// Unknown action
// ---------------------------------------------------------------------------

describe('prove scrum unknown action', () => {
  test('unknown action exits 1 with guidance', () => {
    const repo = trackRepo('scrum-bogus');
    const res = runScrum(['bogus'], repo);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("unknown scrum action 'bogus'");
  });
});
