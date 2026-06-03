/**
 * Register the `report` topic — the report/v1 block-document renderer surface.
 *
 *   claude-prove report render          --file <doc.json>   [--out <path>]
 *   claude-prove report validate        --file <doc.json>
 *   claude-prove report brief           --file <brief.json> [--out <path>]
 *   claude-prove report milestone-brief --file <mb.json>    [--out <path>]
 *
 * A report document (see `blocks.ts`) is the closed block model every HTML
 * surface compiles to; `render` maps it to a self-contained HTML page via the
 * vendored static renderer (`render.ts`). `validate` checks a document against
 * the closed model without rendering. `brief`/`milestone-brief` mechanically
 * compile a Review/Milestone Brief JSON into report/v1 and render it. Authors
 * emit blocks, never markup.
 *
 * Stdout: the rendered HTML (when no `--out`) or nothing (validate).
 * Stderr: a one-line human summary, or validation errors one per line.
 * Exit: 0 success, 1 usage / invalid document / IO error.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import type { CAC } from 'cac';
import type { ReviewBrief } from '../acb/brief';
import type { MilestoneBrief } from '../acb/milestone-brief';
import { type ReportDocument, validateReportDocument } from './blocks';
import { milestoneBriefToReportDocument, reviewBriefToReportDocument } from './from-brief';
import { renderReportDocument } from './render';

type ReportAction = 'render' | 'validate' | 'brief' | 'milestone-brief';

const REPORT_ACTIONS: ReportAction[] = ['render', 'validate', 'brief', 'milestone-brief'];

interface ReportFlags {
  file?: string;
  out?: string;
}

export function register(cli: CAC): void {
  cli
    .command('report <action>', `report/v1 HTML renderer (action: ${REPORT_ACTIONS.join(' | ')})`)
    .option('--file <path>', 'Path to the document/brief JSON to render or validate')
    .option('--out <path>', 'write HTML here instead of stdout')
    .action((action: string, flags: ReportFlags) => {
      if (!isReportAction(action)) {
        process.stderr.write(
          `claude-prove report: unknown action '${action}'. expected one of: ${REPORT_ACTIONS.join(', ')}\n`,
        );
        process.exit(1);
      }
      process.exit(dispatch(action, flags));
    });
}

function isReportAction(value: string): value is ReportAction {
  return (REPORT_ACTIONS as string[]).includes(value);
}

function dispatch(action: ReportAction, flags: ReportFlags): number {
  if (flags.file === undefined || flags.file.length === 0) {
    process.stderr.write(`claude-prove report ${action}: --file <path> is required\n`);
    return 1;
  }
  const parsed = readJson(flags.file);
  if (parsed.error !== null) {
    process.stderr.write(`claude-prove report ${action}: ${parsed.error}\n`);
    return 1;
  }

  // Resolve the report/v1 document for this action: render/validate read one
  // directly; brief/milestone-brief compile one from a brief JSON.
  const doc: ReportDocument =
    action === 'brief'
      ? reviewBriefToReportDocument(parsed.value as ReviewBrief)
      : action === 'milestone-brief'
        ? milestoneBriefToReportDocument(parsed.value as MilestoneBrief)
        : (parsed.value as ReportDocument);

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
    process.stderr.write(`claude-prove report ${action}: ${flags.file} -> ${flags.out}\n`);
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
