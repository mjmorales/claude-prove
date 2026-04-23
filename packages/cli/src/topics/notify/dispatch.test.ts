/**
 * Parity tests for `prove notify dispatch`.
 *
 * Covers the contract formerly fulfilled by `scripts/dispatch-event.sh`:
 *   - missing env → silent exit 0 with stderr diagnostic
 *   - missing state.json → silent exit 0 with stderr diagnostic
 *   - missing .claude/.prove.json → silent exit 0 (no stderr)
 *   - reporter firing: stderr prefix `  [<name>] `, receives PROVE_* env
 *   - dedup: re-dispatch with same key is a no-op (not recorded twice)
 *   - reporter filter matches by `events` array
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runNotifyDispatch } from './dispatch';

let root: string;
let outCapture: string[];
let errCapture: string[];

function spyStd(): { restore: () => void } {
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  outCapture = [];
  errCapture = [];
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    outCapture.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    errCapture.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stderr.write;
  return {
    restore: () => {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    },
  };
}

function writeConfig(reporters: unknown): void {
  const dir = join(root, '.claude');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.prove.json'), JSON.stringify({ reporters }));
}

function seedRun(branch: string, slug: string): string {
  const runDir = join(root, '.prove', 'runs', branch, slug);
  mkdirSync(join(runDir, 'reports'), { recursive: true });
  const stateFile = join(runDir, 'state.json');
  writeFileSync(
    stateFile,
    JSON.stringify({
      schema_version: '1',
      kind: 'state',
      run_status: 'in_progress',
      slug,
      branch,
      current_task: '',
      current_step: '',
      started_at: '2026-04-23T00:00:00Z',
      updated_at: '2026-04-23T00:00:00Z',
      ended_at: '',
      tasks: [],
      dispatch: { dispatched: [] },
    }),
  );
  return stateFile;
}

let spy: { restore: () => void };
let priorEnv: Partial<Record<string, string>>;

/** Helper to keep `delete process.env.X` out of the test body (biome noDelete). */
function unsetEnv(key: string): void {
  if (key in process.env) delete process.env[key];
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'notify-dispatch-'));
  spy = spyStd();
  priorEnv = {
    PROVE_RUN_BRANCH: process.env.PROVE_RUN_BRANCH,
    PROVE_RUN_SLUG: process.env.PROVE_RUN_SLUG,
    PROVE_STEP: process.env.PROVE_STEP,
    PROVE_TASK: process.env.PROVE_TASK,
  };
});

afterEach(() => {
  spy.restore();
  rmSync(root, { recursive: true, force: true });
  for (const [k, v] of Object.entries(priorEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('notify dispatch', () => {
  test('missing branch/slug → exit 0 with stderr diagnostic', () => {
    unsetEnv('PROVE_RUN_BRANCH');
    unsetEnv('PROVE_RUN_SLUG');
    const code = runNotifyDispatch({ eventType: 'step-complete', projectRoot: root });
    expect(code).toBe(0);
    expect(errCapture.join('')).toContain('PROVE_RUN_SLUG and PROVE_RUN_BRANCH required');
  });

  test('missing state.json → exit 0 with stderr diagnostic', () => {
    const code = runNotifyDispatch({
      eventType: 'step-complete',
      projectRoot: root,
      branch: 'main',
      slug: 'missing',
    });
    expect(code).toBe(0);
    expect(errCapture.join('')).toContain('no state.json at');
  });

  test('missing config → exit 0, no stderr', () => {
    seedRun('main', 'run-a');
    const code = runNotifyDispatch({
      eventType: 'step-complete',
      projectRoot: root,
      branch: 'main',
      slug: 'run-a',
    });
    expect(code).toBe(0);
    expect(errCapture.join('')).toBe('');
  });

  test('fires matching reporter and records dedup key', () => {
    const stateFile = seedRun('main', 'run-a');
    const probe = join(root, 'probe.sh');
    const log = join(root, 'probe.log');
    writeFileSync(
      probe,
      `#!/usr/bin/env bash\necho "fired:$PROVE_EVENT:$PROVE_TASK:$PROVE_RUN_BRANCH" >> ${log}\n`,
    );
    writeConfig([
      {
        name: 'probe',
        command: `bash ${probe}`,
        events: ['step-complete', 'step-halted'],
      },
    ]);
    process.env.PROVE_STEP = '1.1';

    const code = runNotifyDispatch({
      eventType: 'step-complete',
      projectRoot: root,
      branch: 'main',
      slug: 'run-a',
    });
    expect(code).toBe(0);

    const logContent = readFileSync(log, 'utf8');
    expect(logContent).toBe('fired:step-complete:run-a:main\n');

    const state = JSON.parse(readFileSync(stateFile, 'utf8'));
    expect(state.dispatch.dispatched).toHaveLength(1);
    expect(state.dispatch.dispatched[0].key).toBe('step-complete:1.1');
    expect(state.dispatch.dispatched[0].event).toBe('step-complete');
  });

  test('dedup: second dispatch with same key is a no-op', () => {
    const stateFile = seedRun('main', 'run-a');
    const probe = join(root, 'probe.sh');
    const log = join(root, 'probe.log');
    writeFileSync(probe, `#!/usr/bin/env bash\necho fired >> ${log}\n`);
    writeConfig([{ name: 'probe', command: `bash ${probe}`, events: ['step-complete'] }]);
    process.env.PROVE_STEP = '1.1';

    runNotifyDispatch({
      eventType: 'step-complete',
      projectRoot: root,
      branch: 'main',
      slug: 'run-a',
    });
    runNotifyDispatch({
      eventType: 'step-complete',
      projectRoot: root,
      branch: 'main',
      slug: 'run-a',
    });

    const logContent = readFileSync(log, 'utf8');
    expect(logContent).toBe('fired\n');
    const state = JSON.parse(readFileSync(stateFile, 'utf8'));
    expect(state.dispatch.dispatched).toHaveLength(1);
  });

  test('skips reporters whose events array does not contain the event', () => {
    seedRun('main', 'run-a');
    const probe = join(root, 'probe.sh');
    const log = join(root, 'probe.log');
    writeFileSync(probe, `#!/usr/bin/env bash\necho fired >> ${log}\n`);
    writeConfig([{ name: 'other', command: `bash ${probe}`, events: ['step-halted'] }]);
    process.env.PROVE_STEP = '1.1';

    const code = runNotifyDispatch({
      eventType: 'step-complete',
      projectRoot: root,
      branch: 'main',
      slug: 'run-a',
    });
    expect(code).toBe(0);
    expect(() => readFileSync(log, 'utf8')).toThrow(); // log never created
  });
});
