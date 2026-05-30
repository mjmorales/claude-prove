/**
 * Tests for `claude-prove orchestrator wave-plan`.
 *
 * Covers: wave grouping from plan.json, batch splitting under --max-agents,
 * dispatch-round / peak-concurrency accounting, dependency warnings (unknown
 * dep, dep not in an earlier wave), markdown rendering, and the missing/empty
 * plan error paths.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWavePlan } from './wave-plan';

let runDir: string;
let stdoutBuf: string;
let stderrBuf: string;

function spyStd(): { restore: () => void } {
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  stdoutBuf = '';
  stderrBuf = '';
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdoutBuf += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderrBuf += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stderr.write;
  return {
    restore: () => {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    },
  };
}

function writePlan(plan: unknown): void {
  writeFileSync(join(runDir, 'plan.json'), JSON.stringify(plan));
}

interface ScheduleShape {
  total_tasks: number;
  wave_count: number;
  dispatch_rounds: number;
  peak_concurrency: number;
  max_agents: number | null;
  waves: Array<{ wave: number; tasks: string[]; batches: string[][] }>;
  warnings: string[];
}

function run(opts: { maxAgents?: number; format?: 'json' | 'md' } = {}): {
  exit: number;
  stdout: string;
  stderr: string;
} {
  const spy = spyStd();
  try {
    const exit = runWavePlan({ runDir, ...opts });
    return { exit, stdout: stdoutBuf, stderr: stderrBuf };
  } finally {
    spy.restore();
  }
}

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'wave-plan-'));
});

afterEach(() => {
  try {
    rmSync(runDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('runWavePlan — errors', () => {
  test('missing plan.json exits 1', () => {
    const res = run();
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('plan.json not found');
  });

  test('plan with no tasks exits 1', () => {
    writePlan({ kind: 'plan', tasks: [] });
    const res = run();
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('no tasks to schedule');
  });
});

describe('runWavePlan — scheduling', () => {
  test('groups tasks into waves, one batch each when uncapped', () => {
    writePlan({
      mode: 'full',
      tasks: [
        { id: '1.1', wave: 1, deps: [] },
        { id: '2.1', wave: 2, deps: ['1.1'] },
        { id: '2.2', wave: 2, deps: ['1.1'] },
        { id: '3.1', wave: 3, deps: ['2.1', '2.2'] },
      ],
    });
    const res = run();
    expect(res.exit).toBe(0);
    const s: ScheduleShape = JSON.parse(res.stdout.trim());
    expect(s.total_tasks).toBe(4);
    expect(s.wave_count).toBe(3);
    expect(s.max_agents).toBeNull();
    expect(s.waves.map((w) => w.tasks)).toEqual([['1.1'], ['2.1', '2.2'], ['3.1']]);
    // uncapped => one batch per wave
    expect(s.waves.map((w) => w.batches.length)).toEqual([1, 1, 1]);
    expect(s.dispatch_rounds).toBe(3);
    expect(s.peak_concurrency).toBe(2);
    expect(s.warnings).toEqual([]);
  });

  test('--max-agents splits an oversized wave into batches', () => {
    writePlan({
      mode: 'full',
      tasks: [
        { id: '1.1', wave: 1 },
        { id: '1.2', wave: 1 },
        { id: '1.3', wave: 1 },
        { id: '1.4', wave: 1 },
        { id: '1.5', wave: 1 },
      ],
    });
    const res = run({ maxAgents: 2 });
    expect(res.exit).toBe(0);
    const s: ScheduleShape = JSON.parse(res.stdout.trim());
    expect(s.max_agents).toBe(2);
    expect(s.waves).toHaveLength(1);
    expect(s.waves[0].batches).toEqual([['1.1', '1.2'], ['1.3', '1.4'], ['1.5']]);
    expect(s.dispatch_rounds).toBe(3); // 3 sequential batches
    expect(s.peak_concurrency).toBe(2); // cap honored
  });

  test('warns on unknown dep and dep not in an earlier wave', () => {
    writePlan({
      tasks: [
        { id: '1.1', wave: 1, deps: ['ghost'] },
        { id: '1.2', wave: 1, deps: ['1.1'] }, // same wave as its dep
      ],
    });
    const res = run();
    expect(res.exit).toBe(0);
    const s: ScheduleShape = JSON.parse(res.stdout.trim());
    expect(s.warnings).toHaveLength(2);
    expect(s.warnings.some((w) => w.includes('unknown task ghost'))).toBe(true);
    expect(s.warnings.some((w) => w.includes('not in an earlier wave'))).toBe(true);
  });

  test('--format md renders a dry-run table', () => {
    writePlan({
      mode: 'full',
      tasks: [
        { id: '1.1', wave: 1 },
        { id: '2.1', wave: 2, deps: ['1.1'] },
      ],
    });
    const res = run({ format: 'md', maxAgents: 4 });
    expect(res.exit).toBe(0);
    expect(res.stdout).toContain('# Workflow dry-run');
    expect(res.stdout).toContain('**Fan-out cap**: 4');
    expect(res.stdout).toContain('| Wave | Batch | Tasks |');
    expect(res.stdout).toContain('| 1 | 1/1 | 1.1 |');
    expect(res.stdout).toContain('| 2 | 1/1 | 2.1 |');
  });

  test('tasks default to wave 1 when wave is absent', () => {
    writePlan({ tasks: [{ id: 'a' }, { id: 'b' }] });
    const res = run();
    const s: ScheduleShape = JSON.parse(res.stdout.trim());
    expect(s.wave_count).toBe(1);
    expect(s.waves[0].tasks).toEqual(['a', 'b']);
  });
});
