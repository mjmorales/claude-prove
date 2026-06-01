/**
 * brief-cmd.ts CLI-contract tests (ac-brief-cli).
 *
 * Verifies `acb brief render|validate` follow the stdout=document/JSON,
 * stderr=summary, exit-code contract. Entries are written to a tmp run dir
 * via the canonical `appendEntry` ingest path.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendEntry } from '../reasoning-log-store';
import { runBrief } from './brief-cmd';

let runDir: string;

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'acb-brief-'));
});
afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
});

interface Captured {
  stdout: string;
  stderr: string;
  exit: number;
}

function withCapture(fn: () => number): Captured {
  let stdout = '';
  let stderr = '';
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string | Uint8Array) => {
    stdout += typeof c === 'string' ? c : Buffer.from(c).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => {
    stderr += typeof c === 'string' ? c : Buffer.from(c).toString('utf8');
    return true;
  }) as typeof process.stderr.write;
  try {
    const exit = fn();
    return { stdout, stderr, exit };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

/** Seed a small log: one decision (with alternatives) + one hack. */
function seedLog(): void {
  appendEntry(runDir, {
    id: 'd1',
    ts: '2026-06-01T00:00:00Z',
    type: 'decision',
    agent: 'engineer',
    run_path: runDir,
    body: 'chose bun',
    alternatives: ['stay-on-bun', 'rewrite-in-go'],
    selected_rationale: 'velocity',
  });
  appendEntry(runDir, {
    id: 'h1',
    ts: '2026-06-01T01:00:00Z',
    type: 'hack',
    agent: 'engineer',
    run_path: runDir,
    body: 'temporary shim',
    file_refs: ['x.ts'],
    cleanup_condition: 'when upstream lands',
  });
}

describe('acb brief render', () => {
  test('emits the 7-section markdown with embedded ids, exit 0', () => {
    seedLog();
    const res = withCapture(() => runBrief('render', { runDir }));
    expect(res.exit).toBe(0);
    expect(res.stdout).toContain('## 2. Needs your attention');
    expect(res.stdout).toContain('(h1)');
    expect(res.stdout).toContain('stay-on-bun');
    expect(res.stderr).toContain('Brief rendered');
  });

  test('missing --run-dir → exit 1', () => {
    const res = withCapture(() => runBrief('render', {}));
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('--run-dir is required');
  });
});

describe('acb brief validate', () => {
  test('PASS: a preserving brief → JSON ok:true on stdout, exit 0', () => {
    seedLog();
    const rendered = withCapture(() => runBrief('render', { runDir })).stdout;
    const briefFile = join(runDir, 'brief.md');
    writeFileSync(briefFile, rendered, 'utf8');

    const res = withCapture(() => runBrief('validate', { runDir, file: briefFile }));
    expect(res.exit).toBe(0);
    const payload = JSON.parse(res.stdout.trim()) as { ok: boolean; required: number };
    expect(payload.ok).toBe(true);
    expect(payload.required).toBe(2); // the decision + the hack
    expect(res.stderr).toContain('preserves all 2');
  });

  test('FAIL: a brief that dropped the hack → JSON ok:false, exit 1, stderr lists it', () => {
    seedLog();
    const badFile = join(runDir, 'bad.md');
    // Mentions the decision + both alternatives but omits the hack id.
    writeFileSync(badFile, 'chose bun d1 stay-on-bun rewrite-in-go', 'utf8');

    const res = withCapture(() => runBrief('validate', { runDir, file: badFile }));
    expect(res.exit).toBe(1);
    const payload = JSON.parse(res.stdout.trim()) as { ok: boolean; missing: string[] };
    expect(payload.ok).toBe(false);
    expect(payload.missing).toContain('hack:h1');
    expect(res.stderr).toContain('DROPPED');
  });

  test('unknown sub-action → exit 1', () => {
    const res = withCapture(() => runBrief('bogus', { runDir }));
    expect(res.exit).toBe(1);
    expect(res.stderr).toContain('unknown brief sub-action');
  });
});
