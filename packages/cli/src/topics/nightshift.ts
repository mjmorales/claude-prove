/**
 * Register the `nightshift` topic on the cac instance.
 *
 * Mechanical state for the operator-enabled overnight scrum-drain driver
 * (rationale ADR: 2026-08-09-nightshift-driver, operator scrum store). The
 * engine owns the night's config, heartbeat lease, floor counters, and
 * append-only ledger; the nightshift skills own every judgment call.
 *
 * Subcommand surface:
 *
 *   claude-prove nightshift enable  --milestone <m> [--deadline HH:MM]
 *                                   [--task-cap N] [--max-heals N] [--max-parked N]
 *   claude-prove nightshift disable [--reason R]
 *   claude-prove nightshift status
 *   claude-prove nightshift lease   <acquire|heartbeat|release> --holder H
 *                                   [--ttl-seconds N] [--force]
 *   claude-prove nightshift record  <event> [--task T] [--pr N] [--detail D]
 *   claude-prove nightshift ledger
 *
 * Output contract (LLM-optimized): every action prints one JSON verdict on
 * stdout; human summaries go to stderr.
 *
 * Exit codes:
 *   0  success (lease acquire: caller holds the lease)
 *   1  usage error, no open night, lease contention, or holder mismatch
 */

import type { CAC } from 'cac';
import { NIGHTSHIFT_ACTIONS, type NightshiftAction, runNightshift } from './nightshift/manage';

interface NightshiftFlags {
  projectRoot?: string;
  milestone?: string;
  deadline?: string;
  taskCap?: string;
  maxHeals?: string;
  maxParked?: string;
  reason?: string;
  holder?: string;
  ttlSeconds?: string;
  force?: boolean;
  task?: string;
  pr?: string;
  detail?: string;
}

export function register(cli: CAC): void {
  cli
    .command(
      'nightshift <action> [subaction]',
      'Overnight driver state (action: enable | disable | status | lease | record | ledger)',
    )
    .option('--project-root <r>', 'Project root containing .prove/ (default: cwd)')
    .option('--milestone <m>', 'Milestone the night drains (enable)')
    .option('--deadline <hh:mm>', 'Local-time hard deadline (enable, default 07:00)')
    .option('--task-cap <n>', 'Max tasks started per night (enable, default 10)')
    .option('--max-heals <n>', 'Max heal attempts per PR (enable, default 2)')
    .option('--max-parked <n>', 'Parked tasks that halt the night (enable, default 3)')
    .option('--reason <r>', 'Reason note (disable)')
    .option('--holder <h>', 'Lease holder identity (lease)')
    .option('--ttl-seconds <n>', 'Lease staleness threshold (lease acquire, default 900)')
    .option('--force', 'Release a lease held by another holder (lease release)')
    .option('--task <t>', 'Scrum task id for the ledger row (record)')
    .option('--pr <n>', 'PR number for the ledger row (record; required for heal-attempt)')
    .option('--detail <d>', 'Free-text detail for the ledger row (record)')
    .action((action: string, subaction: string | undefined, flags: NightshiftFlags) => {
      if (!isNightshiftAction(action)) {
        console.error(
          `error: unknown nightshift action '${action}'. expected one of: ${NIGHTSHIFT_ACTIONS.join(', ')}`,
        );
        process.exit(1);
      }
      process.exit(
        runNightshift({
          action,
          subaction,
          projectRoot: flags.projectRoot,
          milestone: flags.milestone,
          deadline: flags.deadline,
          taskCap: parseCount(flags.taskCap),
          maxHeals: parseCount(flags.maxHeals),
          maxParked: parseCount(flags.maxParked),
          reason: flags.reason,
          holder: asString(flags.holder),
          ttlSeconds: parseCount(flags.ttlSeconds),
          force: flags.force,
          task: asString(flags.task),
          pr: asString(flags.pr),
          detail: flags.detail,
        }),
      );
    });
}

function isNightshiftAction(value: string): value is NightshiftAction {
  return (NIGHTSHIFT_ACTIONS as readonly string[]).includes(value);
}

function parseCount(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

// cac parses numeric-looking values (`--pr 42`) as JS numbers; the ledger and
// heal-cap map key by string, so normalize at the flag boundary.
function asString(value: string | undefined): string | undefined {
  return value === undefined ? undefined : String(value);
}
