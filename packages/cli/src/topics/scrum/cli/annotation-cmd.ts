/**
 * `claude-prove scrum annotation <action> [flags]`
 *
 * The Annotation memory layer — per-artifact notes captured during work. The
 * lightest layer: a note attaches to one target artifact (a task, a team, or a
 * decision) and is visible to ANYONE reading that target. There is no
 * authorship gate — any author may annotate any target; `--author` is recorded,
 * not enforced. Append-only: a correction is a NEW entry, never an edit, so the
 * full history survives.
 *
 * Action dispatch:
 *   add  --target-kind <task|team|decision> --target <ref> --body <text>
 *        --author <id>
 *                              Append one Annotation to the target. The store
 *                              guards `--target-kind` against the closed enum
 *                              (an unknown kind exits 1, naming the valid set).
 *                              `--target` is a SOFT reference — the target row's
 *                              existence is NOT verified. Prints the JSON row.
 *   list --target-kind <k> --target <ref>
 *                              Print a target's Annotations (oldest-first) as a
 *                              JSON array, or a table with `--human`. A target
 *                              with no notes yields an empty array (not an
 *                              error).
 *
 * Stdout contract: JSON result per action on stdout; one-line human summary on
 * stderr. `list` returns a JSON array (or a table with `--human`).
 *
 * Exit codes:
 *   0  success
 *   1  usage error, unknown action, or an invalid `--target-kind` on any action
 */

import { join } from 'node:path';
import { mainWorktreeRoot } from '@claude-prove/shared';
import type { ScrumStore } from '../store';
import { ANNOTATION_TARGET_KINDS, type AnnotationRow, type AnnotationTargetKind } from '../types';
import { openCliStore } from './cli-store';

export interface AnnotationCmdFlags {
  /** `add`/`list`: the target's artifact class (task | team | decision). */
  targetKind?: string;
  /** `add`/`list`: the target's identifier within that class (a soft reference). */
  target?: string;
  /** `add`: the note's free-text body. */
  body?: string;
  /** `add`: the note's author (recorded, not gated). */
  author?: string;
  human?: boolean;
  workspaceRoot?: string;
}

export type AnnotationAction = 'add' | 'list';

const ANNOTATION_ACTIONS: AnnotationAction[] = ['add', 'list'];

export async function runAnnotationCmd(
  action: string,
  flags: AnnotationCmdFlags,
): Promise<number> {
  if (!isAnnotationAction(action)) {
    process.stderr.write(
      `error: unknown annotation action '${action}'. expected one of: ${ANNOTATION_ACTIONS.join(', ')}\n`,
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
      case 'add':
        return await doAdd(store, flags);
      case 'list':
        return await doList(store, flags);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`scrum annotation ${action}: ${msg}\n`);
    return 1;
  } finally {
    store.close();
  }
}

function isAnnotationAction(value: string): value is AnnotationAction {
  return (ANNOTATION_ACTIONS as string[]).includes(value);
}

/**
 * Narrow a raw `--target-kind` flag to the closed `AnnotationTargetKind` set,
 * or null when unset/invalid. The store re-guards on write; this keeps the
 * `list` read path (which never reaches the store guard) from issuing a query
 * with an off-enum kind.
 */
function asTargetKind(raw: string | undefined): AnnotationTargetKind | null {
  if (raw === undefined || raw.length === 0) return null;
  return (ANNOTATION_TARGET_KINDS as string[]).includes(raw) ? (raw as AnnotationTargetKind) : null;
}

// ---------------------------------------------------------------------------
// add
// ---------------------------------------------------------------------------

async function doAdd(store: ScrumStore, flags: AnnotationCmdFlags): Promise<number> {
  const targetKind = asTargetKind(flags.targetKind);
  if (targetKind === null) {
    process.stderr.write(
      `scrum annotation add: --target-kind <${ANNOTATION_TARGET_KINDS.join('|')}> is required\n`,
    );
    return 1;
  }
  if (flags.target === undefined || flags.target.length === 0) {
    process.stderr.write('scrum annotation add: --target <ref> is required\n');
    return 1;
  }
  if (flags.body === undefined || flags.body.length === 0) {
    process.stderr.write('scrum annotation add: --body <text> is required\n');
    return 1;
  }
  if (flags.author === undefined || flags.author.length === 0) {
    process.stderr.write('scrum annotation add: --author <id> is required\n');
    return 1;
  }

  const row = await store.addAnnotation({
    targetKind,
    targetRef: flags.target,
    body: flags.body,
    author: flags.author,
  });

  process.stdout.write(`${JSON.stringify(row)}\n`);
  process.stderr.write(
    `scrum annotation add: ${row.target_kind} '${row.target_ref}' entry ${row.id} by ${row.author}\n`,
  );
  return 0;
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

async function doList(store: ScrumStore, flags: AnnotationCmdFlags): Promise<number> {
  const targetKind = asTargetKind(flags.targetKind);
  if (targetKind === null) {
    process.stderr.write(
      `scrum annotation list: --target-kind <${ANNOTATION_TARGET_KINDS.join('|')}> is required\n`,
    );
    return 1;
  }
  if (flags.target === undefined || flags.target.length === 0) {
    process.stderr.write('scrum annotation list: --target <ref> is required\n');
    return 1;
  }

  const rows = await store.listAnnotations(targetKind, flags.target);
  if (flags.human === true) {
    process.stdout.write(renderHumanTable(rows));
  } else {
    process.stdout.write(`${JSON.stringify(rows)}\n`);
  }
  process.stderr.write(
    `scrum annotation list: ${targetKind} '${flags.target}' ${rows.length} entries\n`,
  );
  return 0;
}

function renderHumanTable(rows: AnnotationRow[]): string {
  const header = ['ID', 'AUTHOR', 'CREATED_AT', 'BODY'];
  const body = rows.map((r) => [String(r.id), r.author, r.created_at, r.body]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...body.map((cells) => cells[i]?.length ?? 0)),
  );
  const format = (cells: string[]): string =>
    cells.map((c, i) => c.padEnd(widths[i] ?? c.length)).join('  ');
  const lines = [format(header), ...body.map(format)];
  return `${lines.join('\n')}\n`;
}
