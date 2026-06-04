/**
 * End-of-session handoff/synthesis gate.
 *
 * A worker session that touched an artifact must not end silently: it must
 * either declare the work COMPLETED or hand it off with a recognized reason.
 * This module evaluates that floor from the active run's reasoning log and,
 * when the floor is unmet, renders the actionable remediation the Stop /
 * SubagentStop hook returns as a `decision: block` payload.
 *
 * Why a floor: a session that edited files but recorded no synthesis loses
 * its episode's outcome — the next driver inherits a diff with no rationale
 * and no resume plan. The gate forces the worker to write the one entry that
 * makes the handoff a clean break.
 *
 * The declaration lives inside the existing `synthesis` reasoning-log entry's
 * `outcome` field — no new entry type. A compliant `outcome` is one of:
 *
 *   - `completed`            — the work is done; no handoff is needed.
 *   - `handoff:<reason>`     — the work is paused; `<reason>` names WHY, drawn
 *                              from the closed {@link HANDOFF_REASONS} set.
 *
 * Trailing prose after the token is allowed (`completed — shipped login`);
 * the token is the machine-checkable prefix the gate parses.
 */

import { existsSync } from 'node:fs';
import { DEV_INVOCATION_PREFIX } from '@claude-prove/installer';
import type { LogEntry } from '../acb/reasoning-log';
import { listEntries } from '../acb/reasoning-log-store';

// ---------------------------------------------------------------------------
// Closed enums
// ---------------------------------------------------------------------------

/**
 * Tools whose capture entry proves the session MUTATED an artifact. A session
 * that only read files (`Read`) or ran read-only Bash never trips the gate —
 * there is no episode outcome to lose. `Bash` counts because it routinely
 * mutates (writes files, runs migrations, commits); the gate fails closed on
 * the side of requiring a synthesis rather than letting a mutating session
 * slip through unrecorded.
 */
export const ARTIFACT_TOUCHING_TOOLS = new Set([
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Bash',
]);

/**
 * The closed set of reasons a session may hand off incomplete work. Closed by
 * design (matching every other taxonomy in the store): a free-form reason
 * would let "vibe" handoffs name the pause by feel rather than by the concrete
 * condition that stopped the work. Extending this set is a deliberate change,
 * not an ad-hoc string.
 *
 *   - `context_budget`    — the session ran out of context/token budget.
 *   - `blocked`           — an unmet hard dependency blocks further progress.
 *   - `checkpoint`        — a cooperative early stop was requested mid-flight.
 *   - `scope_boundary`    — the remaining work belongs to a different task.
 *   - `needs_decision`    — progress requires an operator/architect decision.
 */
export const HANDOFF_REASONS = [
  'context_budget',
  'blocked',
  'checkpoint',
  'scope_boundary',
  'needs_decision',
] as const;

export type HandoffReason = (typeof HANDOFF_REASONS)[number];

/** The synthesis-outcome token that declares the work finished. */
export const COMPLETED_OUTCOME = 'completed';

/** The prefix a handoff outcome must carry before its reason token. */
export const HANDOFF_OUTCOME_PREFIX = 'handoff:';

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

/**
 * Why the gate decided as it did. `compliant` passes; every other reason
 * blocks and drives a distinct remediation message:
 *   - `no_artifact_touched`  — nothing mutated, so no declaration is required.
 *   - `no_run`               — no active run dir resolved; nothing to gate.
 *   - `log_unreadable`       — the reasoning log could not be read.
 *   - `missing_synthesis`    — artifact touched but no synthesis entry exists.
 *   - `invalid_declaration`  — a synthesis exists but its outcome declares
 *                              neither `completed` nor a valid `handoff:<reason>`.
 */
export type GateReason =
  | 'compliant'
  | 'no_artifact_touched'
  | 'no_run'
  | 'log_unreadable'
  | 'missing_synthesis'
  | 'invalid_declaration';

export interface GateVerdict {
  /** True when the session may end. False blocks with `reason` + `message`. */
  ok: boolean;
  reason: GateReason;
  /** Actionable remediation text; empty when `ok`. */
  message: string;
}

const PASS = (reason: GateReason): GateVerdict => ({ ok: true, reason, message: '' });

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate the end-of-session gate for one run directory. Pure read — never
 * mutates the run. A session that touched no artifact, or whose run dir/log is
 * absent, passes (there is nothing to declare). A session that touched an
 * artifact must carry a compliant synthesis declaration or the verdict blocks.
 *
 * `devMode` only shapes the remediation command prefix in the block message;
 * it has no effect on the pass/block decision.
 */
export function evaluateSessionEndGate(runDir: string | null, devMode = false): GateVerdict {
  if (!runDir || !existsSync(runDir)) return PASS('no_run');

  let entries: LogEntry[];
  try {
    entries = listEntries(runDir);
  } catch {
    // A malformed log makes the touched/synthesis state unknowable. Pass
    // rather than block: the gate must not wall a session behind a corrupt
    // log file it cannot parse. The synthesis-floor on story close still
    // fails closed where it can read the log.
    return PASS('log_unreadable');
  }

  if (!sessionTouchedArtifact(entries)) return PASS('no_artifact_touched');

  const synthesis = latestSynthesis(entries);
  if (!synthesis) {
    return block('missing_synthesis', renderMissingSynthesis(runDir, devMode));
  }

  if (!isCompliantOutcome(synthesis.outcome)) {
    return block(
      'invalid_declaration',
      renderInvalidDeclaration(synthesis.outcome, runDir, devMode),
    );
  }

  return PASS('compliant');
}

function block(reason: GateReason, message: string): GateVerdict {
  return { ok: false, reason, message };
}

/**
 * True when any `capture` entry names an artifact-mutating tool. Capture
 * entries are engine-written by the PostToolUse hook, so they are the
 * authoritative what-happened record — the gate reads them rather than
 * re-deriving touched-state from git.
 */
function sessionTouchedArtifact(entries: LogEntry[]): boolean {
  return entries.some((e) => e.type === 'capture' && ARTIFACT_TOUCHING_TOOLS.has(e.tool));
}

/** The most-recent `synthesis` entry (entries arrive `ts`-sorted ascending). */
function latestSynthesis(entries: LogEntry[]): Extract<LogEntry, { type: 'synthesis' }> | null {
  let found: Extract<LogEntry, { type: 'synthesis' }> | null = null;
  for (const entry of entries) {
    if (entry.type === 'synthesis') found = entry;
  }
  return found;
}

/**
 * A compliant synthesis outcome declares either completion or a valid handoff.
 * The token is the leading word (`completed`) or `handoff:<reason>` prefix;
 * trailing prose is allowed and ignored.
 */
export function isCompliantOutcome(outcome: string): boolean {
  return classifyOutcome(outcome) !== null;
}

/**
 * Classify a synthesis outcome into its declaration token, or null when it
 * declares neither completion nor a recognized handoff reason. Whitespace is
 * trimmed; the completion token is matched as a leading whole word so
 * `completed` and `completed — shipped X` both classify, but `completedish`
 * does not.
 */
export function classifyOutcome(
  outcome: string,
): { kind: 'completed' } | { kind: 'handoff'; reason: HandoffReason } | null {
  const trimmed = outcome.trim();

  if (trimmed === COMPLETED_OUTCOME || trimmed.startsWith(`${COMPLETED_OUTCOME} `)) {
    return { kind: 'completed' };
  }

  if (trimmed.startsWith(HANDOFF_OUTCOME_PREFIX)) {
    const rest = trimmed.slice(HANDOFF_OUTCOME_PREFIX.length);
    // The reason token runs up to the first whitespace; trailing prose ignored.
    const reasonToken = rest.split(/\s/, 1)[0] ?? '';
    if (isHandoffReason(reasonToken)) return { kind: 'handoff', reason: reasonToken };
  }

  return null;
}

function isHandoffReason(value: string): value is HandoffReason {
  return (HANDOFF_REASONS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Remediation rendering
// ---------------------------------------------------------------------------

/**
 * The `acb log append` invocation prefix, branched on dev_mode so the emitted
 * command resolves on the user's machine: installed users get the bare
 * `claude-prove`; plugin developers get the shell-interpolated working-tree
 * form that `$CLAUDE_PROVE_PLUGIN_DIR` resolves when the command runs.
 */
function logAppendCommand(devMode: boolean): string {
  return devMode ? `${DEV_INVOCATION_PREFIX} acb log append` : 'claude-prove acb log append';
}

function renderMissingSynthesis(runDir: string, devMode: boolean): string {
  return [
    'BLOCKED — this session edited artifacts but recorded no synthesis. You cannot end the session without declaring its outcome.',
    '',
    'Write ONE synthesis reasoning-log entry whose `outcome` is either:',
    `  - \`${COMPLETED_OUTCOME}\` — the work is done; or`,
    `  - \`${HANDOFF_OUTCOME_PREFIX}<reason>\` — the work is paused, where <reason> is one of: ${HANDOFF_REASONS.join(', ')}.`,
    '',
    'Compose the entry JSON with the Write tool, then append it:',
    `  ${logAppendCommand(devMode)} --run-dir ${runDir} --file <entry.json>`,
    '',
    'Then end the session again.',
  ].join('\n');
}

function renderInvalidDeclaration(outcome: string, runDir: string, devMode: boolean): string {
  return [
    `BLOCKED — this session's synthesis outcome (\`${truncate(outcome)}\`) declares neither completion nor a recognized handoff.`,
    '',
    'Append a synthesis entry whose `outcome` is either:',
    `  - \`${COMPLETED_OUTCOME}\` — the work is done; or`,
    `  - \`${HANDOFF_OUTCOME_PREFIX}<reason>\` — the work is paused, where <reason> is one of: ${HANDOFF_REASONS.join(', ')}.`,
    '',
    'Compose the corrected entry JSON with the Write tool, then append it:',
    `  ${logAppendCommand(devMode)} --run-dir ${runDir} --file <entry.json>`,
    '',
    'Then end the session again.',
  ].join('\n');
}

/** Clip an echoed outcome so the block message stays compact. */
function truncate(value: string): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length <= 80 ? collapsed : `${collapsed.slice(0, 79)}…`;
}
