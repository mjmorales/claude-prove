/**
 * Per-action usage registry — one source of truth for action-scoped `--help`
 * and full-usage argument errors.
 *
 * The CLI mounts each topic as a single cac command (`scrum <action> ...`,
 * `run-state <action> ...`) carrying every flag any sub-action accepts. That
 * makes cac's built-in `--help` a flat ~60-flag dump and makes positional
 * errors discoverable only by failing repeatedly. This registry maps each
 * `topic action[ subaction]` to its positionals and the subset of flags that
 * scope to it, and BOTH consumers read it:
 *
 *   - the help renderer (`renderActionHelp`) prints
 *     `Usage: claude-prove <topic> <action> <pos1> <pos2> [flags]` plus only
 *     that action's flags, pulling each flag's description live off the cac
 *     command so descriptions never drift from a parallel table.
 *   - the error path (`actionUsageError`) prints the same usage line (all
 *     positionals named at once) plus the specific missing-arg message.
 *
 * Coverage is incremental: `scrum` and `run-state` — the worst offenders — are
 * registered end to end. Unregistered topics/actions fall back to cac's stock
 * help, so nothing regresses.
 */

import type { CAC, Command } from 'cac';

/**
 * One registered action's shape. `positionals` are rendered in order into the
 * usage line and listed together in an error message. `flags` are the long
 * option names (without the leading `--`) that scope to this action; the help
 * renderer filters the topic command's full option list down to these.
 */
export interface ActionSpec {
  /** Ordered positional argument names, e.g. `['task-id', 'run-path']`. */
  positionals: string[];
  /** Long flag names (no `--`) scoped to this action, e.g. `['branch', 'slug']`. */
  flags: string[];
  /** Optional one-line summary shown under the usage line. */
  summary?: string;
}

/** A topic's action table, keyed by `action` or `action subaction`. */
export type TopicActions = Record<string, ActionSpec>;

/** The full registry, keyed by topic name. */
export type ActionRegistry = Record<string, TopicActions>;

/**
 * Build the lookup key for an invocation. Two-token actions (e.g.
 * `task create`, `validator set`) register under `'<action> <subaction>'`;
 * single-token actions (e.g. `status`, `link-run`) under `'<action>'`.
 */
export function actionKey(action: string, subAction?: string): string {
  return subAction ? `${action} ${subAction}` : action;
}

/**
 * Resolve the spec for a `topic action[ subaction]` invocation, preferring the
 * two-token form when a sub-action is present and falling back to the
 * single-token action. Returns undefined when neither is registered.
 */
export function lookupAction(
  registry: ActionRegistry,
  topic: string,
  action: string,
  subAction?: string,
): { key: string; spec: ActionSpec } | undefined {
  const topicActions = registry[topic];
  if (!topicActions) return undefined;
  if (subAction) {
    const twoToken = actionKey(action, subAction);
    if (topicActions[twoToken]) return { key: twoToken, spec: topicActions[twoToken] };
  }
  if (topicActions[action]) return { key: action, spec: topicActions[action] };
  return undefined;
}

/** Locate the cac command that owns a topic (matches on its name token). */
function findTopicCommand(cli: CAC, topic: string): Command | undefined {
  return cli.commands.find((cmd) => cmd.name.split(' ')[0] === topic);
}

/**
 * Render the option lines for an action: each scoped flag's `rawName` and
 * description, pulled live off the topic command so descriptions stay in lock
 * step with the `.option()` declarations. Flags named in the spec but not
 * found on the command are skipped (defensive against a renamed flag).
 */
function renderFlagLines(command: Command, flagNames: string[]): string[] {
  const lines: string[] = [];
  for (const flag of flagNames) {
    const option = command.options.find((opt) => opt.names.includes(flag));
    if (!option) continue;
    lines.push(`  ${option.rawName}  ${option.description}`);
  }
  return lines;
}

/**
 * Render the usage line for an action: the program name, topic, action key,
 * each positional in `<angle-brackets>`, then `[flags]` when the action has
 * any scoped flags.
 */
export function renderUsageLine(
  programName: string,
  topic: string,
  key: string,
  spec: ActionSpec,
): string {
  const parts = [programName, topic, key];
  for (const positional of spec.positionals) parts.push(`<${positional}>`);
  if (spec.flags.length > 0) parts.push('[flags]');
  return `Usage: ${parts.join(' ')}`;
}

/**
 * Render action-scoped `--help`: the usage line, an optional summary, and only
 * this action's flags with their descriptions. Returns undefined when the
 * action is not registered (caller falls back to cac's stock help).
 */
export function renderActionHelp(
  cli: CAC,
  registry: ActionRegistry,
  topic: string,
  action: string,
  subAction?: string,
): string | undefined {
  const resolved = lookupAction(registry, topic, action, subAction);
  if (!resolved) return undefined;
  const command = findTopicCommand(cli, topic);
  if (!command) return undefined;

  const { key, spec } = resolved;
  const lines: string[] = [renderUsageLine(cli.name, topic, key, spec)];
  if (spec.summary) lines.push('', spec.summary);
  const flagLines = renderFlagLines(command, spec.flags);
  if (flagLines.length > 0) {
    lines.push('', 'Options:', ...flagLines);
  }
  return lines.join('\n');
}

/**
 * Print the full usage line for an action plus a specific error message, then
 * return exit code 1. Used by per-action dispatchers when a required
 * positional is missing — the operator sees every positional at once rather
 * than discovering them one failed run at a time.
 *
 * When the action is unregistered, falls back to printing just the message so
 * the caller's existing error text is never lost.
 *
 * Writes through `process.stderr.write` (not `console.error`) so the output is
 * captured uniformly by every CLI handler test harness, matching the rest of
 * the scrum/run-state dispatchers' stderr discipline.
 */
export function actionUsageError(
  cli: CAC,
  registry: ActionRegistry,
  topic: string,
  action: string,
  message: string,
  subAction?: string,
): number {
  const resolved = lookupAction(registry, topic, action, subAction);
  if (resolved) {
    process.stderr.write(`${renderUsageLine(cli.name, topic, resolved.key, resolved.spec)}\n`);
  }
  process.stderr.write(`error: ${message}\n`);
  return 1;
}
