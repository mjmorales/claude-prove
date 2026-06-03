/**
 * `claude-prove acb log <append|list|episodes> [--run-dir D] [--file F]`
 *
 * The reasoning-log surface. Writes/reads typed reasoning-log
 * entries laid out as `<run-dir>/log/<agent>/<entry-id>.json`.
 *
 *   acb log append   [--run-dir D] [--file F]   (F or stdin = ONE entry JSON)
 *   acb log list     --run-dir D
 *   acb log episodes --run-dir D
 *
 * `append` deliberately takes a JSON file path / stdin — NOT long prose flags
 * — so multi-line rationale never has to survive Bash quoting. The native
 * Write tool is the canonical writer; this command is the validated ingest +
 * read path.
 *
 * Stdout/stderr contract:
 *   - stdout: machine-readable JSON (default output)
 *   - stderr: one-line human summary
 *
 * Exit codes:
 *   0  success
 *   1  unknown sub-action, missing --run-dir, stdin/file read or JSON parse
 *      error, or schema-invalid entry
 */

import { readFileSync } from 'node:fs';
import { deriveEpisodes } from '../reasoning-log';
import { appendEntry, listEntries } from '../reasoning-log-store';

export type LogSubAction = 'append' | 'list' | 'episodes';

const LOG_SUB_ACTIONS: readonly LogSubAction[] = ['append', 'list', 'episodes'];

export interface LogOpts {
  runDir?: string;
  file?: string;
}

export function runLog(sub: string | undefined, opts: LogOpts): number {
  if (!sub) {
    process.stderr.write(
      `Error: the following arguments are required: log sub-action (one of: ${LOG_SUB_ACTIONS.join(', ')})\n`,
    );
    return 1;
  }
  if (!isLogSubAction(sub)) {
    process.stderr.write(
      `Error: unknown log sub-action '${sub}' (expected: ${LOG_SUB_ACTIONS.join(' | ')})\n`,
    );
    return 1;
  }

  switch (sub) {
    case 'append':
      return runAppend(opts);
    case 'list':
      return runList(opts);
    case 'episodes':
      return runEpisodes(opts);
  }
}

function runAppend(opts: LogOpts): number {
  const runDir = opts.runDir;
  if (!runDir || runDir.length === 0) {
    process.stderr.write('Error: --run-dir is required\n');
    return 1;
  }

  let raw: string;
  try {
    raw = opts.file && opts.file.length > 0 ? readFileSync(opts.file, 'utf8') : readStdinSync();
  } catch (err) {
    process.stderr.write(`Error: cannot read entry: ${errMsg(err)}\n`);
    return 1;
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`Error: invalid JSON entry: ${errMsg(err)}\n`);
    return 1;
  }

  let path: string;
  try {
    path = appendEntry(runDir, data);
  } catch (err) {
    process.stderr.write(`Error: ${errMsg(err)}\n`);
    return 1;
  }

  process.stdout.write(`${JSON.stringify({ appended: true, path })}\n`);
  process.stderr.write(`Log entry appended -> ${path}\n`);
  return 0;
}

function runList(opts: LogOpts): number {
  const runDir = opts.runDir;
  if (!runDir || runDir.length === 0) {
    process.stderr.write('Error: --run-dir is required\n');
    return 1;
  }

  let entries: ReturnType<typeof listEntries>;
  try {
    entries = listEntries(runDir);
  } catch (err) {
    process.stderr.write(`Error: ${errMsg(err)}\n`);
    return 1;
  }

  process.stdout.write(`${JSON.stringify(entries)}\n`);
  process.stderr.write(`${entries.length} log entries\n`);
  return 0;
}

function runEpisodes(opts: LogOpts): number {
  const runDir = opts.runDir;
  if (!runDir || runDir.length === 0) {
    process.stderr.write('Error: --run-dir is required\n');
    return 1;
  }

  let episodes: ReturnType<typeof deriveEpisodes>;
  try {
    episodes = deriveEpisodes(listEntries(runDir));
  } catch (err) {
    process.stderr.write(`Error: ${errMsg(err)}\n`);
    return 1;
  }

  process.stdout.write(`${JSON.stringify(episodes)}\n`);
  process.stderr.write(`${episodes.length} episodes\n`);
  return 0;
}

function isLogSubAction(value: string): value is LogSubAction {
  return (LOG_SUB_ACTIONS as readonly string[]).includes(value);
}

function readStdinSync(): string {
  return readFileSync(0, 'utf8');
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
