/**
 * Tests for the `nightshift` topic — night lifecycle, deadline resolution,
 * heartbeat lease (fresh contention + stale takeover), floor counters, and
 * the append-only ledger. Each test drives `runNightshift` against a temp
 * project root with an injected clock — no mocking of the filesystem.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type NightshiftOpts, runNightshift } from './nightshift/manage';
import { nightPaths, readLedger, readNight, resolveDeadline } from './nightshift/state';

let root: string;
let stdoutBuf: string;
let stderrBuf: string;

const T0 = new Date('2026-01-10T23:00:00.000Z');

function at(offsetSeconds: number): Date {
  return new Date(T0.getTime() + offsetSeconds * 1000);
}

function run(opts: Omit<NightshiftOpts, 'projectRoot'>): {
  exit: number;
  out: Record<string, unknown>;
  stderr: string;
} {
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  stdoutBuf = '';
  stderrBuf = '';
  process.stdout.write = ((c: string | Uint8Array) => {
    stdoutBuf += typeof c === 'string' ? c : Buffer.from(c).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => {
    stderrBuf += typeof c === 'string' ? c : Buffer.from(c).toString('utf8');
    return true;
  }) as typeof process.stderr.write;
  try {
    const exit = runNightshift({ ...opts, projectRoot: root });
    const out = stdoutBuf.trim() ? JSON.parse(stdoutBuf.trim()) : {};
    return { exit, out, stderr: stderrBuf };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

function enableNight(overrides: Partial<NightshiftOpts> = {}): void {
  const res = run({ action: 'enable', milestone: 'm1', now: T0, ...overrides });
  expect(res.exit).toBe(0);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nightshift-test-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('enable / disable', () => {
  test('enable writes an active night with defaults and an enabled ledger row', () => {
    enableNight();
    const night = readNight(nightPaths(root));
    expect(night?.status).toBe('active');
    expect(night?.milestone).toBe('m1');
    expect(night?.task_cap).toBe(10);
    expect(night?.max_heals_per_pr).toBe(2);
    expect(night?.max_parked).toBe(3);
    const ledger = readLedger(nightPaths(root));
    expect(ledger.map((r) => r.event)).toEqual(['enabled']);
  });

  test('enable requires --milestone', () => {
    const res = run({ action: 'enable', now: T0 });
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('--milestone');
  });

  test('enable rejects a second open night', () => {
    enableNight();
    const res = run({ action: 'enable', milestone: 'm2', now: at(60) });
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('disable it first');
  });

  test('enable after disable archives the closed night and starts clean', () => {
    enableNight();
    run({ action: 'disable', now: at(60) });
    const res = run({ action: 'enable', milestone: 'm2', now: at(120) });
    expect(res.exit).toBe(0);
    const paths = nightPaths(root);
    expect(readNight(paths)?.milestone).toBe('m2');
    expect(readLedger(paths)).toHaveLength(1);
    const archived = readdirSync(paths.historyDir);
    expect(archived.some((f) => f.endsWith('.json'))).toBe(true);
    expect(archived.some((f) => f.endsWith('.ledger.jsonl'))).toBe(true);
  });

  test('disable closes the night and removes the lease', () => {
    enableNight();
    run({ action: 'lease', subaction: 'acquire', holder: 'tick-1', now: at(10) });
    const res = run({ action: 'disable', now: at(60) });
    expect(res.exit).toBe(0);
    expect(readNight(nightPaths(root))?.status).toBe('closed');
    expect(existsSync(nightPaths(root).lease)).toBe(false);
  });

  test('disable without an open night is a usage error', () => {
    const res = run({ action: 'disable', now: T0 });
    expect(res.exit).toBe(1);
  });
});

describe('deadline resolution', () => {
  test('deadline later the same day resolves to the same day', () => {
    const from = new Date('2026-01-10T06:00:00');
    const deadline = resolveDeadline(from, '07:00');
    expect(deadline?.getDate()).toBe(from.getDate());
    expect(deadline?.getHours()).toBe(7);
  });

  test('deadline earlier than now crosses midnight to the next day', () => {
    const from = new Date('2026-01-10T23:10:00');
    const deadline = resolveDeadline(from, '07:00');
    expect(deadline?.getDate()).toBe(11);
    expect(deadline?.getHours()).toBe(7);
  });

  test('invalid deadline spec is rejected at enable', () => {
    const res = run({ action: 'enable', milestone: 'm1', deadline: '25:99', now: T0 });
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('invalid --deadline');
  });
});

describe('lease', () => {
  test('acquire on an open night succeeds and status reports it fresh', () => {
    enableNight();
    const res = run({ action: 'lease', subaction: 'acquire', holder: 'tick-1', now: at(10) });
    expect(res.exit).toBe(0);
    expect(res.out.acquired).toBe(true);
    expect(res.out.stale_takeover).toBe(false);

    const status = run({ action: 'status', now: at(20) });
    const lease = status.out.lease as { holder: string; fresh: boolean };
    expect(lease.holder).toBe('tick-1');
    expect(lease.fresh).toBe(true);
  });

  test('acquire without an open night fails', () => {
    const res = run({ action: 'lease', subaction: 'acquire', holder: 'tick-1', now: T0 });
    expect(res.exit).toBe(1);
  });

  test('fresh lease blocks a second holder with exit 1', () => {
    enableNight();
    run({ action: 'lease', subaction: 'acquire', holder: 'tick-1', now: at(10) });
    const res = run({ action: 'lease', subaction: 'acquire', holder: 'tick-2', now: at(60) });
    expect(res.exit).toBe(1);
    expect(res.out.acquired).toBe(false);
    expect(res.out.holder).toBe('tick-1');
  });

  test('stale lease is taken over and reports the previous holder', () => {
    enableNight();
    run({
      action: 'lease',
      subaction: 'acquire',
      holder: 'tick-1',
      ttlSeconds: 300,
      now: at(10),
    });
    const res = run({ action: 'lease', subaction: 'acquire', holder: 'tick-2', now: at(400) });
    expect(res.exit).toBe(0);
    expect(res.out.acquired).toBe(true);
    expect(res.out.stale_takeover).toBe(true);
    expect(res.out.previous_holder).toBe('tick-1');
  });

  test('heartbeat extends freshness; wrong holder is rejected', () => {
    enableNight();
    run({
      action: 'lease',
      subaction: 'acquire',
      holder: 'tick-1',
      ttlSeconds: 300,
      now: at(10),
    });
    expect(
      run({ action: 'lease', subaction: 'heartbeat', holder: 'tick-1', now: at(250) }).exit,
    ).toBe(0);
    // 300s TTL measured from the heartbeat at t=250, so t=400 is still fresh.
    const contended = run({
      action: 'lease',
      subaction: 'acquire',
      holder: 'tick-2',
      now: at(400),
    });
    expect(contended.exit).toBe(1);
    expect(
      run({ action: 'lease', subaction: 'heartbeat', holder: 'tick-2', now: at(410) }).exit,
    ).toBe(1);
  });

  test('release requires the holding identity unless forced', () => {
    enableNight();
    run({ action: 'lease', subaction: 'acquire', holder: 'tick-1', now: at(10) });
    expect(run({ action: 'lease', subaction: 'release', holder: 'tick-2', now: at(20) }).exit).toBe(
      1,
    );
    expect(
      run({ action: 'lease', subaction: 'release', holder: 'tick-2', force: true, now: at(30) })
        .exit,
    ).toBe(0);
    expect(existsSync(nightPaths(root).lease)).toBe(false);
  });
});

describe('record + floors', () => {
  test('unknown and lifecycle-owned events are rejected', () => {
    enableNight();
    expect(run({ action: 'record', subaction: 'not-a-thing', now: at(10) }).exit).toBe(1);
    expect(run({ action: 'record', subaction: 'enabled', now: at(10) }).exit).toBe(1);
  });

  test('task-started counts toward the task cap', () => {
    enableNight({ taskCap: 2 });
    run({ action: 'record', subaction: 'task-started', task: 't1', now: at(10) });
    const second = run({ action: 'record', subaction: 'task-started', task: 't2', now: at(20) });
    const floors = second.out.floors as { task_cap_reached: boolean; can_start_task: boolean };
    expect(floors.task_cap_reached).toBe(true);
    expect(floors.can_start_task).toBe(false);
  });

  test('heal-attempt requires --pr and the cap allows exactly max executed heals', () => {
    enableNight();
    expect(run({ action: 'record', subaction: 'heal-attempt', now: at(10) }).exit).toBe(1);

    // Driver records before acting: attempts 1 and 2 may execute (default max
    // 2); recording attempt 3 reports the cap exhausted — park, don't heal.
    const first = run({ action: 'record', subaction: 'heal-attempt', pr: '42', now: at(20) });
    expect((first.out.heal as { cap_reached: boolean }).cap_reached).toBe(false);
    const second = run({ action: 'record', subaction: 'heal-attempt', pr: '42', now: at(30) });
    expect((second.out.heal as { attempts: number }).attempts).toBe(2);
    expect((second.out.heal as { cap_reached: boolean }).cap_reached).toBe(false);
    const third = run({ action: 'record', subaction: 'heal-attempt', pr: '42', now: at(40) });
    expect((third.out.heal as { attempts: number }).attempts).toBe(3);
    expect((third.out.heal as { cap_reached: boolean }).cap_reached).toBe(true);

    const other = run({ action: 'record', subaction: 'heal-attempt', pr: '43', now: at(50) });
    expect((other.out.heal as { cap_reached: boolean }).cap_reached).toBe(false);
  });

  test('parked floor halts the night', () => {
    enableNight({ maxParked: 2 });
    run({ action: 'record', subaction: 'task-parked', task: 't1', now: at(10) });
    const second = run({ action: 'record', subaction: 'task-parked', task: 't2', now: at(20) });
    const floors = second.out.floors as { parked_floor_tripped: boolean; halt: boolean };
    expect(floors.parked_floor_tripped).toBe(true);
    expect(floors.halt).toBe(true);
    expect(readNight(nightPaths(root))?.status).toBe('halted');
    expect(readNight(nightPaths(root))?.halt_reason).toContain('parked-floor');
  });

  test('explicit halted event halts with the given detail', () => {
    enableNight();
    const res = run({
      action: 'record',
      subaction: 'halted',
      detail: 'trunk red from human commit',
      now: at(10),
    });
    expect((res.out.floors as { halt: boolean }).halt).toBe(true);
    expect(readNight(nightPaths(root))?.halt_reason).toBe('trunk red from human commit');
  });

  test('past deadline blocks new task starts but does not halt', () => {
    enableNight({ deadline: '07:00' });
    const night = readNight(nightPaths(root));
    const pastDeadline = new Date(Date.parse(night?.deadline_at as string) + 60_000);
    const res = run({ action: 'record', subaction: 'task-landed', now: pastDeadline });
    const floors = res.out.floors as {
      past_deadline: boolean;
      can_start_task: boolean;
      halt: boolean;
    };
    expect(floors.past_deadline).toBe(true);
    expect(floors.can_start_task).toBe(false);
    expect(floors.halt).toBe(false);
  });

  test('ledger accumulates rows append-only with task/pr/detail', () => {
    enableNight();
    run({ action: 'record', subaction: 'task-started', task: 't1', now: at(10) });
    run({ action: 'record', subaction: 'trunk-red', detail: 'gate red on main', now: at(20) });
    const res = run({ action: 'ledger', now: at(30) });
    const rows = res.out as unknown as Array<{ event: string; task: string | null }>;
    expect(rows.map((r) => r.event)).toEqual(['enabled', 'task-started', 'trunk-red']);
    expect(rows[1]?.task).toBe('t1');
  });

  test('record after disable is a usage error', () => {
    enableNight();
    run({ action: 'disable', now: at(10) });
    expect(run({ action: 'record', subaction: 'task-landed', now: at(20) }).exit).toBe(1);
  });
});

describe('status', () => {
  test('status with no night reports nulls', () => {
    const res = run({ action: 'status', now: T0 });
    expect(res.out.night).toBeNull();
    expect(res.out.floors).toBeNull();
    expect(res.out.lease).toBeNull();
  });

  test('status reports a stale lease as not fresh', () => {
    enableNight();
    run({
      action: 'lease',
      subaction: 'acquire',
      holder: 'tick-1',
      ttlSeconds: 60,
      now: at(10),
    });
    const res = run({ action: 'status', now: at(500) });
    expect((res.out.lease as { fresh: boolean }).fresh).toBe(false);
  });
});
