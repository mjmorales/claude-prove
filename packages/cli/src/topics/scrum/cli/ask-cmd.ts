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
 *
 * Stdout contract: the JSON ask row, then a final line carrying the new ask id
 * (so a caller can capture the id without parsing JSON). A one-line human summary
 * goes to stderr.
 *
 * Exit codes:
 *   0  success
 *   1  usage error (a missing required flag), unknown action, an unknown
 *      from_team / to_team, an ask_type the to_team does not accept, or a missing
 *      blocking_artifact
 */

import { join } from 'node:path';
import { mainWorktreeRoot } from '@claude-prove/shared';
import { type ScrumStore, openScrumStore } from '../store';

export interface AskCmdFlags {
  fromTeam?: string;
  toTeam?: string;
  askType?: string;
  blockingArtifact?: string;
  human?: boolean;
  workspaceRoot?: string;
}

export type AskAction = 'file';

const ASK_ACTIONS: AskAction[] = ['file'];

export function runAskCmd(action: string, flags: AskCmdFlags): number {
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
  const store = openScrumStore({ override: join(workspaceRoot, '.prove', 'prove.db') });
  try {
    switch (action) {
      case 'file':
        return doFile(store, flags);
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

// ---------------------------------------------------------------------------
// file
// ---------------------------------------------------------------------------

function doFile(store: ScrumStore, flags: AskCmdFlags): number {
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
  const ask = store.fileAsk({
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
