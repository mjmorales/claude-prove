/**
 * Filesystem IO for the reasoning log.
 *
 * The canonical writer is the native Write tool emitting one JSON file per
 * entry into `<run-dir>/log/<agent>/<entry-id>.json` — see `reasoning-log.ts`
 * for the rationale (avoids Bash-quoting multi-line prose). This module reads
 * that layout back: `appendEntry` persists a validated entry, `listEntries`
 * merges every per-entry file under a run's `log/` dir sorted by `ts`.
 *
 * Strict on read: a malformed or schema-invalid entry file aborts the merge
 * with a path-qualified error rather than silently dropping reasoning.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type LogEntry, parseLogEntry } from './reasoning-log';

/** The per-run log subdirectory under a run directory. */
export const LOG_DIRNAME = 'log';

/** Absolute path to a run's reasoning-log root: `<runDir>/log`. */
export function logRoot(runDir: string): string {
  return join(runDir, LOG_DIRNAME);
}

/** Absolute path to an entry file: `<runDir>/log/<agent>/<id>.json`. */
export function entryPath(runDir: string, agent: string, id: string): string {
  return join(logRoot(runDir), agent, `${id}.json`);
}

/**
 * Validate `entry`, then write it to its canonical path under `runDir`,
 * creating the `<agent>/` dir as needed. `runDir` overrides `entry.run_path`
 * for placement so a caller can relocate a run dir without rewriting bodies.
 * Returns the absolute file path written. Throws on a schema-invalid entry.
 */
export function appendEntry(runDir: string, entry: unknown): string {
  const valid: LogEntry = parseLogEntry(entry);
  const dir = join(logRoot(runDir), valid.agent);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${valid.id}.json`);
  writeFileSync(path, `${JSON.stringify(valid, null, 2)}\n`, 'utf8');
  return path;
}

/**
 * Merge every per-entry JSON file under `<runDir>/log/` and return them sorted
 * by `ts` ascending (id as a stable tiebreak). Missing log dir => empty list.
 * A malformed entry file throws with its path for triage.
 */
export function listEntries(runDir: string): LogEntry[] {
  const root = logRoot(runDir);
  if (!existsSync(root)) return [];

  const entries: LogEntry[] = [];
  for (const file of entryFiles(root)) {
    const raw = readFileSync(file, 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`invalid JSON in log entry ${file}: ${msg}`);
    }
    try {
      entries.push(parseLogEntry(parsed));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`${msg} (in ${file})`);
    }
  }

  entries.sort((a, b) => (a.ts === b.ts ? cmp(a.id, b.id) : cmp(a.ts, b.ts)));
  return entries;
}

/** All `*.json` files under the per-agent subdirectories of `root`, sorted. */
function entryFiles(root: string): string[] {
  const files: string[] = [];
  for (const agentDir of readdirSync(root).sort()) {
    const dir = join(root, agentDir);
    if (!statSync(dir).isDirectory()) continue;
    for (const name of readdirSync(dir).sort()) {
      if (name.endsWith('.json')) files.push(join(dir, name));
    }
  }
  return files;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
