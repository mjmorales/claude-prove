/**
 * File-backed state for the `nightshift` topic — the mechanical half of the
 * overnight scrum-drain driver (rationale ADR: 2026-08-09-nightshift-driver,
 * operator scrum store).
 *
 * Everything here is engine-owned per the Engine Boundary: night config,
 * heartbeat lease, floor counters, and the append-only ledger. The judgment
 * half (what a tick actually does with a floor verdict) lives in the
 * nightshift skills.
 *
 * Layout under `<project-root>/.prove/nightshift/`:
 *   night.json     — the current night: config + status + counters
 *   lease.json     — heartbeat lease held by the active tick session
 *   ledger.jsonl   — append-only event rows for the current night
 *   history/       — closed nights archived on the next `enable`
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Ledger event taxonomy — closed enum per the Closed-Enum discipline.
 * `enabled` / `disabled` rows are written only by the enable/disable actions;
 * `record` accepts exactly the RECORDABLE_EVENTS subset.
 */
export const NIGHT_LEDGER_EVENTS = [
  'enabled',
  'task-started',
  'task-landed',
  'heal-attempt',
  'task-parked',
  'trunk-red',
  'halted',
  'morning-digest',
  'disabled',
] as const;
export type NightLedgerEvent = (typeof NIGHT_LEDGER_EVENTS)[number];

export const RECORDABLE_EVENTS = [
  'task-started',
  'task-landed',
  'heal-attempt',
  'task-parked',
  'trunk-red',
  'halted',
  'morning-digest',
] as const;
export type RecordableEvent = (typeof RECORDABLE_EVENTS)[number];

export type NightStatus = 'active' | 'halted' | 'closed';

export interface NightCounters {
  tasks_started: number;
  tasks_landed: number;
  tasks_parked: number;
  /** Heal attempts keyed by PR number — the per-PR heal cap reads this. */
  heals_by_pr: Record<string, number>;
}

export interface NightState {
  schema_version: '1';
  night_id: string;
  milestone: string;
  status: NightStatus;
  enabled_at: string;
  /** Absolute instant the night ends — resolved at enable time so a
   *  midnight-crossing "07:00" deadline is unambiguous. */
  deadline_at: string;
  task_cap: number;
  max_heals_per_pr: number;
  max_parked: number;
  halt_reason: string | null;
  closed_at: string | null;
  counters: NightCounters;
}

export interface Lease {
  holder: string;
  acquired_at: string;
  heartbeat_at: string;
  ttl_seconds: number;
}

export interface LedgerRow {
  ts: string;
  night_id: string;
  event: NightLedgerEvent;
  task: string | null;
  pr: string | null;
  detail: string | null;
}

/** Mechanical floor verdicts — the tick branches on these, never recomputes them. */
export interface FloorVerdicts {
  past_deadline: boolean;
  task_cap_reached: boolean;
  parked_floor_tripped: boolean;
  /** True once the night is halted (parked floor or explicit halt event). */
  halt: boolean;
  /** True only when a new task may start: active night, cap not reached, deadline not passed. */
  can_start_task: boolean;
}

export interface NightPaths {
  dir: string;
  night: string;
  lease: string;
  ledger: string;
  historyDir: string;
}

export function nightPaths(projectRoot: string): NightPaths {
  const dir = join(projectRoot, '.prove', 'nightshift');
  return {
    dir,
    night: join(dir, 'night.json'),
    lease: join(dir, 'lease.json'),
    ledger: join(dir, 'ledger.jsonl'),
    historyDir: join(dir, 'history'),
  };
}

export function readNight(paths: NightPaths): NightState | null {
  if (!existsSync(paths.night)) return null;
  try {
    return JSON.parse(readFileSync(paths.night, 'utf8')) as NightState;
  } catch {
    return null;
  }
}

export function writeNight(paths: NightPaths, night: NightState): void {
  atomicWriteJson(paths.night, night);
}

export function readLease(paths: NightPaths): Lease | null {
  if (!existsSync(paths.lease)) return null;
  try {
    return JSON.parse(readFileSync(paths.lease, 'utf8')) as Lease;
  } catch {
    return null;
  }
}

export function writeLease(paths: NightPaths, lease: Lease): void {
  atomicWriteJson(paths.lease, lease);
}

export function removeLease(paths: NightPaths): void {
  rmSync(paths.lease, { force: true });
}

export function leaseAgeSeconds(lease: Lease, now: Date): number {
  const beat = Date.parse(lease.heartbeat_at);
  if (Number.isNaN(beat)) return Number.POSITIVE_INFINITY;
  return Math.max(0, (now.getTime() - beat) / 1000);
}

export function leaseIsFresh(lease: Lease, now: Date): boolean {
  return leaseAgeSeconds(lease, now) <= lease.ttl_seconds;
}

export function appendLedger(paths: NightPaths, row: LedgerRow): void {
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(paths.ledger, `${JSON.stringify(row)}\n`, { flag: 'a' });
}

export function readLedger(paths: NightPaths): LedgerRow[] {
  if (!existsSync(paths.ledger)) return [];
  const rows: LedgerRow[] = [];
  for (const line of readFileSync(paths.ledger, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as LedgerRow);
    } catch {
      // A torn write (crash mid-append) must not poison the whole ledger.
    }
  }
  return rows;
}

export function evaluateFloors(night: NightState, now: Date): FloorVerdicts {
  const pastDeadline = now.getTime() >= Date.parse(night.deadline_at);
  const taskCapReached = night.counters.tasks_started >= night.task_cap;
  const parkedTripped = night.counters.tasks_parked >= night.max_parked;
  const halt = night.status === 'halted';
  return {
    past_deadline: pastDeadline,
    task_cap_reached: taskCapReached,
    parked_floor_tripped: parkedTripped,
    halt,
    can_start_task: night.status === 'active' && !pastDeadline && !taskCapReached,
  };
}

/**
 * Heal attempts recorded against a PR, and whether the cap is exhausted. The
 * driver records BEFORE acting, so `cap_reached` uses strict `>`: recording
 * attempt N returns false for N <= max (this attempt may execute) and true for
 * N > max (park instead) — `max_heals_per_pr = 2` yields exactly two executed
 * heals.
 */
export function healStanding(
  night: NightState,
  pr: string,
): { attempts: number; cap_reached: boolean } {
  const attempts = night.counters.heals_by_pr[pr] ?? 0;
  return { attempts, cap_reached: attempts > night.max_heals_per_pr };
}

/**
 * Resolve a `HH:MM` local-time deadline to the next occurrence strictly after
 * `from`. A night enabled at 23:10 with deadline "07:00" resolves to 07:00 the
 * next day; enabled at 06:00 it resolves to 07:00 the same day.
 */
export function resolveDeadline(from: Date, hhmm: string): Date | null {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!match) return null;
  const deadline = new Date(from);
  deadline.setHours(Number(match[1]), Number(match[2]), 0, 0);
  if (deadline.getTime() <= from.getTime()) deadline.setDate(deadline.getDate() + 1);
  return deadline;
}

/**
 * Archive a closed night's state + ledger under `history/` so a new `enable`
 * starts clean while the append-only record survives.
 */
export function archiveClosedNight(paths: NightPaths, night: NightState): void {
  mkdirSync(paths.historyDir, { recursive: true });
  renameSync(paths.night, join(paths.historyDir, `${night.night_id}.json`));
  if (existsSync(paths.ledger)) {
    renameSync(paths.ledger, join(paths.historyDir, `${night.night_id}.ledger.jsonl`));
  }
}

/**
 * Write-then-rename so a crash mid-write can never leave a torn night.json or
 * lease.json — readers see the old file or the new one, nothing in between.
 */
function atomicWriteJson(path: string, value: unknown): void {
  const dir = join(path, '..');
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}
