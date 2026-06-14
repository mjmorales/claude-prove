/**
 * Scrum hook handlers — Claude Code stdin-JSON consumers.
 *
 * Three handlers, each matching the run-state hook signature
 * `(payload: Record<string, unknown> | null) => HookResult`:
 *   - `onSessionStart` — emit a compact digest of active tasks,
 *     stalled WIP, and recent events as `hookSpecificOutput`.
 *   - `onSubagentStop` — filter to `general-purpose` / `task-planner` and
 *     `team-<slug>-<role>` subagents, locate the run directory, delegate to
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
import { resolveDbPath } from '@claude-prove/store';
import { readDevMode } from '../acb/hook';
import { resolveActiveRunDir } from '../run-state/hooks/capture';
import { pyJsonDump } from '../run-state/hooks/json-compat';
import { EMPTY_HOOK_RESULT, type HookResult, readCwd } from '../run-state/hooks/types';
import { openStoreWithSync, runSyncPhase } from './cli/sync-lifecycle';
import { type GateVerdict, evaluateSessionEndGate } from './handoff-gate';
import {
  type BoundAction,
  ORPHAN_TASK_ID,
  type ReconcileRunResult,
  type StaleEscalationSweepResult,
  type TriggerBinding,
  bubbleStaleEscalations,
  computeBoundActions,
  detectContributionMiss,
  parseTeamAgentName,
  reconcileRunCompleted,
  sweepUnreconciled,
} from './reconcile';
import { type ScrumStore, openScrumStore } from './store';
import type { EscalationPayload, ScrumEvent, ScrumTask } from './types';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Generic (non-team) subagents we reconcile on SubagentStop. Team-role seats
 * (`team-<slug>-<role>`) also reconcile, but are admitted by name shape via
 * `parseTeamAgentName` rather than this set — see `isReconcileTarget`. Any
 * subagent matching neither is a no-op.
 */
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
const DIGEST_MAX_BOUND = 10;

// ---------------------------------------------------------------------------
// Public handlers
// ---------------------------------------------------------------------------

export interface SessionStartDigest {
  active_tasks: Array<{ id: string; title: string; status: string; last_event_at: string | null }>;
  stalled_wip: Array<{ id: string; title: string; last_event_at: string | null }>;
  recent_events: Array<{ task_id: string; kind: string; ts: string }>;
  auto_bubbled: StaleEscalationSweepResult['bubbled'];
  /** Pending bound next-actions from the declared trigger table (1.4). */
  bound_actions: BoundAction[];
}

/**
 * SessionStart: auto-bubble any escalation that aged past the staleness floor,
 * then emit active tasks + stalled WIP + recent events so the new session
 * inherits awareness of in-flight scrum state. The escalation sweep is the ONLY
 * firing point for the staleness floor — there is no resident loop; it runs on
 * each session-start transition and its results surface via `alerts` /
 * `nextReady`. Never throws — errors land on stderr with exit 0 so a broken
 * scrum store never bricks a session.
 */
export async function onSessionStart(payload: Record<string, unknown> | null): Promise<HookResult> {
  try {
    const project = resolveProjectDir(payload);
    // Session-boundary cloud sync: flush-push + pull BEFORE the digest runs so
    // the digest reflects freshly-pulled peer state. Gated on
    // `cloud.enabled && token`; local-only (the default) performs zero network.
    // A degrade warns and proceeds local — the digest is never blocked.
    const { store, result: sync } = await openStoreWithSync(project, 'session-start');
    if (sync.attempted && !sync.ok && sync.degradedReason) {
      process.stderr.write(`scrum session-start: cloud sync degraded (${sync.degradedReason})\n`);
    }
    try {
      const sweep = await bubbleStaleEscalations(store, Date.now());
      const digest = await computeDigest(store, sweep, readTriggers(project));
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
 * SubagentStop: enforce the end-of-session handoff/synthesis gate, then
 * reconcile the subagent's run directory. Filter-mismatch (unrelated subagent
 * type) returns EMPTY_HOOK_RESULT silently. A worker that touched an artifact
 * but logged no compliant synthesis is BLOCKED via a `decision: block` payload
 * carrying remediation. Exit 1 fires only on unexpected errors after the
 * filter passes — those indicate a real problem worth surfacing.
 */
export async function onSubagentStop(payload: Record<string, unknown> | null): Promise<HookResult> {
  if (!payload) return EMPTY_HOOK_RESULT;

  const subagentType = readString(payload, 'subagent_type');
  // Reconcile generic seats (general-purpose / task-planner) AND team-role
  // seats (`team-<slug>-<role>`). The latter are the primary dispatch model and
  // are also the only seats the contribution-miss floor targets, so they MUST
  // reach the reconcile path. Anything else early-returns as a clean no-op.
  const isReconcileTarget =
    RECONCILED_SUBAGENTS.has(subagentType) || parseTeamAgentName(subagentType) !== null;
  if (!isReconcileTarget) return EMPTY_HOOK_RESULT;

  try {
    const cwd = readCwd(payload) || process.cwd();
    const statePath = locateStateJson(cwd);
    if (!statePath) return EMPTY_HOOK_RESULT;

    const project = resolveProjectDir(payload);

    // Handoff/synthesis floor: a worker that mutated artifacts must declare
    // its outcome before it stops. Block here, before reconcile, so the next
    // tool call is the synthesis the worker owes — reconcile happens only once
    // the session is allowed to end.
    const gate = evaluateSessionEndGate(dirname(statePath), readDevMode(project));
    if (!gate.ok) return blockSessionEnd(gate);

    const dbPath = resolveDbPath({ cwd: project });
    const store = await openScrumStore({ override: dbPath });
    try {
      // Pass `project` so rebuildContextBundle resolves run paths against the
      // correct root when firing from a linked worktree or a subdirectory.
      const result = await reconcileRunCompleted(statePath, store, project);
      if (result.kind === 'skipped') return EMPTY_HOOK_RESULT;

      // Advisory contribution floor: a team-role seat that stops without
      // stamping any contribution on its task gets surfaced in `alerts`, never
      // blocked. Runs AFTER reconcile (so the seat's own run_completed/synthesis
      // events are already in the window) and never touches `result` — the
      // reconcile outcome and the non-blocking exit code stand regardless.
      await raiseContributionMissIfAny(store, statePath, result);
      // Session-boundary cloud sync: push local writes AFTER reconcile so the
      // reconcile's own writes are flushed in the same push. Gated on
      // `cloud.enabled && token`; local-only (the default) is zero network. A
      // degrade warns and never alters the reconcile outcome.
      const sync = await runSyncPhase(store, project, dbPath, 'subagent-stop');
      if (sync.attempted && !sync.ok && sync.degradedReason) {
        process.stderr.write(`scrum subagent-stop: cloud sync degraded (${sync.degradedReason})\n`);
      }
      // Surface the blocking reason (e.g. story-close floor rejection, orphan
      // task-not-found) so the operator sees WHY reconcile stalled, not just
      // that a run was processed.
      const reasonSuffix = result.reason ? ` — ${result.reason}` : '';
      const body = pyJsonDump({
        systemMessage: `scrum: reconciled ${result.kind} run (task=${result.taskId ?? ORPHAN_TASK_ID})${reasonSuffix}`,
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
 * Stop: enforce the end-of-session handoff/synthesis gate for the active run,
 * then read the last-sweep cursor, sweep every state.json newer than it, and
 * write back the updated cursor.
 *
 * The GATE is blocking: a session that touched an artifact but logged no
 * compliant synthesis is BLOCKED via a `decision: block` payload. The SWEEP
 * stays non-blocking — any sweep failure is logged to stderr with exit 0 — so
 * a broken scrum store never bricks a session that already satisfied the gate.
 */
export async function onStop(payload: Record<string, unknown> | null): Promise<HookResult> {
  try {
    // Resolve cwd/project inside the catch-all so a process.cwd() ENOENT
    // (e.g. the session's worktree was removed) cannot escape as an uncaught
    // throw — safeResolveProjectDir falls back to CLAUDE_PROJECT_DIR or '.'
    // so the gate and sweep still run against a best-effort directory.
    const cwd = safeReadCwd(payload);
    const project = safeResolveProjectDir(payload);

    // Evaluate the gate before the non-blocking sweep so a synthesis block is
    // never swallowed by the sweep's error catch. Run-dir resolution is wrapped
    // so a resolver throw passes the session — the gate blocks only on a
    // positively-detected violation, never on its own infrastructure failure.
    const gate = evaluateSessionEndGate(safeResolveActiveRunDir(cwd), readDevMode(project));
    if (!gate.ok) return blockSessionEnd(gate);

    const sinceTs = readLastSweep(project);
    const dbPath = resolveDbPath({ cwd: project });
    const store = await openScrumStore({ override: dbPath });
    try {
      const result = await sweepUnreconciled(store, sinceTs, project);
      writeLastSweep(project, Date.now());
      // Session-boundary cloud sync: push local writes AFTER the sweep so the
      // sweep's reconciliation writes are flushed in the same push. Gated on
      // `cloud.enabled && token`; local-only (the default) is zero network. A
      // degrade warns and never blocks the stop hook (exit stays 0).
      const sync = await runSyncPhase(store, project, dbPath, 'stop');
      if (sync.attempted && !sync.ok && sync.degradedReason) {
        process.stderr.write(`scrum stop: cloud sync degraded (${sync.degradedReason})\n`);
      }
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

async function computeDigest(
  store: ScrumStore,
  sweep: StaleEscalationSweepResult,
  triggers: TriggerBinding[],
): Promise<SessionStartDigest> {
  const nowMs = Date.now();
  const stallCutoffMs = nowMs - STALL_THRESHOLD_HOURS * 3600 * 1000;

  const inProgress = await store.listTasks({ status: 'in_progress' });
  const review = await store.listTasks({ status: 'review' });
  const active = [...inProgress, ...review].slice(0, DIGEST_MAX_ACTIVE).map(toActiveRow);

  const stalled = inProgress
    .filter((t) => isStalled(t, stallCutoffMs))
    .slice(0, DIGEST_MAX_STALLED)
    .map(toStalledRow);

  const recent = (await store.listRecentEvents(DIGEST_MAX_RECENT)).map(toRecentRow);

  return {
    active_tasks: active,
    stalled_wip: stalled,
    recent_events: recent,
    auto_bubbled: sweep.bubbled,
    bound_actions: await computeBoundActions(store, triggers, DIGEST_MAX_BOUND),
  };
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
    digest.recent_events.length === 0 &&
    digest.auto_bubbled.length === 0 &&
    digest.bound_actions.length === 0
  );
}

/**
 * Read the declared trigger bindings from `<project>/.claude/.prove.json`
 * (`triggers[]`). Returns `[]` when the file is absent, unparseable, or carries
 * no triggers — mirrors `readDevMode`'s tolerant config read so a malformed
 * config never bricks the session-start hook.
 */
function readTriggers(projectDir: string): TriggerBinding[] {
  try {
    const configPath = join(projectDir, '.claude', '.prove.json');
    if (!existsSync(configPath)) return [];
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as { triggers?: unknown };
    if (!Array.isArray(config.triggers)) return [];
    return config.triggers.filter(
      (t): t is TriggerBinding =>
        typeof t === 'object' &&
        t !== null &&
        typeof (t as TriggerBinding).on === 'string' &&
        typeof (t as TriggerBinding).workflow === 'string' &&
        // Validate description so the asserted type fully covers the field.
        // An absent or string description is fine; any other type is rejected
        // rather than silently propagated to consumers.
        ((t as TriggerBinding).description === undefined ||
          typeof (t as TriggerBinding).description === 'string'),
    );
  } catch {
    return [];
  }
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
  if (digest.auto_bubbled.length > 0) {
    lines.push(`- auto-bubbled escalations (${digest.auto_bubbled.length}):`);
    for (const bubble of digest.auto_bubbled) {
      lines.push(
        `  - ${bubble.task_id}: ${bubble.from_layer} → ${bubble.to_layer} (aged ${bubble.age_hours}h, id ${bubble.from_id} → ${bubble.to_id})`,
      );
    }
  }
  if (digest.bound_actions.length > 0) {
    lines.push(`- bound next-actions (${digest.bound_actions.length}):`);
    for (const action of digest.bound_actions) {
      const note = action.description ? ` — ${action.description}` : '';
      lines.push(
        `  - ${action.task_id} [${action.status}] → ${action.workflow}${note} (${action.title})`,
      );
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Subagent-stop helpers
// ---------------------------------------------------------------------------

/** Earliest timestamp the contribution window opens at when a run records no start. */
const CONTRIBUTION_WINDOW_EPOCH = '0000-01-01T00:00:00.000Z';

/**
 * Advisory contribution floor. When the stopping subagent carries a team-role
 * identity (`PROVE_AGENT=team-<slug>-<role>`) and the detector finds NO
 * contribution stamped by that seat on its task within the dispatch window,
 * append one `blocker_raised` event typed `contribution_miss` so the miss
 * surfaces in `scrum alerts`. Reuses the existing escalation event surface —
 * `listOpenEscalations()` already reads `blocker_raised` rows — so there is no
 * new alert plumbing.
 *
 * Strictly advisory and strictly non-blocking by construction:
 *   - it only APPENDS an event; it never returns a result or a `decision: block`
 *     payload, so the caller's reconcile outcome and exit code are untouched;
 *   - a non-team `PROVE_AGENT` (detector `isTeamRoleAgent: false`) is a clean
 *     no-op, as is a seat that DID contribute, a non-`reconciled` run, or an
 *     orphan run with no linked task;
 *   - any error is swallowed (logged to stderr at most) so the floor can never
 *     brick the subagent-stop hook — mirroring the non-blocking discipline the
 *     rest of this file holds.
 *
 * The window is `[run start, run end)`, read from the run's `state.json`
 * (`started_at` .. `ended_at`/`updated_at`). Anchoring the close on the run's
 * recorded end — not the current instant — is deliberate: the reconcile that
 * just ran stamps its own bookkeeping events (`run_completed`, …) with the
 * ambient `PROVE_AGENT` actor at reconcile time, which is AFTER the run ended.
 * A `now` window-end would count those engine-written events as the seat's
 * contribution and mask every real miss; the run-end window-end excludes them
 * while still covering everything the seat stamped while working. A far-past
 * epoch backstops a missing `started_at` so a real contribution is never
 * excluded by an absent start.
 */
async function raiseContributionMissIfAny(
  store: ScrumStore,
  statePath: string,
  result: ReconcileRunResult,
): Promise<void> {
  try {
    if (result.kind !== 'reconciled' || result.taskId === null) return;

    const agentName = process.env.PROVE_AGENT ?? '';
    if (agentName === '') return;

    const window = readRunWindow(statePath);
    const windowStart = window.start ?? CONTRIBUTION_WINDOW_EPOCH;
    const windowEnd = window.end ?? new Date().toISOString();

    const verdict = await detectContributionMiss(
      store,
      agentName,
      result.taskId,
      windowStart,
      windowEnd,
    );
    if (!verdict.missed) return;

    const payload: EscalationPayload = {
      escalation_type: 'contribution_miss',
      summary: `team agent ${agentName} (role ${verdict.role}, team ${verdict.slug}) stopped without contributing to task ${result.taskId}`,
    };
    await store.appendEvent({ taskId: result.taskId, kind: 'blocker_raised', payload });
  } catch (err) {
    // Advisory floor — a failure here must never alter the reconcile outcome.
    process.stderr.write(`scrum contribution floor: ${errMsg(err)}\n`);
  }
}

/**
 * Read the `[started_at, ended_at)` window the run recorded in its `state.json`.
 * `end` falls back to `updated_at` when `ended_at` is absent. A missing or
 * malformed field reads as null so the caller can apply its own backstop.
 */
function readRunWindow(statePath: string): { start: string | null; end: string | null } {
  try {
    const raw = readFileSync(statePath, 'utf8');
    const parsed = JSON.parse(raw) as {
      started_at?: unknown;
      ended_at?: unknown;
      updated_at?: unknown;
    };
    return {
      start: nonEmptyString(parsed.started_at),
      end: nonEmptyString(parsed.ended_at ?? parsed.updated_at),
    };
  } catch {
    return { start: null, end: null };
  }
}

/** A non-empty string value, or null for any other type or the empty string. */
function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

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
// Handoff/synthesis gate helpers
// ---------------------------------------------------------------------------

/**
 * Encode a gate failure as a Claude Code `decision: block` payload on stdout.
 * Exit 0 is intentional: Claude Code treats the `{decision:"block"}` JSON — not
 * the exit code — as the block signal for Stop / SubagentStop hooks (mirrors
 * the acb post-commit hook). The `reason` carries the actionable remediation.
 */
function blockSessionEnd(gate: GateVerdict): HookResult {
  const body = pyJsonDump({ decision: 'block', reason: gate.message });
  return { exitCode: 0, stdout: body, stderr: '' };
}

/**
 * Resolve the active run dir for the gate, swallowing any resolver throw to
 * `null`. The gate treats `null` as "no run to gate" and passes, so a resolver
 * infrastructure failure can never block a session — only a positively-read
 * reasoning-log violation does.
 */
function safeResolveActiveRunDir(cwd: string): string | null {
  try {
    return resolveActiveRunDir(cwd);
  } catch {
    return null;
  }
}

/**
 * Read the cwd from the hook payload without ever calling process.cwd().
 * Returns an empty string when the payload carries no cwd field so callers
 * can fall through to safeResolveProjectDir without risking an ENOENT throw.
 */
function safeReadCwd(payload: Record<string, unknown> | null): string {
  return readCwd(payload ?? {}) || '';
}

/**
 * Resolve the project directory from the hook payload without throwing.
 * Falls back to CLAUDE_PROJECT_DIR then '.' so a missing or unlinked cwd
 * (e.g. a removed worktree) never causes an uncaught ENOENT from process.cwd().
 */
function safeResolveProjectDir(payload: Record<string, unknown> | null): string {
  try {
    return resolveProjectDir(payload);
  } catch {
    return process.env.CLAUDE_PROJECT_DIR ?? '.';
  }
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
