/**
 * `run-state ls [--runs-root DIR]` — list every registered run.
 *
 * The Python CLI doesn't ship an `ls` subcommand, but the task brief
 * requires it for parity with `prove-run --list` semantics. Output is
 * one line per run: `<branch>/<slug>\t<run_status>\t<current_step>`.
 * Missing state.json is flagged as `(no state)`.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { defaultRunsRoot } from './resolve';

export interface LsFlags {
  runsRoot?: string;
}

export function runLs(flags: LsFlags): number {
  const runsRoot = flags.runsRoot ?? defaultRunsRoot();
  if (!existsSync(runsRoot)) {
    console.log(`(empty) ${runsRoot}`);
    return 0;
  }
  const rows: Array<{ key: string; status: string; current: string }> = [];
  for (const branch of sortedChildren(runsRoot)) {
    const branchDir = join(runsRoot, branch);
    if (!statSafe(branchDir)?.isDirectory()) continue;
    for (const slug of sortedChildren(branchDir)) {
      const runDir = join(branchDir, slug);
      if (!statSafe(runDir)?.isDirectory()) continue;
      const stateFile = join(runDir, 'state.json');
      if (!existsSync(stateFile)) {
        rows.push({ key: `${branch}/${slug}`, status: '(no state)', current: '' });
        continue;
      }
      try {
        const state = JSON.parse(readFileSync(stateFile, 'utf8')) as {
          run_status?: string;
          current_step?: string;
        };
        rows.push({
          key: `${branch}/${slug}`,
          status: state.run_status ?? 'unknown',
          current: state.current_step ?? '',
        });
      } catch {
        rows.push({ key: `${branch}/${slug}`, status: '(invalid json)', current: '' });
      }
    }
  }
  if (rows.length === 0) {
    console.log(`(empty) ${runsRoot}`);
    return 0;
  }
  for (const r of rows) {
    console.log(`${r.key}\t${r.status}\t${r.current}`);
  }
  return 0;
}

function sortedChildren(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

function statSafe(path: string): ReturnType<typeof statSync> | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}
