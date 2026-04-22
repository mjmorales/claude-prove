/**
 * SessionStart hook — print active run summary at session resume.
 *
 * Walks `$CLAUDE_PROJECT_DIR/.prove/runs/<branch>/<slug>/state.json` for
 * every registered run and emits a compact summary via
 * `hookSpecificOutput.additionalContext`, so Claude inherits awareness of
 * in-flight work at resume|compact time. Silent exit 0 when no active run
 * exists.
 *
 * Port of `tools/run_state/hook_session_start.py`.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pyJsonDump } from './json-compat';
import { EMPTY_HOOK_RESULT, type HookResult, readCwd } from './types';

interface ActiveRunSummary {
  branch: string;
  slug: string;
  run_status: string;
  current_step: string;
}

/** Mirror Python `Path.rglob('state.json')` for depth-2 under runs_root:
 *  `<runs_root>/<branch>/<slug>/state.json`. */
function collectActiveRuns(runsRoot: string): ActiveRunSummary[] {
  if (!existsSync(runsRoot)) return [];
  const out: ActiveRunSummary[] = [];

  let branches: string[];
  try {
    branches = readdirSync(runsRoot);
  } catch {
    return out;
  }

  for (const branch of branches) {
    const branchDir = join(runsRoot, branch);
    if (!isDir(branchDir)) continue;

    let slugs: string[];
    try {
      slugs = readdirSync(branchDir);
    } catch {
      continue;
    }

    for (const slug of slugs) {
      const statePath = join(branchDir, slug, 'state.json');
      const data = readStateJson(statePath);
      if (!data) continue;
      if (data.kind !== 'state') continue;
      if (data.run_status === 'completed') continue;

      out.push({
        branch: typeof data.branch === 'string' && data.branch ? data.branch : branch,
        slug: typeof data.slug === 'string' && data.slug ? data.slug : slug,
        run_status: typeof data.run_status === 'string' ? data.run_status : '?',
        current_step: typeof data.current_step === 'string' ? data.current_step : '',
      });
    }
  }
  return out;
}

function readStateJson(path: string): Record<string, unknown> | null {
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Python:
 *    "- {branch}/{slug}: {run_status}" + (" @ {current_step}" if current_step) */
function formatSummary(runs: ActiveRunSummary[]): string {
  const lines: string[] = ['Active .prove runs:'];
  for (const run of runs) {
    const suffix = run.current_step ? ` @ ${run.current_step}` : '';
    lines.push(`- ${run.branch || '?'}/${run.slug || '?'}: ${run.run_status || '?'}${suffix}`);
  }
  return lines.join('\n');
}

export function runSessionStart(payload: Record<string, unknown> | null): HookResult {
  const effective = payload ?? {};
  const project = readCwd(effective) || process.env.CLAUDE_PROJECT_DIR || process.cwd();

  const runsRoot = join(project, '.prove', 'runs');
  const active = collectActiveRuns(runsRoot);
  if (active.length === 0) return EMPTY_HOOK_RESULT;

  const body = pyJsonDump({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: formatSummary(active),
    },
  });
  return { exitCode: 0, stdout: body, stderr: '' };
}
