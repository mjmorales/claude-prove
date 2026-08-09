/**
 * Core logic for the `nightshift` topic — mechanical state for the
 * operator-enabled overnight scrum-drain driver.
 *
 * The engine records and adjudicates; it never decides what to do next. Every
 * action prints a JSON verdict the tick session branches on:
 *
 *   enable   — open a night (config + counters), reject a second active night
 *   disable  — close the night, release the lease
 *   status   — night + lease + floor verdicts in one read
 *   lease    — acquire | heartbeat | release (heartbeat lease, stale takeover)
 *   record   — append a ledger row, bump counters, return floor verdicts
 *   ledger   — dump the current night's rows
 *
 * Exit codes:
 *   0  success (for `lease acquire`: lease held by caller on exit)
 *   1  usage error, no active night where one is required, lease contention,
 *      or holder mismatch
 */

import { resolve } from 'node:path';
import {
  type FloorVerdicts,
  type Lease,
  type LedgerRow,
  type NightPaths,
  type NightState,
  RECORDABLE_EVENTS,
  type RecordableEvent,
  appendLedger,
  archiveClosedNight,
  evaluateFloors,
  healStanding,
  leaseAgeSeconds,
  leaseIsFresh,
  nightPaths,
  readLease,
  readLedger,
  readNight,
  removeLease,
  resolveDeadline,
  writeLease,
  writeNight,
} from './state';

export const NIGHTSHIFT_ACTIONS = [
  'enable',
  'disable',
  'status',
  'lease',
  'record',
  'ledger',
] as const;
export type NightshiftAction = (typeof NIGHTSHIFT_ACTIONS)[number];

export const LEASE_SUBACTIONS = ['acquire', 'heartbeat', 'release'] as const;
export type LeaseSubaction = (typeof LEASE_SUBACTIONS)[number];

export interface NightshiftOpts {
  action: NightshiftAction;
  /** lease subaction, or the event name for `record`. */
  subaction?: string;
  projectRoot?: string;
  milestone?: string;
  deadline?: string;
  taskCap?: number;
  maxHeals?: number;
  maxParked?: number;
  reason?: string;
  holder?: string;
  ttlSeconds?: number;
  force?: boolean;
  task?: string;
  pr?: string;
  detail?: string;
  /** Test seam: fixed clock. Production callers omit it. */
  now?: Date;
}

const DEFAULT_DEADLINE = '07:00';
const DEFAULT_TASK_CAP = 10;
const DEFAULT_MAX_HEALS_PER_PR = 2;
const DEFAULT_MAX_PARKED = 3;
const DEFAULT_LEASE_TTL_SECONDS = 900;

export function runNightshift(opts: NightshiftOpts): number {
  const projectRoot = resolve(opts.projectRoot ?? process.cwd());
  const paths = nightPaths(projectRoot);
  const now = opts.now ?? new Date();

  switch (opts.action) {
    case 'enable':
      return runEnable(paths, opts, now);
    case 'disable':
      return runDisable(paths, opts, now);
    case 'status':
      return runStatus(paths, now);
    case 'lease':
      return runLease(paths, opts, now);
    case 'record':
      return runRecord(paths, opts, now);
    case 'ledger':
      return runLedger(paths);
  }
}

function runEnable(paths: NightPaths, opts: NightshiftOpts, now: Date): number {
  if (!opts.milestone) {
    return usageError('nightshift enable: --milestone is required');
  }
  const existing = readNight(paths);
  if (existing && existing.status !== 'closed') {
    return usageError(
      `nightshift enable: night '${existing.night_id}' is ${existing.status} — disable it first`,
    );
  }
  if (existing) archiveClosedNight(paths, existing);

  const deadlineSpec = opts.deadline ?? DEFAULT_DEADLINE;
  const deadline = resolveDeadline(now, deadlineSpec);
  if (!deadline) {
    return usageError(`nightshift enable: invalid --deadline '${deadlineSpec}' (expected HH:MM)`);
  }

  const night: NightState = {
    schema_version: '1',
    night_id: `night-${timestampSlug(now)}`,
    milestone: opts.milestone,
    status: 'active',
    enabled_at: now.toISOString(),
    deadline_at: deadline.toISOString(),
    task_cap: opts.taskCap ?? DEFAULT_TASK_CAP,
    max_heals_per_pr: opts.maxHeals ?? DEFAULT_MAX_HEALS_PER_PR,
    max_parked: opts.maxParked ?? DEFAULT_MAX_PARKED,
    halt_reason: null,
    closed_at: null,
    counters: { tasks_started: 0, tasks_landed: 0, tasks_parked: 0, heals_by_pr: {} },
  };
  writeNight(paths, night);
  appendLedger(paths, row(night, 'enabled', opts, now));
  printJson({ night, floors: evaluateFloors(night, now) });
  summarize(`enabled ${night.night_id} milestone=${night.milestone} until=${night.deadline_at}`);
  return 0;
}

function runDisable(paths: NightPaths, opts: NightshiftOpts, now: Date): number {
  const night = readNight(paths);
  if (!night || night.status === 'closed') {
    return usageError('nightshift disable: no open night');
  }
  night.status = 'closed';
  night.closed_at = now.toISOString();
  if (opts.reason) night.halt_reason = night.halt_reason ?? opts.reason;
  writeNight(paths, night);
  removeLease(paths);
  appendLedger(paths, row(night, 'disabled', opts, now));
  printJson({ night });
  summarize(`disabled ${night.night_id}`);
  return 0;
}

function runStatus(paths: NightPaths, now: Date): number {
  const night = readNight(paths);
  const lease = readLease(paths);
  const openNight = night && night.status !== 'closed' ? night : null;
  printJson({
    night,
    floors: openNight ? evaluateFloors(openNight, now) : null,
    lease: lease
      ? {
          holder: lease.holder,
          fresh: leaseIsFresh(lease, now),
          age_seconds: Math.round(leaseAgeSeconds(lease, now)),
          ttl_seconds: lease.ttl_seconds,
        }
      : null,
  });
  return 0;
}

function runLease(paths: NightPaths, opts: NightshiftOpts, now: Date): number {
  const sub = opts.subaction;
  if (!sub || !(LEASE_SUBACTIONS as readonly string[]).includes(sub)) {
    return usageError(`nightshift lease: expected one of: ${LEASE_SUBACTIONS.join(', ')}`);
  }
  if (!opts.holder) {
    return usageError('nightshift lease: --holder is required');
  }
  const holder = opts.holder;
  const lease = readLease(paths);

  switch (sub as LeaseSubaction) {
    case 'acquire': {
      const night = readNight(paths);
      if (!night || night.status === 'closed') {
        return usageError('nightshift lease acquire: no open night');
      }
      if (lease && lease.holder !== holder && leaseIsFresh(lease, now)) {
        printJson({
          acquired: false,
          holder: lease.holder,
          age_seconds: Math.round(leaseAgeSeconds(lease, now)),
          ttl_seconds: lease.ttl_seconds,
        });
        return 1;
      }
      const staleTakeover = !!lease && lease.holder !== holder;
      const next: Lease = {
        holder,
        acquired_at: now.toISOString(),
        heartbeat_at: now.toISOString(),
        ttl_seconds: opts.ttlSeconds ?? lease?.ttl_seconds ?? DEFAULT_LEASE_TTL_SECONDS,
      };
      writeLease(paths, next);
      printJson({
        acquired: true,
        stale_takeover: staleTakeover,
        previous_holder: staleTakeover ? lease?.holder : null,
        lease: next,
      });
      return 0;
    }
    case 'heartbeat': {
      if (!lease) return usageError('nightshift lease heartbeat: no lease held');
      if (lease.holder !== holder) {
        return usageError(
          `nightshift lease heartbeat: lease held by '${lease.holder}', not '${holder}'`,
        );
      }
      lease.heartbeat_at = now.toISOString();
      writeLease(paths, lease);
      printJson({ heartbeat: true, lease });
      return 0;
    }
    case 'release': {
      if (!lease) {
        printJson({ released: false, reason: 'no lease held' });
        return 0;
      }
      if (lease.holder !== holder && !opts.force) {
        return usageError(
          `nightshift lease release: lease held by '${lease.holder}', not '${holder}' (use --force to override)`,
        );
      }
      removeLease(paths);
      printJson({ released: true });
      return 0;
    }
  }
}

function runRecord(paths: NightPaths, opts: NightshiftOpts, now: Date): number {
  const event = opts.subaction;
  if (!event || !(RECORDABLE_EVENTS as readonly string[]).includes(event)) {
    return usageError(`nightshift record: expected one of: ${RECORDABLE_EVENTS.join(', ')}`);
  }
  const night = readNight(paths);
  if (!night || night.status === 'closed') {
    return usageError('nightshift record: no open night');
  }

  const recordable = event as RecordableEvent;
  if (recordable === 'heal-attempt' && !opts.pr) {
    return usageError('nightshift record heal-attempt: --pr is required');
  }

  switch (recordable) {
    case 'task-started':
      night.counters.tasks_started += 1;
      break;
    case 'task-landed':
      night.counters.tasks_landed += 1;
      break;
    case 'task-parked':
      night.counters.tasks_parked += 1;
      if (night.counters.tasks_parked >= night.max_parked && night.status === 'active') {
        night.status = 'halted';
        night.halt_reason = `parked-floor: ${night.counters.tasks_parked} tasks parked (max ${night.max_parked})`;
      }
      break;
    case 'heal-attempt': {
      const pr = opts.pr as string;
      night.counters.heals_by_pr[pr] = (night.counters.heals_by_pr[pr] ?? 0) + 1;
      break;
    }
    case 'halted':
      night.status = 'halted';
      night.halt_reason = opts.detail ?? 'halted by driver';
      break;
    case 'trunk-red':
    case 'morning-digest':
      break;
  }

  writeNight(paths, night);
  appendLedger(paths, row(night, recordable, opts, now));

  const verdict: {
    recorded: RecordableEvent;
    night_id: string;
    counters: NightState['counters'];
    floors: FloorVerdicts;
    heal?: { pr: string; attempts: number; cap_reached: boolean };
  } = {
    recorded: recordable,
    night_id: night.night_id,
    counters: night.counters,
    floors: evaluateFloors(night, now),
  };
  if (recordable === 'heal-attempt') {
    verdict.heal = { pr: opts.pr as string, ...healStanding(night, opts.pr as string) };
  }
  printJson(verdict);
  return 0;
}

function runLedger(paths: NightPaths): number {
  printJson(readLedger(paths));
  return 0;
}

function row(
  night: NightState,
  event: LedgerRow['event'],
  opts: NightshiftOpts,
  now: Date,
): LedgerRow {
  return {
    ts: now.toISOString(),
    night_id: night.night_id,
    event,
    task: opts.task ?? null,
    pr: opts.pr ?? null,
    detail: opts.detail ?? null,
  };
}

function timestampSlug(now: Date): string {
  return now.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
}

function usageError(message: string): number {
  process.stderr.write(`error: ${message}\n`);
  return 1;
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function summarize(message: string): void {
  process.stderr.write(`nightshift: ${message}\n`);
}
