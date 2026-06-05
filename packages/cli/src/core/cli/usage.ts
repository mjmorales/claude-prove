/**
 * Topic-facing usage helpers — a thin facade over the action registry so
 * per-action dispatchers raise full-usage errors and intercept action-scoped
 * `--help` without each threading the cac instance through their call chains.
 *
 * `bin/run.ts` calls `bindCli(cli)` once after building the cac instance; the
 * helpers then resolve the bound instance and the static `ACTION_REGISTRY`.
 */

import type { CAC } from 'cac';
import {
  type ActionRegistry,
  actionUsageError as actionUsageErrorImpl,
  lookupAction,
  renderActionHelp as renderActionHelpImpl,
} from './action-registry';
import { ACTION_REGISTRY } from './registry-data';

let boundCli: CAC | undefined;

/** Bind the cac instance the usage helpers render against. Called once at boot. */
export function bindCli(cli: CAC): void {
  boundCli = cli;
}

/**
 * Print the full usage line for `topic action[ subaction]` plus a specific
 * error message, returning exit code 1. When the action is unregistered (or
 * the CLI is not yet bound, as in a direct unit test), prints just the message
 * so existing error text is preserved.
 */
export function usageError(
  topic: string,
  action: string,
  message: string,
  subAction?: string,
): number {
  if (!boundCli) {
    process.stderr.write(`error: ${message}\n`);
    return 1;
  }
  return actionUsageErrorImpl(boundCli, ACTION_REGISTRY, topic, action, message, subAction);
}

/**
 * Render action-scoped `--help` for a `topic action[ subaction]` invocation,
 * or undefined when the action is unregistered (caller falls back to cac's
 * stock help). The pre-parse interceptor in `bin/run.ts` is the sole caller.
 */
export function renderActionHelp(
  topic: string,
  action: string,
  subAction?: string,
): string | undefined {
  if (!boundCli) return undefined;
  return renderActionHelpImpl(boundCli, ACTION_REGISTRY, topic, action, subAction);
}

/** Re-export for the interceptor's coverage check. */
export function isRegisteredAction(topic: string, action: string, subAction?: string): boolean {
  return lookupAction(ACTION_REGISTRY, topic, action, subAction) !== undefined;
}

export type { ActionRegistry };
