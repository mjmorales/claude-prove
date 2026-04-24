/**
 * `claude-prove notify test <event>` — exercise the notification pipeline.
 *
 * Replaces `scripts/notify-test.sh`. Flow:
 *   1. Read `.claude/.prove.json` from the current project root.
 *   2. Count reporters matching `<event>`. Report counts on stdout.
 *   3. Derive a test slug (PROVE_TASK env, else `orchestrator/*` branch name).
 *   4. Back up `.prove/runs/<slug>/dispatch-state.json` if present and clear
 *      the dedup ledger so the test event actually fires.
 *   5. Populate PROVE_* env with test values and invoke `runNotifyDispatch`.
 *   6. Restore the dedup state file.
 *
 * Exit codes:
 *   0  all tested reporters invoked (dispatch return code non-blocking)
 *   1  configuration missing, parse error, or no slug derivable
 *   2  no reporters matched the event — nothing to test
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { countAllReporters, countMatchingReporters, runNotifyDispatch } from './dispatch';

export interface NotifyTestOpts {
  eventType?: string;
  projectRoot?: string;
}

const DEFAULT_EVENT = 'step-complete';

export function runNotifyTest(opts: NotifyTestOpts): number {
  const event = opts.eventType || DEFAULT_EVENT;
  const projectRoot = resolve(opts.projectRoot ?? process.cwd());
  const configPath = join(projectRoot, '.claude', '.prove.json');

  if (!existsSync(configPath)) {
    process.stdout.write(`ERROR: ${configPath} not found.\n`);
    process.stdout.write('Run /prove:notify setup to configure reporters.\n');
    return 1;
  }

  const matching = countMatchingReporters(configPath, event);
  if (matching < 0) {
    process.stdout.write(`ERROR: Failed to parse ${configPath}.\n`);
    return 1;
  }

  if (matching === 0) {
    const total = countAllReporters(configPath);
    if (total <= 0) {
      process.stdout.write(`No reporters configured in ${configPath}.\n`);
      process.stdout.write('Run /prove:notify setup to add reporters.\n');
      return 1;
    }
    process.stdout.write(`No reporters matched event '${event}' — nothing to test.\n`);
    return 2;
  }

  const testSlug = deriveTestSlug(projectRoot);
  if (!testSlug) {
    process.stderr.write(
      'No orchestrator context — set PROVE_TASK or be on an orchestrator/* branch\n',
    );
    return 1;
  }

  // Legacy dedup sidecar path (kept for backward compatibility with setups
  // that still use the pre-run_state dispatcher). New dedup lives in
  // state.json.dispatch.dispatched[]; clearing the state file wholesale
  // here would risk wider damage, so we only touch the legacy sidecar.
  const legacyStateFile = join(projectRoot, '.prove', 'runs', testSlug, 'dispatch-state.json');
  const hasBackup = existsSync(legacyStateFile);
  if (hasBackup) {
    copyFileSync(legacyStateFile, `${legacyStateFile}.bak`);
    writeFileSync(legacyStateFile, '{"dispatched":[]}');
  }

  process.stdout.write('=== Notify Test ===\n');
  process.stdout.write(`Event: ${event}\n`);
  process.stdout.write(`Reporters matching: ${matching}\n`);
  process.stdout.write('\n');

  // The run_state ledger lives under `.prove/runs/<branch>/<slug>/state.json`.
  // For a pure notification test we synthesize PROVE_TASK/STEP/etc. env and
  // let runNotifyDispatch skip dedup cleanly if state.json is absent.
  const priorEnv = {
    PROVE_TASK: process.env.PROVE_TASK,
    PROVE_STEP: process.env.PROVE_STEP,
    PROVE_STATUS: process.env.PROVE_STATUS,
    PROVE_BRANCH: process.env.PROVE_BRANCH,
    PROVE_DETAIL: process.env.PROVE_DETAIL,
  };
  process.env.PROVE_TASK = 'test-notification';
  process.env.PROVE_STEP = '0';
  process.env.PROVE_STATUS = 'test';
  process.env.PROVE_BRANCH = 'test/notify-test';
  process.env.PROVE_DETAIL = 'Test notification from claude-prove notify test';

  const dispatchCode = runNotifyDispatch({
    eventType: event,
    projectRoot,
    // Inherit PROVE_RUN_SLUG/BRANCH from env if set; otherwise dispatch
    // returns 0 with a missing-context stderr message.
  });

  // Restore env (process-scoped, so only matters under a reused bun process).
  for (const [key, val] of Object.entries(priorEnv)) {
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }

  if (hasBackup) {
    renameSync(`${legacyStateFile}.bak`, legacyStateFile);
  }

  process.stdout.write('\n');
  process.stdout.write('=== Results ===\n');
  process.stdout.write(`Dispatched event '${event}' to ${matching} reporter(s)\n`);

  if (dispatchCode !== 0) {
    process.stdout.write(
      `WARNING: Dispatch exited with code ${dispatchCode} (reporters are best-effort)\n`,
    );
  }

  return 0;
}

/**
 * Resolve a slug for dedup-state clearing. Mirrors the retired shell's
 * fallback chain: `PROVE_TASK` env first, then the current branch name when
 * it is an `orchestrator/*` branch.
 */
function deriveTestSlug(projectRoot: string): string {
  const fromEnv = process.env.PROVE_TASK;
  if (fromEnv) return fromEnv;

  const res = spawnSync('git', ['branch', '--show-current'], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
  const branch = (res.stdout ?? '').trim();
  if (branch.startsWith('orchestrator/')) return branch.slice('orchestrator/'.length);
  return '';
}
