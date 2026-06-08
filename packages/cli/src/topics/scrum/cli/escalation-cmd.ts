/**
 * `claude-prove scrum escalation <action> [args] [flags]`
 *
 * The escalation protocol — a typed escalation that walks UP a fixed authority
 * chain one rung at a time, with per-receiver resolution modes. A worker raises
 * a typed escalation (`blocked` | `ambiguous` | `conflict` | `missing_context`)
 * at the bottom rung; the receiver at each layer resolves it, kicks it one rung
 * higher, or marks it for re-decomposition. The chain is fixed and total:
 * `implementer` → `engineer` → `tech_lead` → `pm` → `strategy` → `human`. An
 * escalation advances EXACTLY one rung — never skips — and `human` is terminal.
 *
 * Action dispatch:
 *   raise   --task <id> --type <blocked|ambiguous|conflict|missing_context>
 *           --summary <text> [--layer <rung>] [--by <id>]
 *                              Raise a typed escalation. `--layer` defaults to
 *                              `implementer` (the bottom rung). `--task` is a SOFT
 *                              reference — existence is NOT verified. The store
 *                              guards `--type`/`--layer` against their closed
 *                              enums (an off-vocabulary value exits 1, naming the
 *                              valid set). Prints the JSON row.
 *   show <id>                  Fetch one escalation by id. Prints the JSON row,
 *                              or exits 1 when the id is unknown.
 *   list [--task <id>]         [--human]
 *                              List escalations. With `--task`, a single task's
 *                              full history (every rung, open and closed),
 *                              oldest-first. Without it, every currently-`open`
 *                              escalation across all tasks. Returns a JSON array
 *                              (or a table with `--human`).
 *   resolve <id>               --mode <resolve|re_decompose|re_escalate>
 *                              [--note <text>] [--by <id>]
 *                              Apply a receiver's resolution to an `open`
 *                              escalation. `resolve` → state `resolved`;
 *                              `re_decompose` → `resolved` + a re-decompose signal
 *                              on the result; `re_escalate` → `re_escalated` and a
 *                              fresh `open` row appended one rung up. Exits 1 on an
 *                              unknown id, a non-`open` row, an off-vocabulary
 *                              mode, or a `re_escalate` at the top of the chain.
 *                              Prints `{ row, walkedUpTo, reDecomposeTriggered }`.
 *   chain <id>                 Reconstruct the full walk-up chain a single
 *                              escalation climbed, root rung first. Prints a JSON
 *                              array (or a table with `--human`), or exits 1 when
 *                              the id is unknown.
 *
 * Stdout contract: JSON result per action on stdout; one-line human summary on
 * stderr.
 *
 * Exit codes:
 *   0  success
 *   1  usage error, unknown action, an invalid `--type`/`--layer`/`--mode`, a
 *      `show`/`chain` miss, an unknown id / non-open row / top-of-chain
 *      re_escalate on `resolve`
 */

import { join } from 'node:path';
import { mainWorktreeRoot } from '@claude-prove/shared';
import type { ScrumStore } from '../store';
import {
  ESCALATION_CHAIN,
  ESCALATION_RESOLUTION_MODES,
  ESCALATION_TYPES,
  type EscalationLayer,
  type EscalationResolutionMode,
  type EscalationRow,
  type EscalationType,
} from '../types';
import { openCliStore } from './cli-store';

export interface EscalationCmdFlags {
  /** `raise`: the owning task id (a soft reference — existence not checked). */
  task?: string;
  /** `raise`: the escalation kind (blocked | ambiguous | conflict | missing_context). */
  type?: string;
  /** `raise`: the receiver-facing prose. */
  summary?: string;
  /** `raise`: the rung to raise at; defaults to `implementer`. */
  layer?: string;
  /** `resolve`: the resolution mode (resolve | re_decompose | re_escalate). */
  mode?: string;
  /** `resolve`: the receiver's free-text rationale. */
  note?: string;
  /** `raise`/`resolve`: who raised / resolved (recorded for provenance). */
  by?: string;
  human?: boolean;
  workspaceRoot?: string;
}

export type EscalationAction = 'raise' | 'show' | 'list' | 'resolve' | 'chain';

const ESCALATION_ACTIONS: EscalationAction[] = ['raise', 'show', 'list', 'resolve', 'chain'];

export async function runEscalationCmd(
  action: string,
  args: Array<string | undefined>,
  flags: EscalationCmdFlags,
): Promise<number> {
  if (!isEscalationAction(action)) {
    process.stderr.write(
      `error: unknown escalation action '${action}'. expected one of: ${ESCALATION_ACTIONS.join(', ')}\n`,
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
      case 'raise':
        return await doRaise(store, flags);
      case 'show':
        return await doShow(store, args[0]);
      case 'list':
        return await doList(store, flags);
      case 'resolve':
        return await doResolve(store, args[0], flags);
      case 'chain':
        return await doChain(store, args[0], flags);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`scrum escalation ${action}: ${msg}\n`);
    return 1;
  } finally {
    store.close();
  }
}

function isEscalationAction(value: string): value is EscalationAction {
  return (ESCALATION_ACTIONS as string[]).includes(value);
}

/**
 * Narrow a raw `--type` flag to the closed `EscalationType` set, or null when
 * unset/invalid. The store re-guards on write; this gives the CLI a clean usage
 * error before reaching it.
 */
function asEscalationType(raw: string | undefined): EscalationType | null {
  if (raw === undefined || raw.length === 0) return null;
  return (ESCALATION_TYPES as string[]).includes(raw) ? (raw as EscalationType) : null;
}

/** Narrow a raw `--layer` flag to the closed escalation chain, or null. */
function asEscalationLayer(raw: string | undefined): EscalationLayer | null {
  if (raw === undefined || raw.length === 0) return null;
  return (ESCALATION_CHAIN as string[]).includes(raw) ? (raw as EscalationLayer) : null;
}

/** Narrow a raw `--mode` flag to the closed resolution-mode set, or null. */
function asResolutionMode(raw: string | undefined): EscalationResolutionMode | null {
  if (raw === undefined || raw.length === 0) return null;
  return (ESCALATION_RESOLUTION_MODES as string[]).includes(raw)
    ? (raw as EscalationResolutionMode)
    : null;
}

/** Parse a positional id arg to a positive integer, or null when missing/invalid. */
function asId(raw: string | undefined): number | null {
  if (raw === undefined || raw.length === 0) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// ---------------------------------------------------------------------------
// raise
// ---------------------------------------------------------------------------

async function doRaise(store: ScrumStore, flags: EscalationCmdFlags): Promise<number> {
  if (flags.task === undefined || flags.task.length === 0) {
    process.stderr.write('scrum escalation raise: --task <id> is required\n');
    return 1;
  }
  const escalationType = asEscalationType(flags.type);
  if (escalationType === null) {
    process.stderr.write(
      `scrum escalation raise: --type <${ESCALATION_TYPES.join('|')}> is required\n`,
    );
    return 1;
  }
  if (flags.summary === undefined || flags.summary.length === 0) {
    process.stderr.write('scrum escalation raise: --summary <text> is required\n');
    return 1;
  }
  // `--layer` is optional; an explicit-but-invalid value is a usage error.
  let layer: EscalationLayer | undefined;
  if (flags.layer !== undefined && flags.layer.length > 0) {
    const parsed = asEscalationLayer(flags.layer);
    if (parsed === null) {
      process.stderr.write(
        `scrum escalation raise: invalid --layer '${flags.layer}'; expected one of: ${ESCALATION_CHAIN.join('|')}\n`,
      );
      return 1;
    }
    layer = parsed;
  }

  const row = await store.raiseEscalation({
    taskId: flags.task,
    escalationType,
    summary: flags.summary,
    layer,
    raisedBy: flags.by ?? null,
  });

  process.stdout.write(`${JSON.stringify(row)}\n`);
  process.stderr.write(
    `scrum escalation raise: ${row.escalation_type} on task '${row.task_id}' at '${row.layer}' (id ${row.id})\n`,
  );
  return 0;
}

// ---------------------------------------------------------------------------
// show
// ---------------------------------------------------------------------------

async function doShow(store: ScrumStore, idArg: string | undefined): Promise<number> {
  const id = asId(idArg);
  if (id === null) {
    process.stderr.write('scrum escalation show: a positive integer <id> is required\n');
    return 1;
  }
  const row = await store.getEscalation(id);
  if (row === null) {
    process.stdout.write('null\n');
    process.stderr.write(`scrum escalation show: unknown escalation id '${id}'\n`);
    return 1;
  }
  process.stdout.write(`${JSON.stringify(row)}\n`);
  process.stderr.write(
    `scrum escalation show: ${row.escalation_type} on '${row.task_id}' at '${row.layer}' — ${row.state}\n`,
  );
  return 0;
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

async function doList(store: ScrumStore, flags: EscalationCmdFlags): Promise<number> {
  const scopedToTask = flags.task !== undefined && flags.task.length > 0;
  const rows = scopedToTask
    ? await store.listEscalationsForTask(flags.task as string)
    : await store.listOpenEscalationRows();
  if (flags.human === true) {
    process.stdout.write(renderHumanTable(rows));
  } else {
    process.stdout.write(`${JSON.stringify(rows)}\n`);
  }
  const scope = scopedToTask ? `task '${flags.task}'` : 'all open';
  process.stderr.write(`scrum escalation list: ${scope} ${rows.length} entries\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// resolve
// ---------------------------------------------------------------------------

async function doResolve(
  store: ScrumStore,
  idArg: string | undefined,
  flags: EscalationCmdFlags,
): Promise<number> {
  const id = asId(idArg);
  if (id === null) {
    process.stderr.write('scrum escalation resolve: a positive integer <id> is required\n');
    return 1;
  }
  const mode = asResolutionMode(flags.mode);
  if (mode === null) {
    process.stderr.write(
      `scrum escalation resolve: --mode <${ESCALATION_RESOLUTION_MODES.join('|')}> is required\n`,
    );
    return 1;
  }

  const result = await store.resolveEscalation({
    id,
    mode,
    note: flags.note ?? null,
    resolvedBy: flags.by ?? null,
  });

  process.stdout.write(`${JSON.stringify(result)}\n`);
  const tail = result.walkedUpTo
    ? `walked up to '${result.walkedUpTo.layer}' (id ${result.walkedUpTo.id})`
    : result.reDecomposeTriggered
      ? 're-decompose triggered'
      : 'resolved';
  process.stderr.write(`scrum escalation resolve: ${id} via ${mode} — ${tail}\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// chain
// ---------------------------------------------------------------------------

async function doChain(
  store: ScrumStore,
  idArg: string | undefined,
  flags: EscalationCmdFlags,
): Promise<number> {
  const id = asId(idArg);
  if (id === null) {
    process.stderr.write('scrum escalation chain: a positive integer <id> is required\n');
    return 1;
  }
  if ((await store.getEscalation(id)) === null) {
    process.stdout.write('[]\n');
    process.stderr.write(`scrum escalation chain: unknown escalation id '${id}'\n`);
    return 1;
  }
  const rows = await store.getEscalationChain(id);
  if (flags.human === true) {
    process.stdout.write(renderHumanTable(rows));
  } else {
    process.stdout.write(`${JSON.stringify(rows)}\n`);
  }
  process.stderr.write(`scrum escalation chain: ${id} spans ${rows.length} rung(s)\n`);
  return 0;
}

function renderHumanTable(rows: EscalationRow[]): string {
  const header = ['ID', 'TASK', 'TYPE', 'LAYER', 'STATE', 'MODE', 'CREATED_AT'];
  const body = rows.map((r) => [
    String(r.id),
    r.task_id,
    r.escalation_type,
    r.layer,
    r.state,
    r.resolution_mode ?? '-',
    r.created_at,
  ]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...body.map((cells) => cells[i]?.length ?? 0)),
  );
  const format = (cells: string[]): string =>
    cells.map((c, i) => c.padEnd(widths[i] ?? c.length)).join('  ');
  const lines = [format(header), ...body.map(format)];
  return `${lines.join('\n')}\n`;
}
