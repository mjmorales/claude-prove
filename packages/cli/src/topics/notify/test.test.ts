/**
 * Tests for `claude-prove notify test` — the operator-facing command that
 * actually fires reporters so Slack/Discord wiring can be confirmed.
 *
 * Regression: the command used to rely on PROVE_RUN_BRANCH/PROVE_RUN_SLUG
 * being present in env (they never were), so runNotifyDispatch bailed before
 * firing anything and the command was a silent no-op (F-2-001). These cases
 * assert the throwaway state.json is seeded, the reporter fires, and the
 * synthetic run directory is cleaned up afterward.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runNotifyTest } from './test';

let root: string;
let priorEnv: Partial<Record<string, string>>;
let restore: () => void;

function spyStd(): () => void {
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  return () => {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  };
}

function writeConfig(reporters: unknown): void {
  const dir = join(root, '.claude');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.prove.json'), JSON.stringify({ reporters }));
}

function unsetEnv(key: string): void {
  if (key in process.env) delete process.env[key];
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'notify-test-'));
  restore = spyStd();
  priorEnv = {
    PROVE_TASK: process.env.PROVE_TASK,
    PROVE_STEP: process.env.PROVE_STEP,
    PROVE_STATUS: process.env.PROVE_STATUS,
    PROVE_BRANCH: process.env.PROVE_BRANCH,
    PROVE_DETAIL: process.env.PROVE_DETAIL,
  };
});

afterEach(() => {
  restore();
  rmSync(root, { recursive: true, force: true });
  for (const [k, v] of Object.entries(priorEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('notify test', () => {
  test('missing config → exit 1', () => {
    expect(runNotifyTest({ eventType: 'step-complete', projectRoot: root })).toBe(1);
  });

  test('config present but no reporters → exit 1', () => {
    writeConfig([]);
    expect(runNotifyTest({ eventType: 'step-complete', projectRoot: root })).toBe(1);
  });

  test('reporters configured but none match the event → exit 2', () => {
    writeConfig([{ name: 'r', command: 'true', events: ['step-halted'] }]);
    process.env.PROVE_TASK = 'demo';
    expect(runNotifyTest({ eventType: 'step-complete', projectRoot: root })).toBe(2);
  });

  test('fires the matching reporter and cleans up the throwaway run dir', () => {
    const probe = join(root, 'probe.sh');
    const log = join(root, 'probe.log');
    writeFileSync(
      probe,
      `#!/usr/bin/env bash\necho "fired:$PROVE_EVENT:$PROVE_BRANCH" >> ${log}\n`,
    );
    writeConfig([{ name: 'probe', command: `bash ${probe}`, events: ['step-complete'] }]);
    process.env.PROVE_TASK = 'demo-slug';

    const code = runNotifyTest({ eventType: 'step-complete', projectRoot: root });
    expect(code).toBe(0);

    // Reporter actually ran — the regression was a silent no-op.
    const logContent = readFileSync(log, 'utf8');
    expect(logContent).toBe('fired:step-complete:test/notify-test\n');

    // Throwaway state.json and its branch dir were removed.
    expect(existsSync(join(root, '.prove', 'runs', 'test/notify-test'))).toBe(false);
  });

  test('no slug derivable (no PROVE_TASK, non-orchestrator branch) → exit 1', () => {
    writeConfig([{ name: 'probe', command: 'true', events: ['step-complete'] }]);
    unsetEnv('PROVE_TASK');
    // root is a bare temp dir with no git branch context → deriveTestSlug
    // returns '' and the command refuses to run.
    expect(runNotifyTest({ eventType: 'step-complete', projectRoot: root })).toBe(1);
  });
});
