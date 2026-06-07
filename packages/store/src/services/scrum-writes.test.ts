/**
 * Tests for the scrum transition write-service. Each test opens a fresh
 * tmp-path store (auto-migrated against a scrum schema registered for the
 * test), seeds tasks via direct INSERTs, and exercises `updateTaskStatus`.
 *
 * The scrum domain schema lives in the CLI package, not here, so these tests
 * register a minimal scrum schema covering exactly the tables the transition
 * write touches (`scrum_tasks`, `scrum_events`, `scrum_run_links`). That keeps
 * the store package free of any `@claude-prove/cli` import while still proving
 * the write against real migrated tables.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Store, openStore } from '../connection';
import { runMigrations } from '../migrate';
import { clearRegistry, registerSchema } from '../registry';
import { type Acceptance, type TaskStatus, updateTaskStatus } from './scrum-writes';

// Minimal scrum schema — only the three tables the transition write reads and
// writes, with every column the service stamps. Mirrors the shape the full CLI
// scrum migrations produce, narrowed to this service's surface.
const SCRUM_TEST_SCHEMA_SQL = `
CREATE TABLE scrum_tasks (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    layer TEXT,
    acceptance_json TEXT,
    milestone_id TEXT,
    created_at TEXT NOT NULL,
    last_event_at TEXT,
    last_modified_by TEXT,
    last_modified_at TEXT,
    worker_id TEXT,
    run_id TEXT,
    deleted_at TEXT
);

CREATE TABLE scrum_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    ts TEXT NOT NULL,
    kind TEXT NOT NULL,
    agent TEXT,
    payload_json TEXT NOT NULL
);

CREATE TABLE scrum_run_links (
    task_id TEXT NOT NULL,
    run_path TEXT NOT NULL,
    branch TEXT,
    slug TEXT,
    linked_at TEXT NOT NULL,
    PRIMARY KEY (task_id, run_path)
);
`;

interface SeedTaskOptions {
  status?: TaskStatus;
  layer?: 'epic' | 'story' | 'task' | null;
  acceptance?: Acceptance | null;
}

let store: Store;
let tmpDir: string;

beforeEach(async () => {
  clearRegistry();
  registerSchema({
    domain: 'scrum',
    migrations: [
      {
        version: 1,
        description: 'scrum transition test schema',
        up: (s) => s.exec(SCRUM_TEST_SCHEMA_SQL),
      },
    ],
  });
  tmpDir = mkdtempSync(join(tmpdir(), 'scrum-writes-'));
  store = await openStore({ path: join(tmpDir, '.prove', 'prove.db') });
  await runMigrations(store);
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
  clearRegistry();
});

async function seedTask(id: string, opts: SeedTaskOptions = {}): Promise<void> {
  const status = opts.status ?? 'backlog';
  const layer = opts.layer === undefined ? null : opts.layer;
  const acceptance = opts.acceptance === undefined ? null : opts.acceptance;
  const now = '2026-06-01T00:00:00Z';
  await store.run(
    'INSERT INTO scrum_tasks (id, status, layer, acceptance_json, created_at, last_event_at, last_modified_by, last_modified_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)',
    [
      id,
      status,
      layer,
      acceptance === null ? null : JSON.stringify(acceptance),
      now,
      now,
      null,
      now,
    ],
  );
}

async function eventCount(taskId: string, kind?: string): Promise<number> {
  const sql = kind
    ? 'SELECT COUNT(*) AS n FROM scrum_events WHERE task_id = ? AND kind = ?'
    : 'SELECT COUNT(*) AS n FROM scrum_events WHERE task_id = ?';
  const params = kind ? [taskId, kind] : [taskId];
  const rows = await store.all<{ n: number }>(sql, params);
  return (rows[0]?.n ?? 0) as number;
}

// A satisfied gate criterion clears both story acceptance floors without git or
// run context — the human verdict is standing state.
const satisfiedGateCriterion: Acceptance = {
  criteria: [
    {
      id: 'c1',
      text: 'approved by reviewer',
      verifies_by: 'gate',
      check: '',
      status: 'active',
      idempotent: true,
      gate: { verdict: 'approved' },
    },
  ],
};

describe('updateTaskStatus — valid transition', () => {
  test('emits exactly one status_changed event with payload {from,to} and updates the row', async () => {
    await seedTask('t1', { status: 'backlog' });
    const before = await eventCount('t1', 'status_changed');
    expect(before).toBe(0);

    const updated = await updateTaskStatus(store, 't1', 'ready', 'agent-x');
    expect(updated.status).toBe('ready');

    expect(await eventCount('t1', 'status_changed')).toBe(1);
    const ev = (
      await store.all<{ agent: string | null; payload_json: string }>(
        "SELECT agent, payload_json FROM scrum_events WHERE task_id = ? AND kind = 'status_changed'",
        ['t1'],
      )
    )[0];
    expect(ev?.agent).toBe('agent-x');
    expect(JSON.parse(ev?.payload_json ?? '{}')).toEqual({ from: 'backlog', to: 'ready' });

    const row = (
      await store.all<{ status: string; last_modified_by: string | null }>(
        'SELECT status, last_modified_by FROM scrum_tasks WHERE id = ?',
        ['t1'],
      )
    )[0];
    expect(row?.status).toBe('ready');
    expect(row?.last_modified_by).toBe('agent-x');
  });
});

describe('updateTaskStatus — invalid transition', () => {
  test('throws and emits zero events', async () => {
    await seedTask('t1', { status: 'backlog' });
    await expect(updateTaskStatus(store, 't1', 'done')).rejects.toThrow(/invalid transition/);
    expect(await eventCount('t1')).toBe(0);
  });

  test('unknown task id throws and writes nothing', async () => {
    await expect(updateTaskStatus(store, 'nope', 'ready')).rejects.toThrow(/unknown task/);
    expect(await eventCount('nope')).toBe(0);
  });

  test('terminal status rejects every outgoing edge', async () => {
    await seedTask('t1', { status: 'done' });
    await expect(updateTaskStatus(store, 't1', 'in_progress')).rejects.toThrow(
      /invalid transition/,
    );
    expect(await eventCount('t1', 'status_changed')).toBe(0);
  });
});

describe('updateTaskStatus — story acceptance floor', () => {
  test('story with zero active criteria is rejected into ready', async () => {
    await seedTask('s', { status: 'backlog', layer: 'story', acceptance: null });
    await expect(updateTaskStatus(store, 's', 'ready')).rejects.toThrow(
      /no active acceptance criteria/,
    );
    expect(await eventCount('s', 'status_changed')).toBe(0);
  });

  test('story with zero active criteria is rejected into in_progress', async () => {
    await seedTask('s', { status: 'backlog', layer: 'story', acceptance: null });
    await expect(updateTaskStatus(store, 's', 'in_progress')).rejects.toThrow(
      /no active acceptance criteria/,
    );
  });

  test('story with zero active criteria is rejected into done', async () => {
    // Reach in_progress without the floor by seeding it there directly, then
    // attempt the close — the floor must still reject the empty-criteria story.
    await seedTask('s', { status: 'in_progress', layer: 'story', acceptance: null });
    await expect(updateTaskStatus(store, 's', 'done')).rejects.toThrow(
      /no active acceptance criteria/,
    );
    expect(await eventCount('s', 'status_changed')).toBe(0);
  });

  test('story passes into in_progress once it carries an active applicable criterion', async () => {
    await seedTask('s', { status: 'backlog', layer: 'story', acceptance: satisfiedGateCriterion });
    await expect(updateTaskStatus(store, 's', 'in_progress')).resolves.toBeDefined();
    expect(
      (await store.all<{ status: string }>('SELECT status FROM scrum_tasks WHERE id = ?', ['s']))[0]
        ?.status,
    ).toBe('in_progress');
  });

  test('a descendants-scoped criterion does not satisfy the parent floor', async () => {
    await seedTask('s', {
      status: 'backlog',
      layer: 'story',
      acceptance: {
        criteria: [
          {
            id: 'd1',
            text: 'children only',
            verifies_by: 'gate',
            check: '',
            status: 'active',
            idempotent: true,
            scope: 'descendants',
            gate: { verdict: 'approved' },
          },
        ],
      },
    });
    await expect(updateTaskStatus(store, 's', 'ready')).rejects.toThrow(
      /no active acceptance criteria/,
    );
  });

  test('an unsatisfied criterion blocks the close even though it clears the count', async () => {
    await seedTask('s', {
      status: 'in_progress',
      layer: 'story',
      acceptance: {
        criteria: [
          {
            id: 'g1',
            text: 'pending gate',
            verifies_by: 'gate',
            check: '',
            status: 'active',
            idempotent: true,
            gate: { verdict: 'gate_pending' },
          },
        ],
      },
    });
    await expect(updateTaskStatus(store, 's', 'done')).rejects.toThrow(
      /unsatisfied acceptance criteria/,
    );
    expect(await eventCount('s', 'status_changed')).toBe(0);
  });
});

describe('updateTaskStatus — story synthesis floor', () => {
  function writeSynthesis(runDir: string, agent = 'worker'): void {
    const dir = join(runDir, 'log', agent);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `synth-${agent}.json`),
      `${JSON.stringify({
        id: `synth-${agent}`,
        ts: '2026-06-01T00:00:00Z',
        type: 'synthesis',
        agent,
        run_path: runDir,
        body: 'episode wrapped',
        outcome: 'shipped',
      })}\n`,
      'utf8',
    );
  }

  async function seedStartedStory(id: string): Promise<void> {
    await seedTask(id, {
      status: 'in_progress',
      layer: 'story',
      acceptance: satisfiedGateCriterion,
    });
  }

  test('story with a linked run but no synthesis entry is rejected into done', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'scrum-synth-'));
    try {
      await seedStartedStory('s');
      await store.run(
        'INSERT INTO scrum_run_links (task_id, run_path, linked_at) VALUES (?, ?, ?)',
        ['s', runDir, '2026-06-01T00:00:00Z'],
      );
      await expect(updateTaskStatus(store, 's', 'done')).rejects.toThrow(
        /no synthesis reasoning-log entry/,
      );
      expect(await eventCount('s', 'status_changed')).toBe(0);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  test('story with no linked run is exempt (no worker engaged)', async () => {
    await seedStartedStory('s');
    await expect(updateTaskStatus(store, 's', 'done')).resolves.toBeDefined();
    expect(
      (await store.all<{ status: string }>('SELECT status FROM scrum_tasks WHERE id = ?', ['s']))[0]
        ?.status,
    ).toBe('done');
  });

  test('story passes into done once its most-recent run carries a synthesis entry', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'scrum-synth-'));
    try {
      await seedStartedStory('s');
      writeSynthesis(runDir);
      await store.run(
        'INSERT INTO scrum_run_links (task_id, run_path, linked_at) VALUES (?, ?, ?)',
        ['s', runDir, '2026-06-01T00:00:00Z'],
      );
      await expect(updateTaskStatus(store, 's', 'done')).resolves.toBeDefined();
      expect(await eventCount('s', 'status_changed')).toBe(1);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  function writeRawEntry(runDir: string, agent: string, fileStem: string, json: string): void {
    const dir = join(runDir, 'log', agent);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${fileStem}.json`), `${json}\n`, 'utf8');
  }

  test('a schema-invalid synthesis entry (missing outcome) fails the floor closed', async () => {
    // The entry IS type:'synthesis' but omits the required `outcome` field. A
    // lenient `.type === 'synthesis'` scan would wave the close through; the
    // strict read must THROW on the schema-invalid entry so the floor rejects.
    const runDir = mkdtempSync(join(tmpdir(), 'scrum-synth-bad-'));
    try {
      await seedStartedStory('s');
      writeRawEntry(
        runDir,
        'worker',
        'synth-no-outcome',
        JSON.stringify({
          id: 'synth-no-outcome',
          ts: '2026-06-01T00:00:00Z',
          type: 'synthesis',
          agent: 'worker',
          run_path: runDir,
          body: 'episode wrapped',
          // outcome intentionally omitted — required on synthesis entries.
        }),
      );
      await store.run(
        'INSERT INTO scrum_run_links (task_id, run_path, linked_at) VALUES (?, ?, ?)',
        ['s', runDir, '2026-06-01T00:00:00Z'],
      );
      await expect(updateTaskStatus(store, 's', 'done')).rejects.toThrow(
        /no synthesis reasoning-log entry/,
      );
      expect(await eventCount('s', 'status_changed')).toBe(0);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  test('a malformed non-synthesis entry alongside a valid synthesis entry fails the floor closed', async () => {
    // A valid synthesis entry is present, but a SEPARATE non-synthesis file is
    // malformed JSON. The strict read walks every file and THROWS on the bad one
    // before the synthesis match is decided, so the floor must reject rather than
    // pass on the valid entry it would otherwise have found.
    const runDir = mkdtempSync(join(tmpdir(), 'scrum-synth-mixed-'));
    try {
      await seedStartedStory('s');
      writeSynthesis(runDir, 'aaa-worker'); // valid synthesis, sorts first by agent
      writeRawEntry(runDir, 'zzz-worker', 'broken', '{ not valid json');
      await store.run(
        'INSERT INTO scrum_run_links (task_id, run_path, linked_at) VALUES (?, ?, ?)',
        ['s', runDir, '2026-06-01T00:00:00Z'],
      );
      await expect(updateTaskStatus(store, 's', 'done')).rejects.toThrow(
        /no synthesis reasoning-log entry/,
      );
      expect(await eventCount('s', 'status_changed')).toBe(0);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  test('only the most-recent linked run is consulted for synthesis', async () => {
    const olderRun = mkdtempSync(join(tmpdir(), 'scrum-synth-old-'));
    const newerRun = mkdtempSync(join(tmpdir(), 'scrum-synth-new-'));
    try {
      await seedStartedStory('s');
      writeSynthesis(olderRun); // synthesis on the OLD run only
      await store.run(
        'INSERT INTO scrum_run_links (task_id, run_path, linked_at) VALUES (?, ?, ?)',
        ['s', olderRun, '2026-01-01T00:00:00Z'],
      );
      await store.run(
        'INSERT INTO scrum_run_links (task_id, run_path, linked_at) VALUES (?, ?, ?)',
        ['s', newerRun, '2026-02-01T00:00:00Z'],
      );
      await expect(updateTaskStatus(store, 's', 'done')).rejects.toThrow(/no synthesis/);
    } finally {
      rmSync(olderRun, { recursive: true, force: true });
      rmSync(newerRun, { recursive: true, force: true });
    }
  });
});
