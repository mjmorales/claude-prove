/**
 * Scrum reconciler — maps orchestrator run state into the scrum domain.
 *
 * Exported entry points:
 *   - `reconcileRunCompleted(runStatePath, store)` — ingest a single run's
 *     terminal state.json/plan.json, append events, rebuild the task's
 *     context bundle.
 *   - `buildContextBundle(taskId, store)` — aggregate files touched,
 *     decisions cited, prior run summaries for one task.
 *   - `sweepUnreconciled(store, sinceTs)` — walk `.prove/runs/**` and
 *     invoke reconcileRunCompleted for each state.json newer than `sinceTs`.
 *
 * Orphan-run policy (design choice):
 *   When a run's plan.json has no `task_id`, we emit a single
 *   `unlinked_run_detected` event under a reserved sentinel task
 *   `__orphan__`. The sentinel is lazily created as a `backlog` task with
 *   a fixed title so the UI feed surfaces it. We picked the sentinel
 *   approach over a standalone alert table because (a) it reuses the
 *   append-only events log, (b) it keeps `listRecentEvents` as the single
 *   source for orchestration telemetry, and (c) it avoids a new schema
 *   migration. Downstream consumers filter on task_id === ORPHAN_TASK_ID
 *   to render orphans in their own pane.
 */

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import type { StoryBriefInput } from '../acb/milestone-brief';
import type { LogEntry } from '../acb/reasoning-log';
import { listEntries } from '../acb/reasoning-log-store';
import type { ScrumStore } from './store';
import { STALENESS_THRESHOLD_HOURS, TEAM_ROLES } from './types';
import type { EscalationRow, ScrumEvent, ScrumTask, TaskStatus, TeamRole } from './types';

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

/** Reserved sentinel task id that owns every `unlinked_run_detected` event. */
export const ORPHAN_TASK_ID = '__orphan__';

/** Fixed title for the lazily-created orphan sentinel task. */
export const ORPHAN_TASK_TITLE = 'Unlinked run detections';

// ---------------------------------------------------------------------------
// Team-role contribution-presence detector
// ---------------------------------------------------------------------------

/**
 * Parsed shape of a team-role agent name `team-<slug>-<role>`, returned by
 * `parseTeamAgentName`. `<role>` is one of the closed `TEAM_ROLES`; `<slug>` is
 * the non-empty remainder. A name that does not match this shape parses to null.
 */
export interface ParsedTeamAgentName {
  slug: string;
  role: TeamRole;
}

/** Leading marker every team-role agent name carries. */
const TEAM_AGENT_PREFIX = 'team-';

/**
 * Parse a `team-<slug>-<role>` agent name into its `{ slug, role }` parts, or
 * null for any name that is not a team-role seat.
 *
 * The role suffix is the disambiguator: a slug may itself contain hyphens
 * (`team-data-platform-engineer` → slug `data-platform`, role `engineer`), so we
 * anchor on the `-<role>` tail rather than splitting on `-`. Roles carry
 * underscores, never hyphens, so exactly one closed role can be a valid suffix.
 * The slug between prefix and role suffix must be non-empty — `team-engineer`
 * (no slug) is not a seat.
 */
export function parseTeamAgentName(agentName: string): ParsedTeamAgentName | null {
  if (!agentName.startsWith(TEAM_AGENT_PREFIX)) return null;
  const afterPrefix = agentName.slice(TEAM_AGENT_PREFIX.length);
  for (const role of TEAM_ROLES) {
    const suffix = `-${role}`;
    if (afterPrefix.endsWith(suffix)) {
      const slug = afterPrefix.slice(0, afterPrefix.length - suffix.length);
      if (slug.length > 0) return { slug, role };
    }
  }
  return null;
}

/**
 * Verdict of the contribution-presence detector. For a non-team agent name
 * `isTeamRoleAgent` is false and the floor is a no-op (`missed` is false). For a
 * team-role seat, `missed` is true when the event log carries NO contribution
 * stamped by that exact agent within the dispatch window.
 */
export interface ContributionMissResult {
  /** Whether `agentName` parsed as a `team-<slug>-<role>` seat. */
  isTeamRoleAgent: boolean;
  /** True only for a team-role seat with zero in-window contributions. */
  missed: boolean;
  /** The parsed role, present only for a team-role seat. */
  role?: TeamRole;
  /** The parsed team slug, present only for a team-role seat. */
  slug?: string;
}

/**
 * Did the stopping team-role agent stamp a contribution within its dispatch
 * window? A pure, store-reading correlation over the append-only event log —
 * isolated from reconciler wiring so it is unit-testable without a hook payload.
 *
 * Presence-only by design: a contribution is PRESENT when any event row for the
 * task carries `agent === agentName` AND its `ts` lands in the half-open window
 * `[windowStartTs, windowEndTs)` (the `[from_ts, to_ts)` interval convention the
 * operator/team position histories use). The stamped author is advisory — this
 * helper does NOT validate it against the position-history holder; that
 * authority check is out of scope here.
 *
 * A vacant-slot dispatch (no current holder seated for the role) is evaluated
 * identically: presence is read off the event log, never short-circuited to "no
 * miss" by an empty roster. A name that is not a team-role seat returns
 * `isTeamRoleAgent: false` so the floor never fires for general-purpose,
 * task-planner, or other non-team agents.
 */
export function detectContributionMiss(
  store: ScrumStore,
  agentName: string,
  taskId: string,
  windowStartTs: string,
  windowEndTs: string,
): ContributionMissResult {
  const parsed = parseTeamAgentName(agentName);
  if (parsed === null) return { isTeamRoleAgent: false, missed: false };

  const events = store.listEventsForTask(taskId);
  const contributed = events.some(
    (event) => event.agent === agentName && windowStartTs <= event.ts && event.ts < windowEndTs,
  );
  return {
    isTeamRoleAgent: true,
    missed: !contributed,
    role: parsed.role,
    slug: parsed.slug,
  };
}

// ---------------------------------------------------------------------------
// Return types
// ---------------------------------------------------------------------------

export interface ContextBundle {
  /**
   * Provenance trail for the task. Each entry is either a repo-relative
   * file path OR a `'commit:<sha>'` sentinel. The sentinel form is emitted
   * by `collectFilesTouched` when state.json carries commit shas but no
   * per-file diff — see that helper for the fallback rationale. Consumers
   * that only want real file paths must filter out the `commit:` prefix.
   */
  files: string[];
  decisions: Array<{ path: string; title: string }>;
  runs: Array<{
    slug: string;
    branch: string;
    completed_at: string;
    status: string;
  }>;
  summary_text: string;
}

export interface ReconcileRunResult {
  /** 'reconciled' = event(s) appended for a tracked task. */
  /** 'orphan'     = no task_id in plan.json; emitted unlinked_run_detected. */
  /** 'skipped'    = state.json malformed or missing. */
  kind: 'reconciled' | 'orphan' | 'skipped';
  taskId: string | null;
  runPath: string;
  reason?: string;
}

export interface SweepResult {
  scanned: number;
  reconciled: number;
  errors: Error[];
}

/** One escalation the staleness floor auto-bubbled, as a flat audit ref. */
export interface AutoBubbledEscalation {
  /** The closed (`auto_bubbled`) row's id. */
  from_id: number;
  /** The freshly-appended `open` row's id one rung up. */
  to_id: number;
  task_id: string;
  /** The rung the closed row sat at. */
  from_layer: EscalationRow['layer'];
  /** The rung the new open row sits at (exactly one up). */
  to_layer: EscalationRow['layer'];
  /** The closed row's age in hours at evaluation time. */
  age_hours: number;
}

export interface StaleEscalationSweepResult {
  /** Threshold (hours) the sweep evaluated against. */
  threshold_hours: number;
  /** Open rows inspected (every currently-open escalation). */
  inspected: number;
  /** Rows that crossed the threshold and were auto-bubbled. */
  bubbled: AutoBubbledEscalation[];
  /**
   * Rows past the threshold that could NOT bubble because they already sit at
   * the top of the chain (`human` — nowhere higher to walk). Reported, not
   * mutated: a `human`-rung escalation is the terminal authority's worklist.
   */
  atTopOfChain: number;
}

// ---------------------------------------------------------------------------
// Trigger bindings — declared status-transition -> bound next-action
// ---------------------------------------------------------------------------

/**
 * A declared trigger binding (mirrors `PROVE_SCHEMA.triggers[]`). A task
 * entering the `on` status surfaces `workflow` as a bound next-action. The
 * reconciler consults the table on session transitions — there is no resident
 * evaluator, so a binding fires only when a session reconciles.
 */
export interface TriggerBinding {
  on: string;
  workflow: string;
  description?: string;
}

/** A pending bound next-action the reconciler surfaces for a task in `on`. */
export interface BoundAction {
  task_id: string;
  title: string;
  status: string;
  workflow: string;
  description: string;
}

/**
 * The bindings whose `on` matches `status`. Pure consult over the declared
 * table — no store, no model, no daemon. Empty when nothing fires.
 */
export function triggerBindingsForStatus(
  triggers: TriggerBinding[],
  status: string,
): TriggerBinding[] {
  return triggers.filter((t) => t.on === status);
}

/**
 * Resolve the pending bound next-actions across the store: for every binding,
 * every non-deleted task currently sitting in its `on` status yields one
 * BoundAction. This is the session-transition surface — a task parked in a
 * triggering status (e.g. `accepted`) has a pending bound action the next
 * driver should take. Capped at `limit`; ordered by binding order then the
 * store's task order. An empty `triggers` table yields no actions.
 */
export function computeBoundActions(
  store: ScrumStore,
  triggers: TriggerBinding[],
  limit: number,
): BoundAction[] {
  const out: BoundAction[] = [];
  for (const binding of triggers) {
    for (const task of store.listTasks({ status: binding.on as TaskStatus })) {
      if (out.length >= limit) return out;
      out.push({
        task_id: task.id,
        title: task.title,
        status: task.status,
        workflow: binding.workflow,
        description: binding.description ?? '',
      });
    }
  }
  return out;
}

/**
 * The reasoning-log entry types curation surfaces as promotion candidates.
 * These four carry durable, attention-bearing signal a
 * milestone-close should lift toward `scrum_decisions`: `decision` (→ adr),
 * `hack`/`risk` (→ pattern/tracked debt), `assumption` (→ glossary/decision).
 * `bailout`/`discovery`/`context`/`synthesis`/`review_feedback`/`verification`
 * stay in the run log — they are run-local narration, not durable memory.
 */
export const CURATION_ENTRY_TYPES = ['hack', 'risk', 'decision', 'assumption'] as const;
export type CurationEntryType = (typeof CURATION_ENTRY_TYPES)[number];

/**
 * One promotion candidate inside a `curation_proposed` event. A flat ref — the
 * curation skill reads the full entry file (alternatives, cleanup_condition,
 * severity, …) from `run_path` when it needs more than the body to classify.
 */
export interface CurationCandidate {
  /** Reasoning-log entry id (the entry filename stem). */
  entry_id: string;
  type: CurationEntryType;
  /** Authoring agent (the `log/<agent>/` dir segment). */
  agent: string;
  /** Repo-relative run dir the entry was read from. */
  run_path: string;
  /** The entry's attention-bearing prose body. */
  body: string;
}

/** Payload carried by a task-scoped `curation_proposed` event. */
export interface CurationProposedPayload {
  /** The milestone whose close triggered the proposal. */
  milestone_id: string;
  candidates: CurationCandidate[];
}

/** Outcome of {@link reconcileMilestoneClosed}, one summary per milestone. */
export interface MilestoneCurationResult {
  milestoneId: string;
  /** Tasks that had findings and were not already curated for this milestone. */
  emitted: Array<{ taskId: string; candidateCount: number }>;
  /** Tasks skipped because they carried zero curation-relevant findings. */
  skippedNoFindings: number;
  /** Tasks skipped because a `curation_proposed` event already existed. */
  skippedAlreadyEmitted: number;
  /**
   * Milestone-close journal compaction (v22). One Lore summary is rolled up per
   * team TERMINATING on this milestone (`terminates_on_milestone === <id>`) from
   * the milestone journal — the curation candidates gathered across the
   * milestone's tasks. Empty when no team terminates on this milestone (a no-op
   * that leaves the per-task curation flow unchanged). Idempotent: a re-close
   * skips a team that already carries the compaction summary.
   */
  compactedTeams: Array<{ teamSlug: string; loreId: number; candidateCount: number }>;
  /** Terminating teams skipped because their compaction Lore already exists. */
  skippedAlreadyCompacted: number;
}

// ---------------------------------------------------------------------------
// Internal narrow types — stripped-down shapes of the fields we actually read
// ---------------------------------------------------------------------------

interface StateJsonLite {
  kind?: string;
  run_status?: string;
  slug?: string;
  branch?: string;
  ended_at?: string;
  started_at?: string;
  updated_at?: string;
  tasks?: Array<{
    steps?: Array<{ commit_sha?: string; status?: string }>;
  }>;
  review_verdict?: string;
  steward_verdict?: string;
}

interface PlanJsonLite {
  kind?: string;
  task_id?: string;
  tasks?: Array<{ task_id?: string }>;
}

// ---------------------------------------------------------------------------
// reconcileRunCompleted
// ---------------------------------------------------------------------------

/**
 * Read `runStatePath` + sibling `plan.json`, emit scrum events, and rebuild
 * the linked task's context bundle. Does not throw on orphan runs — returns
 * a `kind: 'orphan'` result instead. Malformed JSON returns `kind: 'skipped'`
 * with `reason` populated so callers can surface the failure.
 *
 * `projectRoot` anchors repo-relative run paths during the bundle rebuild; it
 * defaults to `process.cwd()`. The Stop-hook sweep passes the project dir it
 * resolved from the Claude Code payload so the rebuild stays correct when the
 * reconcile runs from a subdirectory or a linked worktree.
 */
export function reconcileRunCompleted(
  runStatePath: string,
  store: ScrumStore,
  projectRoot: string = process.cwd(),
): ReconcileRunResult {
  const runDir = dirname(runStatePath);
  const planPath = join(runDir, 'plan.json');

  const state = readJsonOrNull<StateJsonLite>(runStatePath);
  if (!state || state.kind !== 'state') {
    return {
      kind: 'skipped',
      taskId: null,
      runPath: runDir,
      reason: 'state.json missing or malformed',
    };
  }

  const plan = readJsonOrNull<PlanJsonLite>(planPath);
  const taskId = resolveLinkedTaskId(plan, store, runDir);

  if (taskId === null) {
    emitOrphanEvent(store, runDir, state);
    return { kind: 'orphan', taskId: null, runPath: runDir };
  }

  // Tracked run — guard missing task via a null check before mutating.
  const task = store.getTask(taskId);
  if (!task) {
    emitOrphanEvent(store, runDir, state, `task '${taskId}' not found in scrum store`);
    return {
      kind: 'orphan',
      taskId,
      runPath: runDir,
      reason: `task '${taskId}' not found`,
    };
  }

  linkRunForTask(store, taskId, runDir, state);
  appendRunCompletedEvent(store, taskId, runDir, state);
  appendStewardVerdictIfPresent(store, taskId, state);
  const blockedReason = transitionTaskIfTerminal(store, task, state);
  rebuildContextBundle(store, taskId, projectRoot);

  return { kind: 'reconciled', taskId, runPath: runDir, reason: blockedReason ?? undefined };
}

// ---------------------------------------------------------------------------
// buildContextBundle
// ---------------------------------------------------------------------------

/**
 * Aggregate the task's context for downstream agents. Pulls files touched
 * (from linked runs' state.json commit diff — cheap heuristic: run-level
 * commit_sha fanout via git is handled by Task 5's CLI; here we just read
 * what state.json already records), decisions cited (events kind
 * `decision_linked`), last 5 run summaries, and a concatenated summary of
 * recent event titles.
 *
 * `projectRoot` anchors repo-relative run paths read from linked runs'
 * state.json; it defaults to `process.cwd()`. Callers that know the project
 * root (the Stop-hook sweep resolves it from the Claude Code payload, which
 * may differ from cwd) pass it so bundle aggregation stays correct when the
 * reconcile runs from a subdirectory or a linked worktree.
 */
export function buildContextBundle(
  taskId: string,
  store: ScrumStore,
  projectRoot: string = process.cwd(),
): ContextBundle {
  const runs = store.listRunsForTask(taskId);
  const events = store.listEventsForTask(taskId, 200);

  const files = collectFilesTouched(runs, projectRoot);
  const decisions = collectDecisions(events, store);
  const runSummaries = summarizeRuns(runs, projectRoot).slice(-5);
  const summary_text = buildSummaryText(events);

  return {
    files,
    decisions,
    runs: runSummaries,
    summary_text,
  };
}

// ---------------------------------------------------------------------------
// sweepUnreconciled
// ---------------------------------------------------------------------------

/**
 * Walk `.prove/runs/<branch>/<slug>/state.json` entries, reconcile every
 * file whose mtime exceeds `sinceTs`. Errors during individual reconcile
 * calls are collected rather than thrown — callers decide whether a
 * partial sweep is acceptable.
 *
 * Runs root defaults to `<process.cwd()>/.prove/runs`. Pass `projectDir`
 * when the caller knows the project root (e.g., the Stop hook reads it
 * from the Claude Code payload's `cwd`); this keeps the walker correct
 * even when the sweep is invoked from a subdirectory.
 */
export function sweepUnreconciled(
  store: ScrumStore,
  sinceTs: number,
  projectDir?: string,
): SweepResult {
  const root = projectDir ?? process.cwd();
  const runsRoot = join(root, '.prove', 'runs');
  const result: SweepResult = { scanned: 0, reconciled: 0, errors: [] };
  if (!existsSync(runsRoot) || !isDir(runsRoot)) return result;

  for (const statePath of walkStateFiles(runsRoot)) {
    result.scanned++;
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(statePath).mtime.getTime();
    } catch {
      continue;
    }
    if (mtimeMs <= sinceTs) continue;

    try {
      const outcome = reconcileRunCompleted(statePath, store, root);
      if (outcome.kind === 'reconciled' || outcome.kind === 'orphan') {
        result.reconciled++;
      }
    } catch (err) {
      result.errors.push(err instanceof Error ? err : new Error(String(err)));
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// bubbleStaleEscalations — Forced Bubble-Up of aged escalations
// ---------------------------------------------------------------------------

/**
 * Auto-bubble every `open` escalation whose age exceeds the staleness threshold
 * one rung up the authority chain. This is the engine's escalation-of-last-
 * resort: an escalation no receiver acted on does not sit forever at one rung —
 * the staleness clock promotes it so it reaches a higher authority and surfaces
 * higher in the worklist.
 *
 * Evaluated by the reconciler hook on session-start — there is NO resident loop
 * or timer. The hook is the only firing point: the work is reconciled into state
 * on the session transition, then surfaced to whoever drives next via `alerts`
 * and the `nextReady` ranking (each bubble appends the same `blocker_raised`
 * event a hand-raised escalation does).
 *
 * `nowMs` is injected so the evaluation never reads the wall clock directly —
 * tests cross the threshold with a fixed clock, not `setTimeout`. An escalation
 * is stale when `(nowMs − created_at) > thresholdHours` (strict `>`; a row at
 * exactly the threshold is not yet stale). A stale row already at the top of the
 * chain (`human`) cannot bubble — it is counted in `atTopOfChain`, never
 * mutated. Each bubble reuses {@link ScrumStore.autoBubbleEscalation}, so the
 * marker / forward pointer / event surface are written there.
 */
export function bubbleStaleEscalations(
  store: ScrumStore,
  nowMs: number,
  thresholdHours: number = STALENESS_THRESHOLD_HOURS,
): StaleEscalationSweepResult {
  const thresholdMs = thresholdHours * 60 * 60 * 1000;
  const result: StaleEscalationSweepResult = {
    threshold_hours: thresholdHours,
    inspected: 0,
    bubbled: [],
    atTopOfChain: 0,
  };

  // Snapshot the open rows BEFORE bubbling: an auto-bubble appends a fresh open
  // row, and we must not re-evaluate that brand-new (un-aged) row in the same
  // pass. Iterating the snapshot keeps the sweep single-rung-per-escalation.
  for (const escalation of store.listOpenEscalationRows()) {
    result.inspected++;
    const ageMs = ageMillis(escalation.created_at, nowMs);
    if (ageMs === null || ageMs <= thresholdMs) continue;

    const nextLayer = nextLayerOf(escalation);
    if (nextLayer === null) {
      result.atTopOfChain++;
      continue;
    }

    const bubbled = store.autoBubbleEscalation(escalation.id, new Date(nowMs).toISOString());
    result.bubbled.push({
      from_id: escalation.id,
      to_id: bubbled.id,
      task_id: escalation.task_id,
      from_layer: escalation.layer,
      to_layer: bubbled.layer,
      age_hours: Math.floor(ageMs / (60 * 60 * 1000)),
    });
  }

  return result;
}

/** Age in ms of an escalation against `nowMs`, or null when `created_at` is unparseable. */
function ageMillis(createdAt: string, nowMs: number): number | null {
  const ms = Date.parse(createdAt);
  if (Number.isNaN(ms)) return null;
  return Math.max(0, nowMs - ms);
}

/** The rung one above an escalation's, or null when it already sits at the top. */
function nextLayerOf(escalation: EscalationRow): EscalationRow['layer'] | null {
  const idx = ESCALATION_CHAIN_ORDER.indexOf(escalation.layer);
  if (idx < 0 || idx + 1 >= ESCALATION_CHAIN_ORDER.length) return null;
  return ESCALATION_CHAIN_ORDER[idx + 1] ?? null;
}

/**
 * Bottom-to-top rung order, mirroring the store's `ESCALATION_CHAIN`. Inlined as
 * a local const so this module's top-of-chain check needs no store round-trip;
 * the store boundary remains the authority that rejects a bubble past `human`.
 */
const ESCALATION_CHAIN_ORDER: EscalationRow['layer'][] = [
  'implementer',
  'engineer',
  'tech_lead',
  'pm',
  'strategy',
  'human',
];

// ---------------------------------------------------------------------------
// reconcileMilestoneClosed — Forced Bubble-Up of curation candidates
// ---------------------------------------------------------------------------

/**
 * On milestone close, walk every task in the milestone, gather the
 * curation-relevant reasoning-log findings across its linked runs, and emit
 * one task-scoped `curation_proposed` event per task that has any. The work
 * surfaces structurally on the close transition rather than as opt-in
 * hygiene. The reasoning log is write-only until this runs; the event is what
 * the curation *skill* reads to propose Journal→Codex promotions.
 *
 * Engine side only: this surfaces candidates mechanically. The judgment —
 * which findings become durable `scrum_decisions`, and as what `kind` — is the
 * model-owned curation skill.
 *
 * Idempotent two ways: (1) a task already carrying a `curation_proposed`
 * event for this milestone is skipped, so a re-close never double-emits;
 * (2) a task with zero findings is a no-op. `projectDir` resolves repo-relative
 * run paths (defaults to `process.cwd()`); the CLI passes the workspace root.
 *
 * Milestone-close journal compaction (v22): in the SAME close transition, the
 * milestone journal — every curation candidate gathered across the milestone's
 * tasks — is rolled up into ONE Lore summary per team TERMINATING on this
 * milestone (`terminates_on_milestone === milestoneId`). When no team terminates
 * on the milestone, this is a no-op and the per-task curation flow above is
 * unchanged. The rollup is a deterministic concatenation the engine surfaces; the
 * model refines it later.
 */
export function reconcileMilestoneClosed(
  milestoneId: string,
  store: ScrumStore,
  projectDir?: string,
): MilestoneCurationResult {
  const root = projectDir ?? process.cwd();
  const result: MilestoneCurationResult = {
    milestoneId,
    emitted: [],
    skippedNoFindings: 0,
    skippedAlreadyEmitted: 0,
    compactedTeams: [],
    skippedAlreadyCompacted: 0,
  };

  // The full milestone journal — every curation candidate across every task —
  // is gathered once, both to drive the per-task curation events and to feed the
  // per-terminating-team Lore compaction below.
  const journal: CurationCandidate[] = [];

  for (const task of store.listTasks({ milestoneId })) {
    const candidates = collectCurationCandidates(store, task.id, root);
    journal.push(...candidates);
    if (hasCurationEventForMilestone(store, task.id, milestoneId)) {
      result.skippedAlreadyEmitted++;
      continue;
    }
    if (candidates.length === 0) {
      result.skippedNoFindings++;
      continue;
    }
    const payload: CurationProposedPayload = { milestone_id: milestoneId, candidates };
    store.appendEvent({ taskId: task.id, kind: 'curation_proposed', payload });
    result.emitted.push({ taskId: task.id, candidateCount: candidates.length });
  }

  compactJournalForTerminatingTeams(milestoneId, journal, store, result);

  return result;
}

/**
 * Deterministic marker embedded in a milestone-close compaction Lore body, used
 * as the per-(team, milestone) idempotency key. A re-close skips a terminating
 * team that already carries a Lore entry whose body opens with this marker, so
 * compaction never double-writes — mirroring the per-task `curation_proposed`
 * dedup that guards the curation flow.
 */
function compactionMarker(milestoneId: string): string {
  return `[milestone-close-summary:${milestoneId}]`;
}

/**
 * Author id stamped on an engine-written compaction Lore. After a milestone
 * close, a terminating team's roster is vacated, so no tech_lead is seated to
 * author against — `recordLore` warn-allows the write (the team-of-one /
 * bootstrapping tolerance). A fixed, recognizable id marks the rollup as
 * engine-surfaced rather than a human-authored convention.
 */
const COMPACTION_AUTHOR_ID = 'ct-engine-compaction';

/**
 * Roll the milestone journal into one Lore summary per team terminating on this
 * milestone. The terminating set is determinable from the team registry alone:
 * every team whose `terminates_on_milestone` names this milestone, regardless of
 * its current status (after a close the matching teams are already `inactive`,
 * but they are still the right rollup targets). No terminating team → no-op.
 *
 * Idempotent: a team already carrying a compaction Lore for this milestone (its
 * body opens with {@link compactionMarker}) is skipped, so a re-close never
 * double-writes. The rollup body is a deterministic concatenation of the
 * journal's candidate bodies — the engine surfaces a faithful starting point;
 * the model refines it later.
 */
function compactJournalForTerminatingTeams(
  milestoneId: string,
  journal: CurationCandidate[],
  store: ScrumStore,
  result: MilestoneCurationResult,
): void {
  const marker = compactionMarker(milestoneId);
  const terminating = store
    .listTeams()
    .filter((team) => team.terminates_on_milestone === milestoneId);

  for (const team of terminating) {
    if (store.listLores(team.slug).some((lore) => lore.body.startsWith(marker))) {
      result.skippedAlreadyCompacted++;
      continue;
    }
    const body = renderCompactionLore(marker, team.slug, journal);
    const { row } = store.recordLore({
      teamSlug: team.slug,
      body,
      authorContributorId: COMPACTION_AUTHOR_ID,
    });
    result.compactedTeams.push({
      teamSlug: team.slug,
      loreId: row.id,
      candidateCount: journal.length,
    });
  }
}

/**
 * Render the deterministic milestone-close compaction Lore body for one team. The
 * body opens with the idempotency marker, then concatenates each journal
 * candidate as a typed bullet. An empty journal still produces a valid summary
 * (the marker plus a "no findings" line) so the rollup is recorded for every
 * terminating team — the model can prune it later.
 */
function renderCompactionLore(
  marker: string,
  teamSlug: string,
  journal: CurationCandidate[],
): string {
  const header = `${marker} Journal compaction for team '${teamSlug}' at milestone close.`;
  if (journal.length === 0) {
    return `${header}\n\n(no curation-relevant findings in the milestone journal)`;
  }
  const bullets = journal
    .map((candidate) => `- [${candidate.type}] ${candidate.body} (from ${candidate.run_path})`)
    .join('\n');
  return `${header}\n\n${bullets}`;
}

// ---------------------------------------------------------------------------
// gatherMilestoneStories — assemble the milestone-brief rollup input
// ---------------------------------------------------------------------------

/**
 * Reduce every task in a milestone to one `StoryBriefInput`, merging the
 * reasoning-log entries across the task's linked runs. This is the mechanical
 * input the milestone brief synthesizes from: each story carries its
 * attention-bearing entries (so the recursive preservation rule can prove none
 * was dropped), its decisions, its shipped outcome, and — for a story that did
 * not ship — its recorded terminal reason. The judgment of what the rollup
 * *says* is the synthesizer skill's; this only gathers.
 *
 * A story `shipped` when its status is `done`. `outcome` is the body of its
 * latest `synthesis` entry (the worker's hand-off-of-record). A run whose log
 * dir is malformed is skipped rather than aborting the whole gather — a corrupt
 * log must not block a milestone brief from rendering. `projectDir` resolves
 * repo-relative run paths (defaults to `process.cwd()`); the CLI passes the
 * workspace root.
 */
export function gatherMilestoneStories(
  milestoneId: string,
  store: ScrumStore,
  projectDir?: string,
): StoryBriefInput[] {
  const root = projectDir ?? process.cwd();
  const stories: StoryBriefInput[] = [];

  for (const task of store.listTasks({ milestoneId })) {
    const entries = collectStoryEntries(store, task.id, root);
    stories.push({
      story_id: task.id,
      title: task.title,
      shipped: task.status === 'done',
      entries,
      outcome: latestSynthesisOutcome(entries),
      terminal_reason: task.terminal_reason,
      terminal_detail: task.terminal_detail,
    });
  }

  return stories;
}

/**
 * Merge every linked run's reasoning log for a task, deduped by entry id (the
 * same entry can surface through more than one linked run-path form). Sorted by
 * `ts` so attention/decision derivation reads in chronological order.
 */
function collectStoryEntries(store: ScrumStore, taskId: string, projectDir: string): LogEntry[] {
  const merged: LogEntry[] = [];
  const seen = new Set<string>();

  for (const run of store.listRunsForTask(taskId)) {
    const runDir = isAbsolute(run.run_path) ? run.run_path : join(projectDir, run.run_path);
    let entries: LogEntry[];
    try {
      entries = listEntries(runDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      merged.push(entry);
    }
  }

  merged.sort((a, b) => (a.ts === b.ts ? cmpAsc(a.id, b.id) : cmpAsc(a.ts, b.ts)));
  return merged;
}

/** The body of the latest `synthesis` entry, or empty when the story has none. */
function latestSynthesisOutcome(entries: LogEntry[]): string {
  let outcome = '';
  for (const entry of entries) {
    if (entry.type === 'synthesis') outcome = entry.outcome;
  }
  return outcome;
}

function cmpAsc(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * True when `taskId` already carries a `curation_proposed` event naming
 * `milestoneId`. The dedup key is the milestone so the same task can be
 * curated under more than one milestone over its life, but never twice for
 * the same close.
 */
function hasCurationEventForMilestone(
  store: ScrumStore,
  taskId: string,
  milestoneId: string,
): boolean {
  for (const event of store.listEventsForTask(taskId, 1000)) {
    if (event.kind !== 'curation_proposed') continue;
    const payload = event.payload;
    if (isRecord(payload) && payload.milestone_id === milestoneId) return true;
  }
  return false;
}

/**
 * Read every linked run's reasoning log, keep the curation-relevant entry
 * types, and dedup by entry id (the same entry can surface through more than
 * one linked run-path form). A run whose log dir is malformed is skipped
 * rather than aborting the whole milestone curation — a corrupt log file must
 * not block a milestone from closing.
 */
function collectCurationCandidates(
  store: ScrumStore,
  taskId: string,
  projectDir: string,
): CurationCandidate[] {
  const candidates: CurationCandidate[] = [];
  const seen = new Set<string>();

  for (const run of store.listRunsForTask(taskId)) {
    const runDir = isAbsolute(run.run_path) ? run.run_path : join(projectDir, run.run_path);
    let entries: LogEntry[];
    try {
      entries = listEntries(runDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!isCurationEntryType(entry.type)) continue;
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      candidates.push({
        entry_id: entry.id,
        type: entry.type,
        agent: entry.agent,
        run_path: run.run_path,
        body: entry.body,
      });
    }
  }

  return candidates;
}

function isCurationEntryType(type: LogEntry['type']): type is CurationEntryType {
  return (CURATION_ENTRY_TYPES as readonly string[]).includes(type);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Internals — tracked-run helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the scrum task a run belongs to, tolerating either layer carrying
 * the link so the two can never permanently diverge into orphan split-brain:
 *
 *   1. top-level `plan.task_id`         — the canonical self-describing form
 *      written by `scrum link-run` and orchestrator run init.
 *   2. nested `plan.tasks[n].task_id`   — a stray placement some compile paths
 *      emit; recognized so such a run is tracked rather than orphaned forever.
 *   3. store run-link reverse lookup    — authoritative fallback. A run linked
 *      in the store but whose plan.json was never updated (e.g. an older link)
 *      still reconciles instead of re-emitting unlinked_run_detected on every
 *      sweep.
 *
 * Returns null only when no layer knows the link — a genuine orphan.
 */
function resolveLinkedTaskId(
  plan: PlanJsonLite | null,
  store: ScrumStore,
  runDir: string,
): string | null {
  if (plan && typeof plan.task_id === 'string' && plan.task_id.length > 0) {
    return plan.task_id;
  }
  if (plan && Array.isArray(plan.tasks)) {
    for (const task of plan.tasks) {
      if (task && typeof task.task_id === 'string' && task.task_id.length > 0) {
        return task.task_id;
      }
    }
  }
  const linked = store.getTaskForRun(toRunPath(runDir));
  return linked?.id ?? null;
}

function linkRunForTask(
  store: ScrumStore,
  taskId: string,
  runDir: string,
  state: StateJsonLite,
): void {
  const runPath = toRunPath(runDir);
  store.linkRun({
    taskId,
    runPath,
    branch: typeof state.branch === 'string' ? state.branch : null,
    slug: typeof state.slug === 'string' ? state.slug : null,
  });
}

function appendRunCompletedEvent(
  store: ScrumStore,
  taskId: string,
  runDir: string,
  state: StateJsonLite,
): void {
  store.appendEvent({
    taskId,
    kind: 'run_completed',
    payload: {
      run_path: toRunPath(runDir),
      run_status: state.run_status ?? 'unknown',
      branch: state.branch ?? null,
      slug: state.slug ?? null,
      ended_at: state.ended_at ?? state.updated_at ?? '',
    },
  });
}

function appendStewardVerdictIfPresent(
  store: ScrumStore,
  taskId: string,
  state: StateJsonLite,
): void {
  const verdict = state.steward_verdict ?? state.review_verdict;
  if (!verdict) return;
  store.appendEvent({
    taskId,
    kind: 'steward_verdict',
    payload: { verdict },
  });
}

/**
 * Only `completed` runs drive the task to `done`. Halted/failed runs leave
 * status alone — the orchestrator may retry, and a human review may still
 * push the task forward.
 *
 * Returns `null` when the task transitioned (or no transition was due), and a
 * surfaceable message when the transition was attempted but the store rejected
 * it. Two rejection classes are distinguished:
 *   - An illegal-edge rejection (`invalid transition ...`) is an expected
 *     no-op — the run_completed event already records the outcome, so it is
 *     swallowed silently and returns `null`.
 *   - A story close-floor rejection (unmet acceptance criteria, missing
 *     synthesis) or store corruption means the engine TRIED to close the story
 *     and could not — exactly the condition the close-floors exist to catch.
 *     Its message is returned so the caller can carry it on the reconcile
 *     result instead of losing it, rather than reporting a clean reconcile that
 *     masks a story stuck short of `done`.
 */
function transitionTaskIfTerminal(
  store: ScrumStore,
  task: ScrumTask,
  state: StateJsonLite,
): string | null {
  if (state.run_status !== 'completed') return null;
  if (task.status === 'done' || task.status === 'cancelled') return null;

  try {
    store.updateTaskStatus(task.id, 'done');
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('invalid transition')) return null;
    return message;
  }
}

function rebuildContextBundle(store: ScrumStore, taskId: string, projectRoot: string): void {
  const bundle = buildContextBundle(taskId, store, projectRoot);
  store.saveContextBundle(taskId, bundle);
}

// ---------------------------------------------------------------------------
// Shared orphan predicate — consumed by reconciler and alerts alike
// ---------------------------------------------------------------------------

/**
 * True when a run directory is a genuine orphan: none of the three link-resolution
 * layers (`plan.task_id`, `plan.tasks[n].task_id`, store reverse lookup) can identify
 * a linked scrum task.
 *
 * Exported so `scrum alerts` can apply the same predicate as the reconciler, keeping
 * both surfaces in sync. Reads `plan.json` from `runDir` (non-throwing; a missing or
 * malformed file is treated as no plan-side link and falls through to the store lookup).
 */
export function isRunOrphan(runDir: string, store: ScrumStore): boolean {
  const planPath = join(runDir, 'plan.json');
  const plan = readJsonOrNull<PlanJsonLite>(planPath);
  return resolveLinkedTaskId(plan, store, runDir) === null;
}

// ---------------------------------------------------------------------------
// Internals — orphan path
// ---------------------------------------------------------------------------

/**
 * True when an `unlinked_run_detected` event for `runPath` + `reason` already
 * exists in the store. Guards `emitOrphanEvent` so repeated reconcile sweeps
 * emit exactly one event per run per orphan reason.
 *
 * The dedup key is (run_path, reason): a run that re-orphans for a DIFFERENT
 * reason emits a new event. A run that re-orphans for the SAME reason after
 * being linked and then unlinked again stays suppressed — this is the accepted
 * limitation of log-keyed dedup (the historical event wins).
 *
 * The query is targeted via SQL WHERE on `json_extract` so it is not
 * window-bounded; it stays correct regardless of how many orphan events have
 * accumulated on the sentinel task.
 */
function hasOrphanEventForRun(store: ScrumStore, runPath: string, reason: string): boolean {
  return store.hasOrphanEventForRunPath(runPath, reason);
}

function emitOrphanEvent(
  store: ScrumStore,
  runDir: string,
  state: StateJsonLite,
  extraReason?: string,
): void {
  ensureOrphanTask(store);
  const runPath = toRunPath(runDir);
  const reason = extraReason ?? 'plan.json missing task_id';
  if (hasOrphanEventForRun(store, runPath, reason)) return;
  store.appendEvent({
    taskId: ORPHAN_TASK_ID,
    kind: 'unlinked_run_detected',
    payload: {
      run_path: runPath,
      run_status: state.run_status ?? 'unknown',
      branch: state.branch ?? null,
      slug: state.slug ?? null,
      reason,
    },
  });
}

/**
 * Guarantee the orphan sentinel exists and is live. Three cases:
 *   - live row     → nothing to do.
 *   - soft-deleted → revive it (clear `deleted_at`). A plain `createTask`
 *     here would hit `UNIQUE constraint failed: scrum_tasks.id` because the
 *     row physically exists, escaping the reconciler and failing every orphan
 *     run thereafter — so we restore the sentinel's always-present invariant
 *     instead of re-inserting.
 *   - absent       → create it.
 */
function ensureOrphanTask(store: ScrumStore): void {
  if (store.getTask(ORPHAN_TASK_ID)) return;
  if (store.getTaskIncludingDeleted(ORPHAN_TASK_ID)) {
    store.undeleteTask(ORPHAN_TASK_ID);
    return;
  }
  store.createTask({
    id: ORPHAN_TASK_ID,
    title: ORPHAN_TASK_TITLE,
    description: 'Sentinel task collecting unlinked_run_detected events.',
    status: 'backlog',
  });
}

// ---------------------------------------------------------------------------
// Internals — context bundle aggregation
// ---------------------------------------------------------------------------

function collectFilesTouched(
  runs: ReturnType<ScrumStore['listRunsForTask']>,
  projectRoot: string,
): string[] {
  const seen = new Set<string>();
  for (const run of runs) {
    const statePath = resolveRunStatePath(run.run_path, projectRoot);
    const state = readJsonOrNull<StateJsonLite>(statePath);
    if (!state || !Array.isArray(state.tasks)) continue;
    // state.json v1 carries no per-file diffs; fall back to commit shas so
    // the bundle still records provenance.
    for (const task of state.tasks) {
      if (!Array.isArray(task.steps)) continue;
      for (const step of task.steps) {
        if (typeof step.commit_sha === 'string' && step.commit_sha) {
          seen.add(`commit:${step.commit_sha}`);
        }
      }
    }
  }
  return Array.from(seen).sort();
}

/**
 * Collect decisions linked to a task, reading two payload shapes:
 *
 *   - v2 (current): `{ decision_id, decision_path }` emitted by the
 *     `scrum task link-decision` CLI after task 2.1. Title is looked up in
 *     `scrum_decisions` when the store is supplied.
 *   - v1 (legacy): `{ path, title }` — left behind by seeded events from
 *     `scrum init` and pre-2.1 event payloads. Preserved for back-compat
 *     so older `.prove/prove.db` files keep rendering.
 *
 * `decision_id` is the new canonical key; consumers that want the slug
 * should prefer it. `path` stays on the output shape for UI continuity.
 */
function collectDecisions(
  events: ScrumEvent[],
  store?: ScrumStore,
): Array<{ path: string; title: string }> {
  const out: Array<{ path: string; title: string }> = [];
  for (const event of events) {
    if (event.kind !== 'decision_linked') continue;
    const payload = event.payload as Record<string, unknown> | null;
    if (!payload) continue;

    const legacyPath = typeof payload.path === 'string' ? payload.path : '';
    const legacyTitle = typeof payload.title === 'string' ? payload.title : '';
    const decisionPath = typeof payload.decision_path === 'string' ? payload.decision_path : '';
    const decisionId = typeof payload.decision_id === 'string' ? payload.decision_id : '';

    const path = decisionPath || legacyPath;
    let title = legacyTitle;
    if (!title && decisionId && store) {
      title = store.getDecision(decisionId)?.title ?? '';
    }

    if (path) out.push({ path, title });
  }
  return out;
}

function summarizeRuns(
  runs: ReturnType<ScrumStore['listRunsForTask']>,
  projectRoot: string,
): ContextBundle['runs'] {
  return runs.map((run) => {
    const statePath = resolveRunStatePath(run.run_path, projectRoot);
    const state = readJsonOrNull<StateJsonLite>(statePath);
    return {
      slug: run.slug ?? '',
      branch: run.branch ?? '',
      completed_at: state?.ended_at ?? state?.updated_at ?? run.linked_at,
      status: state?.run_status ?? 'unknown',
    };
  });
}

function buildSummaryText(events: ScrumEvent[]): string {
  // Newest-first already (listEventsForTask order); cap at 10 for bundle size.
  const lines: string[] = [];
  for (const event of events.slice(0, 10)) {
    lines.push(`[${event.ts}] ${event.kind}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Internals — filesystem + JSON helpers
// ---------------------------------------------------------------------------

/** Walk `<runsRoot>/<branch>/<slug>/state.json` — matches run-state layout. */
function* walkStateFiles(runsRoot: string): Iterable<string> {
  let branches: string[];
  try {
    branches = readdirSync(runsRoot);
  } catch {
    return;
  }
  for (const branch of branches) {
    const branchDir = join(runsRoot, branch);
    if (!isDir(branchDir)) continue;
    let slugs: string[];
    try {
      slugs = readdirSync(branchDir);
    } catch {
      continue;
    }
    for (const slug of slugs) {
      const statePath = join(branchDir, slug, 'state.json');
      if (existsSync(statePath)) yield statePath;
    }
  }
}

function readJsonOrNull<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Normalize `runDir` into a repo-relative path (matches Task 1's
 * `linkRun(runPath: '.prove/runs/...')` convention). Falls back to the
 * absolute path when `runDir` lives outside `process.cwd()`. Uses
 * realpath on both sides so macOS tmpdir symlinks (/var vs /private/var)
 * don't produce spurious `../../..` traversals.
 */
function toRunPath(runDir: string): string {
  const cwdReal = safeRealpath(process.cwd());
  const dirReal = safeRealpath(runDir);
  const rel = relative(cwdReal, dirReal);
  if (rel && !rel.startsWith('..')) return rel;
  return runDir;
}

/**
 * Resolve `join(projectRoot, runPath)` with an absolute-path shortcut so
 * bundle aggregation handles both stored forms (repo-relative + absolute).
 * `projectRoot` anchors repo-relative run paths; the sweep passes the
 * project dir it already resolved so the lookup stays correct when the
 * reconcile is invoked from a subdirectory or a linked worktree (matching
 * the `isAbsolute` anchoring `collectStoryEntries` uses).
 */
function resolveRunStatePath(runPath: string, projectRoot: string): string {
  if (isAbsolute(runPath)) return join(runPath, 'state.json');
  return join(projectRoot, runPath, 'state.json');
}

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}
