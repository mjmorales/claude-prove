/**
 * Scrum hook handlers — Claude Code stdin-JSON consumers.
 *
 * Three handlers, each matching the run-state hook signature
 * `(payload: Record<string, unknown> | null) => HookResult`:
 *   - `onSessionStart` — emit a compact digest of active tasks,
 *     stalled WIP, and recent events as `hookSpecificOutput`.
 *   - `onSubagentStop` — filter to `general-purpose` / `task-planner`
 *     subagents, locate the run directory, delegate to
 *     `reconcileRunCompleted`.
 *   - `onStop` — read `.prove/scrum/last-sweep.json`, invoke
 *     `sweepUnreconciled`, write updated timestamp back.
 *
 * Hooks are non-blocking by contract: `onSessionStart` and `onStop` catch
 * every error and exit 0. `onSubagentStop` exits 1 only on genuinely
 * unexpected failures (filesystem errors after a subagent-type match);
 * filter mismatches are a normal no-op.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pyJsonDump } from '../run-state/hooks/json-compat';
import { EMPTY_HOOK_RESULT, type HookResult, readCwd } from '../run-state/hooks/types';
import { ORPHAN_TASK_ID, reconcileRunCompleted, sweepUnreconciled } from './reconcile';
import { type ScrumStore, openScrumStore } from './store';
import type { ScrumEvent, ScrumTask } from './types';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Subagents we reconcile on SubagentStop. Anything else is a no-op. */
const RECONCILED_SUBAGENTS = new Set(['general-purpose', 'task-planner']);

/** Sidecar file tracking the last sweep's mtime cursor. */
const LAST_SWEEP_FILENAME = 'last-sweep.json';

/** Relative location of the scrum state dir under project root. */
const SCRUM_DIR_REL = join('.prove', 'scrum');

/**
 * Tasks that haven't emitted an event in this many hours are "stalled".
 * Used by the session-start digest to surface WIP that fell on the floor.
 */
const STALL_THRESHOLD_HOURS = 24;

/** Cap the digest so hookSpecificOutput stays small. */
const DIGEST_MAX_ACTIVE = 10;
const DIGEST_MAX_STALLED = 5;
const DIGEST_MAX_RECENT = 15;

// ---------------------------------------------------------------------------
// Public handlers
// ---------------------------------------------------------------------------

export interface SessionStartDigest {
  active_tasks: Array<{ id: string; title: string; status: string; last_event_at: string | null }>;
  stalled_wip: Array<{ id: string; title: string; last_event_at: string | null }>;
  recent_events: Array<{ task_id: string; kind: string; ts: string }>;
}

/**
 * SessionStart: emit active tasks + stalled WIP + recent events so the new
 * session inherits awareness of in-flight scrum state. Never throws —
 * errors land on stderr with exit 0 so a broken scrum store never bricks
 * a session.
 */
export function onSessionStart(payload: Record<string, unknown> | null): HookResult {
  try {
    const project = resolveProjectDir(payload);
    const store = openScrumStore({ cwd: project });
    try {
      const digest = computeDigest(store);
      if (isEmptyDigest(digest)) return EMPTY_HOOK_RESULT;
      const body = pyJsonDump({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: formatDigest(digest),
        },
      });
      return { exitCode: 0, stdout: body, stderr: '' };
    } finally {
      store.close();
    }
  } catch (err) {
    return {
      exitCode: 0,
      stdout: '',
      stderr: `scrum session-start hook: ${errMsg(err)}\n`,
    };
  }
}

/**
 * SubagentStop: reconcile the subagent's run directory. Filter-mismatch
 * (unrelated subagent type) returns EMPTY_HOOK_RESULT silently. Exit 1
 * fires only on unexpected errors after the filter passes — those
 * indicate a real problem worth surfacing to the orchestrator.
 */
export function onSubagentStop(payload: Record<string, unknown> | null): HookResult {
  if (!payload) return EMPTY_HOOK_RESULT;

  const subagentType = readString(payload, 'subagent_type');
  if (!RECONCILED_SUBAGENTS.has(subagentType)) return EMPTY_HOOK_RESULT;

  try {
    const cwd = readCwd(payload) || process.cwd();
    const statePath = locateStateJson(cwd);
    if (!statePath) return EMPTY_HOOK_RESULT;

    const project = resolveProjectDir(payload);
    const store = openScrumStore({ cwd: project });
    try {
      const result = reconcileRunCompleted(statePath, store);
      if (result.kind === 'skipped') return EMPTY_HOOK_RESULT;
      const body = pyJsonDump({
        systemMessage: `scrum: reconciled ${result.kind} run (task=${result.taskId ?? ORPHAN_TASK_ID})`,
      });
      return { exitCode: 0, stdout: body, stderr: '' };
    } finally {
      store.close();
    }
  } catch (err) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: `scrum subagent-stop hook: ${errMsg(err)}\n`,
    };
  }
}

/**
 * Stop: read the last-sweep cursor, sweep every state.json newer than it,
 * write back the updated cursor. Non-blocking — any failure is logged
 * to stderr with exit 0.
 */
export function onStop(payload: Record<string, unknown> | null): HookResult {
  try {
    const project = resolveProjectDir(payload);
    const sinceTs = readLastSweep(project);
    const store = openScrumStore({ cwd: project });
    try {
      const result = sweepUnreconciled(store, sinceTs, project);
      writeLastSweep(project, Date.now());
      if (result.reconciled === 0 && result.errors.length === 0) {
        return EMPTY_HOOK_RESULT;
      }
      const lines: string[] = [
        `scrum: swept ${result.scanned} run(s), reconciled ${result.reconciled}`,
      ];
      for (const err of result.errors) lines.push(`- error: ${err.message}`);
      const body = pyJsonDump({ systemMessage: lines.join('\n') });
      return { exitCode: 0, stdout: body, stderr: '' };
    } finally {
      store.close();
    }
  } catch (err) {
    return {
      exitCode: 0,
      stdout: '',
      stderr: `scrum stop hook: ${errMsg(err)}\n`,
    };
  }
}

// ---------------------------------------------------------------------------
// Session-start digest helpers
// ---------------------------------------------------------------------------

function computeDigest(store: ScrumStore): SessionStartDigest {
  const nowMs = Date.now();
  const stallCutoffMs = nowMs - STALL_THRESHOLD_HOURS * 3600 * 1000;

  const inProgress = store.listTasks({ status: 'in_progress' });
  const review = store.listTasks({ status: 'review' });
  const active = [...inProgress, ...review].slice(0, DIGEST_MAX_ACTIVE).map(toActiveRow);

  const stalled = inProgress
    .filter((t) => isStalled(t, stallCutoffMs))
    .slice(0, DIGEST_MAX_STALLED)
    .map(toStalledRow);

  const recent = store.listRecentEvents(DIGEST_MAX_RECENT).map(toRecentRow);

  return { active_tasks: active, stalled_wip: stalled, recent_events: recent };
}

function isStalled(task: ScrumTask, stallCutoffMs: number): boolean {
  if (!task.last_event_at) return true;
  const parsed = Date.parse(task.last_event_at);
  if (Number.isNaN(parsed)) return false;
  return parsed < stallCutoffMs;
}

function toActiveRow(task: ScrumTask): SessionStartDigest['active_tasks'][number] {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    last_event_at: task.last_event_at,
  };
}

function toStalledRow(task: ScrumTask): SessionStartDigest['stalled_wip'][number] {
  return { id: task.id, title: task.title, last_event_at: task.last_event_at };
}

function toRecentRow(event: ScrumEvent): SessionStartDigest['recent_events'][number] {
  return { task_id: event.task_id, kind: event.kind, ts: event.ts };
}

function isEmptyDigest(digest: SessionStartDigest): boolean {
  return (
    digest.active_tasks.length === 0 &&
    digest.stalled_wip.length === 0 &&
    digest.recent_events.length === 0
  );
}

function formatDigest(digest: SessionStartDigest): string {
  const lines: string[] = ['Scrum state:'];
  if (digest.active_tasks.length > 0) {
    lines.push(`- active (${digest.active_tasks.length}):`);
    for (const task of digest.active_tasks) {
      lines.push(`  - ${task.id} [${task.status}] ${task.title}`);
    }
  }
  if (digest.stalled_wip.length > 0) {
    lines.push(`- stalled (${digest.stalled_wip.length}):`);
    for (const task of digest.stalled_wip) {
      lines.push(`  - ${task.id} ${task.title} (last ${task.last_event_at ?? 'never'})`);
    }
  }
  if (digest.recent_events.length > 0) {
    lines.push(`- recent events (${digest.recent_events.length}):`);
    for (const event of digest.recent_events) {
      lines.push(`  - ${event.ts} ${event.task_id} ${event.kind}`);
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Subagent-stop helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the run directory from the subagent's cwd. Walks upward from
 * `cwd` looking for a `state.json` inside a `.prove/runs/<branch>/<slug>/`
 * path segment. Returns `null` if not found (filter-mismatch path).
 */
function locateStateJson(cwd: string): string | null {
  // Common case: cwd *is* the run dir.
  const direct = join(cwd, 'state.json');
  if (isFile(direct)) return direct;

  // Walk up to 6 parents looking for a state.json — mirrors the resolveSlug
  // pattern from run-state's subagent-stop, bounded so we never scan far.
  let cur = cwd;
  for (let depth = 0; depth < 6; depth++) {
    const candidate = join(cur, 'state.json');
    if (isFile(candidate)) return candidate;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

// ---------------------------------------------------------------------------
// last-sweep.json helpers
// ---------------------------------------------------------------------------

function scrumDir(project: string): string {
  return join(project, SCRUM_DIR_REL);
}

function lastSweepPath(project: string): string {
  return join(scrumDir(project), LAST_SWEEP_FILENAME);
}

function readLastSweep(project: string): number {
  const path = lastSweepPath(project);
  if (!existsSync(path)) return 0;
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const ts = (parsed as Record<string, unknown>).ts;
      if (typeof ts === 'number' && Number.isFinite(ts)) return ts;
    }
    return 0;
  } catch {
    return 0;
  }
}

function writeLastSweep(project: string, tsMs: number): void {
  const path = lastSweepPath(project);
  mkdirSync(dirname(path), { recursive: true });
  const body = `${JSON.stringify({ ts: tsMs, iso: new Date(tsMs).toISOString() }, null, 2)}\n`;
  writeFileSync(path, body, 'utf8');
}

// ---------------------------------------------------------------------------
// Shared utilities
// ---------------------------------------------------------------------------

function resolveProjectDir(payload: Record<string, unknown> | null): string {
  if (payload) {
    const cwd = readCwd(payload);
    if (cwd) return cwd;
  }
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

function readString(payload: Record<string, unknown>, key: string): string {
  const v = payload[key];
  return typeof v === 'string' ? v : '';
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
