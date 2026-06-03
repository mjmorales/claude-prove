/**
 * Register the `report` topic — the report/v1 block-document renderer surface.
 *
 *   claude-prove report render   --file <doc.json> [--out <path>]
 *   claude-prove report validate --file <doc.json>
 *
 * A report document (see `blocks.ts`) is the closed block model every HTML
 * surface compiles to; `render` maps it to a self-contained HTML page via the
 * vendored static renderer (`render.ts`). `validate` checks a document against
 * the closed model without rendering. Authors emit blocks, never markup.
 *
 * Stdout: the rendered HTML (render, when no `--out`) or nothing (validate).
 * Stderr: a one-line human summary, or validation errors one per line.
 * Exit: 0 success, 1 usage / invalid document / IO error.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import type { CAC } from 'cac';
import { type ReportDocument, validateReportDocument } from './blocks';
import { renderReportDocument } from './render';

type ReportAction = 'render' | 'validate';

const REPORT_ACTIONS: ReportAction[] = ['render', 'validate'];

interface ReportFlags {
  file?: string;
  out?: string;
}

export function register(cli: CAC): void {
  cli
    .command('report <action>', `report/v1 HTML renderer (action: ${REPORT_ACTIONS.join(' | ')})`)
    .option('--file <path>', 'Path to the report/v1 document JSON to render or validate')
    .option('--out <path>', 'render: write HTML here instead of stdout')
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
  const parsed = readDocument(flags.file);
  if (parsed.error !== null) {
    process.stderr.write(`claude-prove report ${action}: ${parsed.error}\n`);
    return 1;
  }
  const errors = validateReportDocument(parsed.value);
  if (errors.length > 0) {
    process.stderr.write(
      `claude-prove report ${action}: invalid report/v1 document (${errors.length}):\n`,
    );
    for (const e of errors) process.stderr.write(`  - ${e}\n`);
    return 1;
  }
  const doc = parsed.value as ReportDocument;

  if (action === 'validate') {
    process.stderr.write(
      `claude-prove report validate: ${flags.file} is a valid report/v1 document\n`,
    );
    return 0;
  }

  const html = renderReportDocument(doc);
  if (flags.out !== undefined && flags.out.length > 0) {
    try {
      writeFileSync(flags.out, html);
    } catch (err) {
      process.stderr.write(
        `claude-prove report render: cannot write ${flags.out}: ${errMsg(err)}\n`,
      );
      return 1;
    }
    process.stderr.write(`claude-prove report render: ${flags.file} -> ${flags.out}\n`);
    return 0;
  }
  process.stdout.write(html);
  return 0;
}

function readDocument(
  file: string,
): { value: unknown; error: null } | { value: null; error: string } {
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
