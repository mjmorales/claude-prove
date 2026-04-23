/**
 * Reporter event dispatcher — replaces the in-line Python `json.load` /
 * shell-fire loop that lived in `scripts/dispatch-event.sh`.
 *
 * Contract:
 *   1. Require `PROVE_RUN_BRANCH` + `PROVE_RUN_SLUG` in env (or via flags);
 *      without them the run-state dedup ledger has no anchor.
 *   2. Require `<project-root>/.prove/runs/<branch>/<slug>/state.json`; bail
 *      silent exit 0 if absent (matches the shell script's best-effort
 *      contract — dispatch must never halt the orchestrator).
 *   3. Require `<project-root>/.claude/.prove.json`; silent exit 0 if absent.
 *   4. Dedup key: `<event>:<step-or-slug>`. Short-circuit exit 0 if already
 *      recorded in `state.dispatch.dispatched[]`.
 *   5. For each reporter whose `events` list contains the event, execute
 *      `bash -c <command>` from `project-root` with the PROVE_* env surface
 *      populated. Stderr from each reporter is prefixed `  [<name>] `.
 *   6. Record the dedup key on success (best-effort, never raises).
 *
 * All failures downstream of argument parsing are swallowed and surfaced as
 * stderr lines — reporter firing is intentionally non-fatal.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { RunPaths } from '../run-state/paths';
import { dispatchHas, dispatchRecord } from '../run-state/state';

export interface NotifyDispatchOpts {
  eventType: string;
  /** Project root where `.claude/.prove.json` + `.prove/runs/` live. Default: cwd. */
  projectRoot?: string;
  /** Override config path. Default: `<project-root>/.claude/.prove.json`. */
  configPath?: string;
  /** Branch / slug override (else read from env). */
  branch?: string;
  slug?: string;
}

interface ReporterEntry {
  name?: string;
  command?: string;
  events?: string[];
}

export function runNotifyDispatch(opts: NotifyDispatchOpts): number {
  const event = opts.eventType;
  if (!event) {
    process.stderr.write('dispatch-event: missing event type argument\n');
    return 0;
  }

  const projectRoot = resolve(opts.projectRoot ?? process.cwd());
  const branch = opts.branch ?? process.env.PROVE_RUN_BRANCH ?? '';
  const slug = opts.slug ?? process.env.PROVE_RUN_SLUG ?? '';

  if (!branch || !slug) {
    process.stderr.write('dispatch-event: PROVE_RUN_SLUG and PROVE_RUN_BRANCH required\n');
    return 0;
  }

  const runsRoot = join(projectRoot, '.prove', 'runs');
  const paths = RunPaths.forRun(runsRoot, branch, slug);
  if (!existsSync(paths.state)) {
    process.stderr.write(
      `dispatch-event: no state.json at ${paths.state} — run \`prove run-state init\` first\n`,
    );
    return 0;
  }

  const configPath = opts.configPath ?? join(projectRoot, '.claude', '.prove.json');
  if (!existsSync(configPath)) return 0;

  const dedupKey = `${event}:${process.env.PROVE_STEP || slug}`;
  try {
    if (dispatchHas(paths, dedupKey)) return 0;
  } catch {
    // State file unreadable — treat as never-dispatched and continue.
  }

  const reporters = loadReporters(configPath);
  const matches = reporters.filter((r) => (r.events ?? []).includes(event));

  const reporterEnv = buildReporterEnv(event, branch, slug);
  for (const entry of matches) {
    const name = entry.name ?? 'unnamed';
    const command = entry.command ?? '';
    if (!command) continue;

    process.stderr.write(`dispatch-event: firing ${name} for ${event}\n`);
    fireReporter(name, command, projectRoot, reporterEnv);
  }

  try {
    dispatchRecord(paths, dedupKey, event);
  } catch {
    // Best-effort — dispatch must not halt the orchestrator.
  }

  return 0;
}

function loadReporters(configPath: string): ReporterEntry[] {
  try {
    const raw = readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw) as { reporters?: unknown };
    const list = parsed?.reporters;
    if (!Array.isArray(list)) return [];
    return list.filter((x): x is ReporterEntry => x !== null && typeof x === 'object');
  } catch {
    return [];
  }
}

function buildReporterEnv(event: string, branch: string, slug: string): Record<string, string> {
  const env = process.env;
  return {
    ...env,
    PROVE_EVENT: event,
    PROVE_TASK: env.PROVE_TASK ?? slug,
    PROVE_STEP: env.PROVE_STEP ?? '',
    PROVE_STATUS: env.PROVE_STATUS ?? 'unknown',
    PROVE_BRANCH: env.PROVE_BRANCH ?? branch,
    PROVE_DETAIL: env.PROVE_DETAIL ?? '',
    PROVE_RUN_SLUG: slug,
    PROVE_RUN_BRANCH: branch,
  } as Record<string, string>;
}

function fireReporter(
  name: string,
  command: string,
  cwd: string,
  env: Record<string, string>,
): void {
  const res = spawnSync('bash', ['-c', command], {
    cwd,
    env,
    encoding: 'utf8',
  });

  // Mirror `2>&1 | sed 's/^/  [name] /' >&2` from the retired shell script:
  // merge stdout+stderr, prefix each non-empty line, drop the empty trailing
  // line that comes from a terminating newline.
  const merged = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  if (!merged) return;
  const lines = merged.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  for (const line of lines) {
    process.stderr.write(`  [${name}] ${line}\n`);
  }
}

/** Count matching reporters — used by `notify test` for the pre-dispatch
 *  "reporters matching" message. Returns -1 when config is missing. */
export function countMatchingReporters(configPath: string, event: string): number {
  if (!existsSync(configPath)) return -1;
  return loadReporters(configPath).filter((r) => (r.events ?? []).includes(event)).length;
}

export function countAllReporters(configPath: string): number {
  if (!existsSync(configPath)) return -1;
  return loadReporters(configPath).length;
}
