/**
 * `claude-prove scrum ask <action> [flags]`
 *
 * The cross-team ask protocol surface. An ask is the request a worker raises
 * when its work is blocked on a sibling team's published interface: team A needs
 * team B to handle ask type T, and A's artifact ART is blocked until B does.
 *
 * Action dispatch:
 *   file --from-team A --to-team B --ask-type T --blocking-artifact ART
 *                              Record a `'filed'` ask row in `scrum_asks`. The
 *                              store validates that `to_team` resolves, that
 *                              `ask_type` is one of `to_team`'s ACTIVE accepted
 *                              ask types, and that `blocking_artifact` is an
 *                              existing task id; each failure exits 1 with a clear
 *                              stderr message. On success persists
 *                              `{from_team, to_team, ask_type, blocking_artifact,
 *                              state:'filed'}`, prints the JSON row on stdout, and
 *                              prints the new ask id on its own final stdout line.
 *   respond <ask-id> --verdict accept|reject|counter [--comment TEXT] [--by ID]
 *                              MECHANICALLY apply a triage verdict the driver
 *                              already produced — this path spawns NO model and
 *                              invokes no Agent. `accept` creates exactly one
 *                              child task under the to-team's tree, sets the ask's
 *                              `mapped_artifact`, and adds a `blocked_by` dep from
 *                              the from-team's blocking artifact onto the child.
 *                              `reject` records `--comment` as `rejected_reason`;
 *                              `counter` records it as `counter_proposal`; neither
 *                              mutates the tree or deps. Fires an `ask_responded`
 *                              event. Exits 1 on an unknown id, a missing/invalid
 *                              `--verdict`, or an already-responded (non-`filed`)
 *                              ask. Prints the updated JSON row.
 *   await <ask-id>             MECHANICAL poll of a filed ask — the read primitive
 *                              the `kind:<team-slug>` workflow sugar composes. It
 *                              spawns NO model and never mutates: it derives the
 *                              ask's phase from its state plus, on accept, the
 *                              mapped child's status, and on `ready` carries the
 *                              to-team's exposed outputs. Phases: `pending` (still
 *                              filed), `waiting` (accepted, child not `done`),
 *                              `ready` (accepted, child `done`; outputs present),
 *                              `rejected` / `countered` (terminal, `reason` set).
 *                              `terminal` is true on ready/rejected/countered so a
 *                              polling loop knows to stop. Prints the JSON report;
 *                              exit 0 on every existing ask (the report — not the
 *                              exit code — carries the phase), exit 1 only on an
 *                              unknown id.
 *
 * Stdout contract: the JSON ask row (`file`/`respond`) or the JSON await report
 * (`await`). On `file`, a final line carries the new ask id (so a caller can
 * capture it without parsing JSON). A one-line human summary goes to stderr.
 *
 * Exit codes:
 *   0  success
 *   1  usage error (a missing required flag), unknown action, an unknown
 *      from_team / to_team, an ask_type the to_team does not accept, a missing
 *      blocking_artifact, an unknown ask id, an invalid verdict, or a non-`filed`
 *      ask on respond
 */

import { join } from 'node:path';
import { mainWorktreeRoot } from '@claude-prove/shared';
import type { ScrumStore } from '../store';
import { ASK_VERDICTS, type AskVerdict } from '../types';
import { openCliStore } from './cli-store';

export interface AskCmdFlags {
  fromTeam?: string;
  toTeam?: string;
  askType?: string;
  blockingArtifact?: string;
  /** `respond`: the triage verdict (accept | reject | counter). */
  verdict?: string;
  /** `respond`: verdict-specific rationale (rejected_reason / counter_proposal). */
  comment?: string;
  /** `respond`: who produced the verdict (recorded for provenance). */
  by?: string;
  human?: boolean;
  workspaceRoot?: string;
}

export type AskAction = 'file' | 'respond' | 'await';

const ASK_ACTIONS: AskAction[] = ['file', 'respond', 'await'];

export async function runAskCmd(
  action: string,
  args: Array<string | undefined>,
  flags: AskCmdFlags,
): Promise<number> {
  if (!isAskAction(action)) {
    process.stderr.write(
      `error: unknown ask action '${action}'. expected one of: ${ASK_ACTIONS.join(', ')}\n`,
    );
    return 1;
  }

  const workspaceRoot =
    flags.workspaceRoot && flags.workspaceRoot.length > 0
      ? flags.workspaceRoot
      : (mainWorktreeRoot() ?? process.cwd());
  const store = await openCliStore(workspaceRoot);
  try {
    switch (action) {
      case 'file':
        return await doFile(store, flags);
      case 'respond':
        return await doRespond(store, args[0], flags);
      case 'await':
        return await doAwait(store, args[0]);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`scrum ask ${action}: ${msg}\n`);
    return 1;
  } finally {
    store.close();
  }
}

function isAskAction(value: string): value is AskAction {
  return (ASK_ACTIONS as string[]).includes(value);
}

/**
 * Narrow a raw `--verdict` flag to the closed `AskVerdict` set, or null when
 * unset/invalid. The store re-guards on write; this gives the CLI a clean usage
 * error before reaching it.
 */
function asAskVerdict(raw: string | undefined): AskVerdict | null {
  if (raw === undefined || raw.length === 0) return null;
  return (ASK_VERDICTS as string[]).includes(raw) ? (raw as AskVerdict) : null;
}

/** Take a positional ask-id arg as a non-empty string id (a ULID), or null when missing. */
function asAskId(raw: string | undefined): string | null {
  if (raw === undefined || raw.length === 0) return null;
  return raw;
}

// ---------------------------------------------------------------------------
// file
// ---------------------------------------------------------------------------

async function doFile(store: ScrumStore, flags: AskCmdFlags): Promise<number> {
  if (flags.fromTeam === undefined || flags.fromTeam.length === 0) {
    process.stderr.write('scrum ask file: --from-team <slug> is required\n');
    return 1;
  }
  if (flags.toTeam === undefined || flags.toTeam.length === 0) {
    process.stderr.write('scrum ask file: --to-team <slug> is required\n');
    return 1;
  }
  if (flags.askType === undefined || flags.askType.length === 0) {
    process.stderr.write('scrum ask file: --ask-type <type> is required\n');
    return 1;
  }
  if (flags.blockingArtifact === undefined || flags.blockingArtifact.length === 0) {
    process.stderr.write('scrum ask file: --blocking-artifact <task-id> is required\n');
    return 1;
  }

  // fileAsk throws on an unknown to_team / from_team, a non-accepted ask_type,
  // and a missing blocking_artifact; each surfaces as exit 1 via the runAskCmd
  // catch with the store's domain message.
  const ask = await store.fileAsk({
    fromTeam: flags.fromTeam,
    toTeam: flags.toTeam,
    askType: flags.askType,
    blockingArtifact: flags.blockingArtifact,
  });

  process.stdout.write(`${JSON.stringify(ask)}\n`);
  process.stdout.write(`${ask.id}\n`);
  process.stderr.write(
    `scrum ask file: ${ask.from_team} -> ${ask.to_team} '${ask.ask_type}' blocking ${ask.blocking_artifact} (id ${ask.id})\n`,
  );
  return 0;
}

// ---------------------------------------------------------------------------
// respond
// ---------------------------------------------------------------------------

async function doRespond(
  store: ScrumStore,
  idArg: string | undefined,
  flags: AskCmdFlags,
): Promise<number> {
  const id = asAskId(idArg);
  if (id === null) {
    process.stderr.write('scrum ask respond: an <ask-id> is required\n');
    return 1;
  }
  const verdict = asAskVerdict(flags.verdict);
  if (verdict === null) {
    process.stderr.write(`scrum ask respond: --verdict <${ASK_VERDICTS.join('|')}> is required\n`);
    return 1;
  }

  // respondAsk throws on an unknown id, an off-vocabulary verdict, and a
  // non-`filed` ask; each surfaces as exit 1 via the runAskCmd catch with the
  // store's domain message. The CLI performs no judgment — it forwards the
  // driver's verdict for mechanical application.
  const ask = await store.respondAsk({
    id,
    verdict,
    comment: flags.comment ?? null,
    respondedBy: flags.by ?? null,
  });

  process.stdout.write(`${JSON.stringify(ask)}\n`);
  const tail =
    ask.state === 'accepted'
      ? `mapped ${ask.mapped_artifact} (blocks ${ask.blocking_artifact})`
      : ask.state === 'rejected'
        ? 'rejected'
        : 'countered';
  process.stderr.write(`scrum ask respond: ${id} ${verdict} -> ${ask.state} ${tail}\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// await — mechanical poll for the team-as-workflow-kind sugar
// ---------------------------------------------------------------------------

async function doAwait(store: ScrumStore, idArg: string | undefined): Promise<number> {
  const id = asAskId(idArg);
  if (id === null) {
    process.stderr.write('scrum ask await: an <ask-id> is required\n');
    return 1;
  }

  // awaitAsk throws only on an unknown id; every existing ask yields a report,
  // so a terminal reject/counter SURFACES as a phase in the JSON (the calling
  // script never hangs) rather than as a non-zero exit.
  const report = await store.awaitAsk(id);

  process.stdout.write(`${JSON.stringify(report)}\n`);
  const detail =
    report.phase === 'ready'
      ? `${report.outputs.length} output(s) from '${report.to_team}'`
      : report.phase === 'rejected' || report.phase === 'countered'
        ? (report.reason ?? '(no reason)')
        : report.phase === 'waiting'
          ? `child ${report.mapped_artifact} is ${report.artifact_status}`
          : 'awaiting response';
  process.stderr.write(
    `scrum ask await: ${id} ${report.phase}${report.terminal ? ' (terminal)' : ''} -> ${detail}\n`,
  );
  return 0;
}
