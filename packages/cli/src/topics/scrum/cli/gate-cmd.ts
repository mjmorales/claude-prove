/**
 * `claude-prove scrum gate <action> [args] [flags]`
 *
 * Resolve the persisted verdict of a `gate`-kind acceptance criterion. A gate
 * criterion is verified by a HUMAN approve/reject decision recorded as standing
 * state on the criterion (`gate.verdict`: gate_pending → approved | rejected) —
 * never a process that blocks waiting for the decision.
 *
 * Action dispatch:
 *   respond <criterion-id> <approve|reject> --task <task-id> [--comment <text>]
 *                                                            [--by <responder>]
 *
 * Resolution is PULL-based. Three paths surface a pending gate to a human and
 * record the verdict; none of them is a daemon or a loop that blocks the engine:
 *   1. an interactive `AskUserQuestion` turn (the driver asks in-turn), then this
 *      CLI records the chosen verdict;
 *   2. this `scrum gate respond` CLI invoked directly out-of-turn;
 *   3. a session-start surfacing of `gate_pending` criteria, decided next turn.
 * "Deferred" means recorded-state-that-persists, not a waiting process.
 *
 * The human responder is recorded as the verification contributor: `--by` wins,
 * else the `PROVE_AGENT` env, else null. The store stamps it on the criterion's
 * `gate.responder` and on a `gate_responded` event in the append-only log.
 *
 * Stdout: JSON `{ responded: true, task_id, criterion_id, verdict, responder }`.
 * Stderr: one-line human summary.
 *
 * Exit codes:
 *   0  success
 *   1  usage error, unknown action/verdict, or domain invariant violation
 *      (unknown id, non-gate criterion, already-resolved gate)
 */

import { join } from 'node:path';
import { mainWorktreeRoot } from '@claude-prove/shared';
import { openScrumStore } from '../store';

export interface GateCmdFlags {
  task?: string;
  comment?: string;
  by?: string;
  workspaceRoot?: string;
}

type GateAction = 'respond';

const GATE_ACTIONS: GateAction[] = ['respond'];

/** Closed respond-verdict set the CLI accepts; `gate_pending` is not a target. */
const RESPOND_VERDICTS = ['approve', 'reject'] as const;

export function runGateCmd(
  action: string,
  positional: (string | undefined)[],
  flags: GateCmdFlags,
): number {
  if (!isGateAction(action)) {
    process.stderr.write(
      `error: unknown gate action '${action}'. expected one of: ${GATE_ACTIONS.join(', ')}\n`,
    );
    return 1;
  }

  const workspaceRoot =
    flags.workspaceRoot && flags.workspaceRoot.length > 0
      ? flags.workspaceRoot
      : (mainWorktreeRoot() ?? process.cwd());
  const store = openScrumStore({ override: join(workspaceRoot, '.prove', 'prove.db') });
  try {
    switch (action) {
      case 'respond':
        return doRespond(store, positional[0], positional[1], flags);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`scrum gate ${action}: ${msg}\n`);
    return 1;
  } finally {
    store.close();
  }
}

function isGateAction(value: string): value is GateAction {
  return (GATE_ACTIONS as string[]).includes(value);
}

/**
 * Record a human approve/reject on a gate criterion. `--task <task-id>` locates
 * the criterion (criterion ids are unique only within a task). The responder —
 * `--by`, else `PROVE_AGENT`, else null — is recorded as the verification
 * contributor. Store-side rejections (unknown id, non-gate, already-resolved)
 * surface here as exit 1.
 */
function doRespond(
  store: ReturnType<typeof openScrumStore>,
  criterionId: string | undefined,
  verdictArg: string | undefined,
  flags: GateCmdFlags,
): number {
  if (criterionId === undefined || criterionId.length === 0) {
    process.stderr.write('scrum gate respond: <criterion-id> positional argument required\n');
    return 1;
  }
  if (verdictArg === undefined || !(RESPOND_VERDICTS as readonly string[]).includes(verdictArg)) {
    process.stderr.write(
      `scrum gate respond: <verdict> must be one of: ${RESPOND_VERDICTS.join(', ')}\n`,
    );
    return 1;
  }
  if (flags.task === undefined || flags.task.length === 0) {
    process.stderr.write('scrum gate respond: --task <task-id> is required\n');
    return 1;
  }

  const verdict = verdictArg === 'approve' ? 'approved' : 'rejected';
  const responder = flags.by && flags.by.length > 0 ? flags.by : (process.env.PROVE_AGENT ?? '');
  const comment = flags.comment && flags.comment.length > 0 ? flags.comment : null;

  const task = store.respondGate(flags.task, criterionId, verdict, { responder, comment });
  const resolved = task.acceptance?.criteria.find((c) => c.id === criterionId);
  const payload = {
    responded: true,
    task_id: flags.task,
    criterion_id: criterionId,
    verdict,
    responder: resolved?.gate?.responder ?? null,
    comment: resolved?.gate?.comment ?? null,
  };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  process.stderr.write(
    `scrum gate respond: ${flags.task} / ${criterionId} -> ${verdict}${responder.length > 0 ? ` (by ${responder})` : ''}\n`,
  );
  return 0;
}
