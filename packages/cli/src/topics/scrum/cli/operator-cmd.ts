/**
 * `claude-prove scrum operator <action> [args] [flags]`
 *
 * The operator-of-record role — the single role slot that exists (a degenerate
 * one-row roster). Its holder is a time-series of intervals recorded in
 * `scrum_operator_history`, so attribution can be POINT-IN-TIME, not just
 * current-holder.
 *
 * Action dispatch:
 *   set --contributor CT-UUID [--from-ts ISO]
 *                              Set / transfer the operator-of-record. Closes the
 *                              prior open interval and appends a new open one,
 *                              and syncs `charter.md`'s `operator_of_record`
 *                              frontmatter field to the new holder. Prints the
 *                              new open interval row.
 *   resolve --at ISO           Resolve the contributor who held the role AT the
 *                              given instant (the interval `[from_ts, to_ts)`
 *                              containing it) — NOT the current holder. Prints
 *                              the matched contributor JSON row, or exits 1 on a
 *                              miss (no holder in effect at that instant).
 *   history                    [--human]
 *                              Print the full position history, oldest first.
 *
 * Stdout contract: JSON result per action on stdout; one-line human summary on
 * stderr. `history` returns a JSON array (or a table with `--human`).
 *
 * Exit codes:
 *   0  success
 *   1  usage error, unknown action, unknown contributor, or a resolve miss
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mainWorktreeRoot } from '@claude-prove/shared';
import { type ScrumStore, openScrumStore } from '../store';
import type { OperatorHistoryRow } from '../types';

export interface OperatorCmdFlags {
  contributor?: string;
  fromTs?: string;
  at?: string;
  human?: boolean;
  workspaceRoot?: string;
}

export type OperatorAction = 'set' | 'resolve' | 'history';

const OPERATOR_ACTIONS: OperatorAction[] = ['set', 'resolve', 'history'];

export function runOperatorCmd(action: string, flags: OperatorCmdFlags): number {
  if (!isOperatorAction(action)) {
    process.stderr.write(
      `error: unknown operator action '${action}'. expected one of: ${OPERATOR_ACTIONS.join(', ')}\n`,
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
      case 'set':
        return doSet(store, workspaceRoot, flags);
      case 'resolve':
        return doResolve(store, flags);
      case 'history':
        return doHistory(store, flags);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`scrum operator ${action}: ${msg}\n`);
    return 1;
  } finally {
    store.close();
  }
}

function isOperatorAction(value: string): value is OperatorAction {
  return (OPERATOR_ACTIONS as string[]).includes(value);
}

// ---------------------------------------------------------------------------
// set — transfer the role + sync the charter frontmatter
// ---------------------------------------------------------------------------

function doSet(store: ScrumStore, workspaceRoot: string, flags: OperatorCmdFlags): number {
  if (flags.contributor === undefined || flags.contributor.length === 0) {
    process.stderr.write('scrum operator set: --contributor <CT-UUID> is required\n');
    return 1;
  }

  const row = store.setOperatorOfRecord({
    contributorId: flags.contributor,
    fromTs: emptyToUndef(flags.fromTs),
  });

  // Emit the row before attempting the charter sync so callers always receive
  // the result JSON regardless of whether the filesystem write succeeds.
  process.stdout.write(`${JSON.stringify(row)}\n`);
  let where = '';
  try {
    const synced = syncCharterOperator(workspaceRoot, row.contributor_id);
    where = synced ? ' -> charter.md' : '';
  } catch (syncErr) {
    const msg = syncErr instanceof Error ? syncErr.message : String(syncErr);
    process.stderr.write(`scrum operator set: store updated but charter sync failed: ${msg}\n`);
  }
  process.stderr.write(
    `scrum operator set: ${row.contributor_id} held from ${row.from_ts}${where}\n`,
  );
  return 0;
}

/**
 * Rewrite `charter.md`'s `operator_of_record` frontmatter field to the new
 * holder, so the file mirrors the open interval. Returns true when the charter
 * existed and was updated; false when there is no charter to sync (the table is
 * still the source of truth). Only the field line is touched — the rest of the
 * file is byte-preserved.
 */
function syncCharterOperator(workspaceRoot: string, contributorId: string): boolean {
  const path = join(workspaceRoot, 'charter.md');
  if (!existsSync(path)) return false;
  const text = readFileSync(path, 'utf8');
  const next = text.replace(/^operator_of_record:.*$/m, `operator_of_record: ${contributorId}`);
  if (next === text) return false;
  writeFileSync(path, next, 'utf8');
  return true;
}

// ---------------------------------------------------------------------------
// resolve — point-in-time holder, NOT the current holder
// ---------------------------------------------------------------------------

function doResolve(store: ScrumStore, flags: OperatorCmdFlags): number {
  if (flags.at === undefined || flags.at.length === 0) {
    process.stderr.write('scrum operator resolve: --at <ISO-8601 instant> is required\n');
    return 1;
  }

  const row = store.operatorOfRecordAt(flags.at);
  if (row === null) {
    process.stdout.write('null\n');
    process.stderr.write(`scrum operator resolve: no holder in effect at ${flags.at}\n`);
    return 1;
  }

  process.stdout.write(`${JSON.stringify(row)}\n`);
  process.stderr.write(`scrum operator resolve: ${row.id} (${row.slug}) at ${flags.at}\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// history
// ---------------------------------------------------------------------------

function doHistory(store: ScrumStore, flags: OperatorCmdFlags): number {
  const rows = store.operatorHistory();
  if (flags.human === true) {
    process.stdout.write(renderHumanTable(rows));
  } else {
    process.stdout.write(`${JSON.stringify(rows)}\n`);
  }
  process.stderr.write(`scrum operator history: ${rows.length} intervals\n`);
  return 0;
}

function renderHumanTable(rows: OperatorHistoryRow[]): string {
  const header = ['CONTRIBUTOR', 'FROM', 'TO'];
  const body = rows.map((r) => [r.contributor_id, r.from_ts, r.to_ts ?? '(current)']);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...body.map((cells) => cells[i]?.length ?? 0)),
  );
  const format = (cells: string[]): string =>
    cells.map((c, i) => c.padEnd(widths[i] ?? c.length)).join('  ');
  const lines = [format(header), ...body.map(format)];
  return `${lines.join('\n')}\n`;
}

/** Coerce an empty-string flag to undefined so blank flags read as "unset". */
function emptyToUndef(raw: string | undefined): string | undefined {
  return raw !== undefined && raw.length > 0 ? raw : undefined;
}
