/**
 * Register the `report` topic — the report/v1 block-document renderer surface.
 *
 *   claude-prove report render          --file <doc.json>   [--out <path>]
 *   claude-prove report validate        --file <doc.json>
 *   claude-prove report brief           --file <brief.json> [--out <path>]
 *   claude-prove report milestone-brief --file <mb.json>    [--out <path>]
 *   claude-prove report timeline        --file <state.json> [--out <path>]
 *   claude-prove report status          [--workspace-root <p>] [--out <path>]
 *   claude-prove report decompose-preview --file <children.json> [--out <path>]
 *
 * A report document (see `blocks.ts`) is the closed block model every HTML
 * surface compiles to; the vendored static renderer (`render.ts`) maps it to a
 * self-contained HTML page. `render` renders a report/v1 doc directly; `validate`
 * checks one; `brief`/`milestone-brief`/`timeline` mechanically compile a brief /
 * run-state JSON into report/v1; `status` reads the scrum store and renders the
 * tree-aware rollup dashboard. Authors emit blocks, never markup.
 *
 * Stdout: the rendered HTML (when no `--out`) or nothing (validate).
 * Stderr: a one-line human summary, or validation errors one per line.
 * Exit: 0 success, 1 usage / invalid document / IO error.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mainWorktreeRoot } from '@claude-prove/shared';
import type { CAC } from 'cac';
import type { ReviewBrief } from '../acb/brief';
import type { MilestoneBrief } from '../acb/milestone-brief';
import type { StateData } from '../run-state/state';
import { buildSnapshot } from '../scrum/cli/status-cmd';
import { openScrumStore } from '../scrum/store';
import { type ReportDocument, validateReportDocument } from './blocks';
import { milestoneBriefToReportDocument, reviewBriefToReportDocument } from './from-brief';
import { type DecomposeList, decomposeListToReportDocument } from './from-decompose';
import { runStateToReportDocument } from './from-run-state';
import { statusSnapshotToReportDocument } from './from-status';
import { renderReportDocument } from './render';

type ReportAction =
  | 'render'
  | 'validate'
  | 'brief'
  | 'milestone-brief'
  | 'timeline'
  | 'status'
  | 'decompose-preview';

const REPORT_ACTIONS: ReportAction[] = [
  'render',
  'validate',
  'brief',
  'milestone-brief',
  'timeline',
  'status',
  'decompose-preview',
];

interface ReportFlags {
  file?: string;
  out?: string;
  workspaceRoot?: string;
}

export function register(cli: CAC): void {
  cli
    .command('report <action>', `report/v1 HTML renderer (action: ${REPORT_ACTIONS.join(' | ')})`)
    .option('--file <path>', 'Path to the document/brief/state JSON (all actions except status)')
    .option('--out <path>', 'write HTML here instead of stdout')
    .option('--workspace-root <path>', 'status: project root to resolve .prove/prove.db from')
    .action((action: string, flags: ReportFlags) => {
      if (!isReportAction(action)) {
        process.stderr.write(
          `claude-prove report: unknown action '${action}'. expected one of: ${REPORT_ACTIONS.join(', ')}\n`,
        );
        process.exit(1);
      }
      process.exit(action === 'status' ? dispatchStatus(flags) : dispatchFileAction(action, flags));
    });
}

function isReportAction(value: string): value is ReportAction {
  return (REPORT_ACTIONS as string[]).includes(value);
}

/** `status` reads the live scrum store (no `--file`) and renders the dashboard. */
function dispatchStatus(flags: ReportFlags): number {
  const workspaceRoot =
    flags.workspaceRoot && flags.workspaceRoot.length > 0
      ? flags.workspaceRoot
      : (mainWorktreeRoot() ?? process.cwd());
  const store = openScrumStore({ override: join(workspaceRoot, '.prove', 'prove.db') });
  let doc: ReportDocument;
  try {
    doc = statusSnapshotToReportDocument(buildSnapshot(store));
  } finally {
    store.close();
  }
  const errors = validateReportDocument(doc);
  if (errors.length > 0) {
    process.stderr.write('claude-prove report status: compiled an invalid report/v1 document:\n');
    for (const e of errors) process.stderr.write(`  - ${e}\n`);
    return 1;
  }
  return emitHtml(renderReportDocument(doc), 'status', flags);
}

/** All actions except `status` resolve their report/v1 document from a `--file`. */
function dispatchFileAction(action: Exclude<ReportAction, 'status'>, flags: ReportFlags): number {
  if (flags.file === undefined || flags.file.length === 0) {
    process.stderr.write(`claude-prove report ${action}: --file <path> is required\n`);
    return 1;
  }
  const parsed = readJson(flags.file);
  if (parsed.error !== null) {
    process.stderr.write(`claude-prove report ${action}: ${parsed.error}\n`);
    return 1;
  }

  const doc = compileDocument(action, parsed.value);

  const errors = validateReportDocument(doc);
  if (errors.length > 0) {
    const what = action === 'render' || action === 'validate' ? 'document' : 'compiled document';
    process.stderr.write(
      `claude-prove report ${action}: invalid report/v1 ${what} (${errors.length}):\n`,
    );
    for (const e of errors) process.stderr.write(`  - ${e}\n`);
    return 1;
  }

  if (action === 'validate') {
    process.stderr.write(
      `claude-prove report validate: ${flags.file} is a valid report/v1 document\n`,
    );
    return 0;
  }

  return emitHtml(renderReportDocument(doc), action, flags);
}

/** Resolve the report/v1 document for a file action: read directly, or compile. */
function compileDocument(action: Exclude<ReportAction, 'status'>, value: unknown): ReportDocument {
  switch (action) {
    case 'brief':
      return reviewBriefToReportDocument(value as ReviewBrief);
    case 'milestone-brief':
      return milestoneBriefToReportDocument(value as MilestoneBrief);
    case 'timeline':
      return runStateToReportDocument(value as StateData);
    case 'decompose-preview':
      return decomposeListToReportDocument(value as DecomposeList);
    default:
      return value as ReportDocument;
  }
}

/** Write the rendered HTML to `--out` (file) or stdout, with a stderr summary. */
function emitHtml(html: string, action: ReportAction, flags: ReportFlags): number {
  if (flags.out !== undefined && flags.out.length > 0) {
    try {
      writeFileSync(flags.out, html);
    } catch (err) {
      process.stderr.write(
        `claude-prove report ${action}: cannot write ${flags.out}: ${errMsg(err)}\n`,
      );
      return 1;
    }
    const src = flags.file ?? '(store)';
    process.stderr.write(`claude-prove report ${action}: ${src} -> ${flags.out}\n`);
    return 0;
  }
  process.stdout.write(html);
  return 0;
}

function readJson(file: string): { value: unknown; error: null } | { value: null; error: string } {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    return { value: null, error: `cannot read ${file}: ${errMsg(err)}` };
  }
  try {
    return { value: JSON.parse(raw), error: null };
  } catch (err) {
    return { value: null, error: `invalid JSON in ${file}: ${errMsg(err)}` };
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
