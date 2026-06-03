/**
 * handoff-gate.ts unit tests — the end-of-session synthesis/handoff floor.
 *
 * Two layers: pure outcome classification (no IO) and the run-dir-reading
 * `evaluateSessionEndGate` (real tmpdir run with a `log/` tree). The gate must
 * (1) pass a session that touched no artifact, (2) pass a session whose
 * synthesis declares `completed` or a valid `handoff:<reason>`, and (3) block —
 * with actionable remediation — a session that touched an artifact and logged
 * neither.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CaptureEntry, SynthesisEntry } from '../acb/reasoning-log';
import {
  HANDOFF_REASONS,
  classifyOutcome,
  evaluateSessionEndGate,
  isCompliantOutcome,
} from './handoff-gate';

// ---------------------------------------------------------------------------
// Pure classification
// ---------------------------------------------------------------------------

describe('classifyOutcome', () => {
  test('bare completed token classifies as completed', () => {
    expect(classifyOutcome('completed')).toEqual({ kind: 'completed' });
  });

  test('completed with trailing prose classifies as completed', () => {
    expect(classifyOutcome('completed — shipped the login flow')).toEqual({ kind: 'completed' });
  });

  test('handoff with a valid reason classifies as handoff', () => {
    expect(classifyOutcome('handoff:context_budget')).toEqual({
      kind: 'handoff',
      reason: 'context_budget',
    });
  });

  test('handoff reason with trailing prose keeps just the reason token', () => {
    expect(classifyOutcome('handoff:blocked waiting on the migration task')).toEqual({
      kind: 'handoff',
      reason: 'blocked',
    });
  });

  test('every enum reason classifies', () => {
    for (const reason of HANDOFF_REASONS) {
      expect(classifyOutcome(`handoff:${reason}`)).toEqual({ kind: 'handoff', reason });
    }
  });

  test('handoff with an unknown reason does not classify', () => {
    expect(classifyOutcome('handoff:because-i-felt-like-it')).toBeNull();
  });

  test('a near-miss completion token does not classify', () => {
    expect(classifyOutcome('completedish')).toBeNull();
    expect(classifyOutcome('done')).toBeNull();
    expect(classifyOutcome('')).toBeNull();
  });

  test('isCompliantOutcome mirrors classifyOutcome', () => {
    expect(isCompliantOutcome('completed')).toBe(true);
    expect(isCompliantOutcome('handoff:checkpoint')).toBe(true);
    expect(isCompliantOutcome('partial progress')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// evaluateSessionEndGate — run-dir reading
// ---------------------------------------------------------------------------

let runDir: string;

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'handoff-gate-'));
});

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
});

function writeEntry(agent: string, entry: CaptureEntry | SynthesisEntry): void {
  const dir = join(runDir, 'log', agent);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${entry.id}.json`), `${JSON.stringify(entry, null, 2)}\n`);
}

function captureEntry(id: string, tool: string, target?: string): CaptureEntry {
  const entry: CaptureEntry = {
    id,
    ts: `2026-04-23T10:0${id.length}:00Z`,
    type: 'capture',
    agent: 'capture',
    run_path: runDir,
    body: target ? `${tool} ${target}` : tool,
    tool,
  };
  if (target !== undefined) entry.target = target;
  return entry;
}

function synthesisEntry(id: string, outcome: string): SynthesisEntry {
  return {
    id,
    ts: `2026-04-23T11:0${id.length}:00Z`,
    type: 'synthesis',
    agent: 'general-purpose',
    run_path: runDir,
    body: 'episode summary',
    outcome,
  };
}

test('passes when the run dir is null', () => {
  const verdict = evaluateSessionEndGate(null);
  expect(verdict.ok).toBe(true);
  expect(verdict.reason).toBe('no_run');
});

test('passes when the run dir does not exist', () => {
  const verdict = evaluateSessionEndGate(join(runDir, 'nope'));
  expect(verdict.ok).toBe(true);
  expect(verdict.reason).toBe('no_run');
});

test('passes when no artifact was touched (read-only session)', () => {
  writeEntry('capture', captureEntry('a', 'Read', '/some/file.ts'));
  const verdict = evaluateSessionEndGate(runDir);
  expect(verdict.ok).toBe(true);
  expect(verdict.reason).toBe('no_artifact_touched');
});

test('passes a touched session with a completed synthesis', () => {
  writeEntry('capture', captureEntry('a', 'Write', '/x.ts'));
  writeEntry('general-purpose', synthesisEntry('b', 'completed'));
  const verdict = evaluateSessionEndGate(runDir);
  expect(verdict.ok).toBe(true);
  expect(verdict.reason).toBe('compliant');
});

test('passes a touched session with a valid handoff synthesis', () => {
  writeEntry('capture', captureEntry('a', 'Edit', '/x.ts'));
  writeEntry('general-purpose', synthesisEntry('b', 'handoff:context_budget more to do'));
  const verdict = evaluateSessionEndGate(runDir);
  expect(verdict.ok).toBe(true);
  expect(verdict.reason).toBe('compliant');
});

test('blocks a touched session with no synthesis and gives remediation', () => {
  writeEntry('capture', captureEntry('a', 'Write', '/x.ts'));
  const verdict = evaluateSessionEndGate(runDir);
  expect(verdict.ok).toBe(false);
  expect(verdict.reason).toBe('missing_synthesis');
  expect(verdict.message).toContain('BLOCKED');
  expect(verdict.message).toContain('completed');
  expect(verdict.message).toContain('handoff:');
  expect(verdict.message).toContain('acb log append');
  // Lists the closed reason enum so the worker knows the valid set.
  for (const reason of HANDOFF_REASONS) expect(verdict.message).toContain(reason);
});

test('blocks a touched session whose synthesis outcome is an invalid declaration', () => {
  writeEntry('capture', captureEntry('a', 'Bash', 'go build ./...'));
  writeEntry('general-purpose', synthesisEntry('b', 'made some progress'));
  const verdict = evaluateSessionEndGate(runDir);
  expect(verdict.ok).toBe(false);
  expect(verdict.reason).toBe('invalid_declaration');
  expect(verdict.message).toContain('BLOCKED');
  expect(verdict.message).toContain('made some progress');
  expect(verdict.message).toContain('acb log append');
});

test('Bash capture counts as touching an artifact', () => {
  writeEntry('capture', captureEntry('a', 'Bash', 'rm -rf build'));
  const verdict = evaluateSessionEndGate(runDir);
  expect(verdict.ok).toBe(false);
  expect(verdict.reason).toBe('missing_synthesis');
});

test('the latest synthesis wins when several exist', () => {
  writeEntry('capture', captureEntry('a', 'Write', '/x.ts'));
  writeEntry('general-purpose', synthesisEntry('b', 'made some progress'));
  writeEntry('general-purpose', synthesisEntry('c', 'completed'));
  const verdict = evaluateSessionEndGate(runDir);
  expect(verdict.ok).toBe(true);
  expect(verdict.reason).toBe('compliant');
});

test('dev_mode shapes the remediation command prefix', () => {
  writeEntry('capture', captureEntry('a', 'Write', '/x.ts'));
  const installed = evaluateSessionEndGate(runDir, false);
  const dev = evaluateSessionEndGate(runDir, true);
  expect(installed.message).toContain('claude-prove acb log append');
  expect(dev.message).toContain('bun run');
});
