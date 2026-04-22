/**
 * render.ts tests — unit coverage plus byte-parity against Python captures.
 *
 * Unit tests exercise each exported renderer on canonical fixtures and
 * edge cases (halted step, validator-failed step, empty plan, missing
 * review, multiple dispatch entries). The parity block mirrors state/
 * schemas/ validator: compare every captured file 1:1.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  renderCurrent,
  renderPlan,
  renderPrd,
  renderReport,
  renderState,
  renderSummary,
} from './render';
import type { PlanData, PrdData, ReportData, StateData } from './state';

const FIXTURES_DIR = join(import.meta.dir, '__fixtures__/render');
const CASES_DIR = join(FIXTURES_DIR, 'cases');
const PY_CAP = join(FIXTURES_DIR, 'python-captures');
const TS_CAP = join(FIXTURES_DIR, 'ts-captures');

function loadCase<T>(name: string): T {
  return JSON.parse(readFileSync(join(CASES_DIR, name), 'utf8')) as T;
}

// ---------------------------------------------------------------------------
// renderPrd
// ---------------------------------------------------------------------------

describe('renderPrd', () => {
  test('markdown: full PRD includes every section in order', () => {
    const prd = loadCase<PrdData>('prd_full.json');
    const out = renderPrd(prd);
    expect(out.startsWith('# Port run_state to TypeScript\n')).toBe(true);
    expect(out).toContain('## Context');
    expect(out).toContain('## Goals');
    expect(out).toContain('## Scope');
    expect(out).toContain('**In scope**');
    expect(out).toContain('**Out of scope**');
    expect(out).toContain('## Acceptance Criteria');
    expect(out).toContain('## Test Strategy');
    // body_markdown appended verbatim (rstripped) + trailing newline
    expect(out.endsWith('\n')).toBe(true);
  });

  test('markdown: minimal PRD collapses to title only', () => {
    const prd = loadCase<PrdData>('prd_minimal.json');
    const out = renderPrd(prd);
    expect(out).toBe('# Minimal PRD\n');
  });

  test('markdown: untitled PRD falls back to "Untitled"', () => {
    const prd = { schema_version: '1', kind: 'prd' } as unknown as PrdData;
    const out = renderPrd(prd);
    expect(out).toBe('# Untitled\n');
  });

  test('json: pretty-prints with trailing newline', () => {
    const prd = loadCase<PrdData>('prd_minimal.json');
    const out = renderPrd(prd, { format: 'json' });
    expect(out).toBe(`${JSON.stringify(prd, null, 2)}\n`);
  });
});

// ---------------------------------------------------------------------------
// renderPlan
// ---------------------------------------------------------------------------

describe('renderPlan', () => {
  test('markdown: multi-wave plan groups by wave ascending', () => {
    const plan = loadCase<PlanData>('plan_multi_wave.json');
    const out = renderPlan(plan);
    const wave1 = out.indexOf('## Wave 1');
    const wave2 = out.indexOf('## Wave 2');
    expect(wave1).toBeGreaterThan(-1);
    expect(wave2).toBeGreaterThan(wave1);
    expect(out).toContain('### Task 1.1: Foundation');
    expect(out).toContain('**Depends on:** 1.1');
    expect(out).toContain('**Worktree:** .claude/worktrees/demo-1');
    expect(out).toContain('**Branch:** task/demo/1');
    expect(out).toContain('**Acceptance Criteria**');
    expect(out).toContain('**Steps**');
    expect(out).toContain('- `1.1.1` Port schemas');
  });

  test('markdown: empty plan still emits header', () => {
    const plan = loadCase<PlanData>('plan_empty.json');
    const out = renderPlan(plan);
    expect(out).toBe('# Task Plan (simple mode)\n');
  });

  test('json: matches byte-for-byte pretty dump', () => {
    const plan = loadCase<PlanData>('plan_multi_wave.json');
    const out = renderPlan(plan, { format: 'json' });
    expect(out).toBe(`${JSON.stringify(plan, null, 2)}\n`);
  });
});

// ---------------------------------------------------------------------------
// renderState
// ---------------------------------------------------------------------------

describe('renderState', () => {
  test('pending: no current step, no timestamps beyond updated', () => {
    const state = loadCase<StateData>('state_pending.json');
    const out = renderState(state);
    expect(out).toContain('**Status:**');
    expect(out).not.toContain('**Current step:**');
    expect(out).not.toContain('**Started:**');
    expect(out).not.toContain('**Ended:**');
    expect(out).toContain('**Updated:** 2026-04-22T12:00:00Z');
    expect(out).toContain('## Task 1.1 — [ ] `pending`');
  });

  test('in_progress: current step + started timestamp present', () => {
    const state = loadCase<StateData>('state_in_progress.json');
    const plan = loadCase<PlanData>('plan_multi_wave.json');
    const out = renderState(state, { plan });
    expect(out).toContain('**Current step:** `1.1.2`');
    expect(out).toContain('**Started:** 2026-04-22T12:00:00Z');
    expect(out).toContain('## Task 1.1 — [~] `in_progress`: Foundation');
    expect(out).toContain('- `1.1.1` [x] Port schemas');
    expect(out).toContain('  - validators: build=pass, lint=pass, test=pass');
    expect(out).toContain('- `1.1.2` [~] Port validator engine');
    expect(out).toContain('  - validators: build=pass');
  });

  test('completed: approved review prints verdict + notes', () => {
    const state = loadCase<StateData>('state_completed.json');
    const plan = loadCase<PlanData>('plan_multi_wave.json');
    const out = renderState(state, { plan });
    expect(out).toContain('**Review:** APPROVED');
    expect(out).toContain('  _ship it_');
    // Validators that are all pass/skipped — the skipped ones are elided.
    expect(out).toContain('  - validators: build=pass, lint=pass, test=pass');
  });

  test('halted: shows halt reason + validator failure', () => {
    const state = loadCase<StateData>('state_halted.json');
    const plan = loadCase<PlanData>('plan_multi_wave.json');
    const out = renderState(state, { plan });
    expect(out).toContain('## Task 1.1 — [H] `halted`: Foundation');
    expect(out).toContain('**Review:** REJECTED');
    expect(out).toContain('  _missing coverage for edge cases_');
    expect(out).toContain('  - halt: lint failed after retry');
    expect(out).toContain('  - validators: build=pass, lint=fail');
  });

  test('markdown without plan: titles are omitted but structure persists', () => {
    const state = loadCase<StateData>('state_in_progress.json');
    const out = renderState(state);
    expect(out).toContain('## Task 1.1 — [~] `in_progress`');
    expect(out).not.toContain('Foundation');
  });

  test('json: emits pretty dump', () => {
    const state = loadCase<StateData>('state_completed.json');
    const out = renderState(state, { format: 'json' });
    expect(out).toBe(`${JSON.stringify(state, null, 2)}\n`);
  });

  test('pending review is suppressed (verdict == "pending")', () => {
    const state = loadCase<StateData>('state_pending.json');
    const out = renderState(state);
    expect(out).not.toContain('**Review:**');
  });
});

// ---------------------------------------------------------------------------
// renderReport
// ---------------------------------------------------------------------------

describe('renderReport', () => {
  test('completed: diff + validators + artifacts + notes rendered', () => {
    const report = loadCase<ReportData>('report_completed.json');
    const out = renderReport(report);
    expect(out).toContain('# Step Report: `1.1.1`');
    expect(out).toContain('**Task:** `1.1`');
    expect(out).toContain('**Status:** [x]');
    expect(out).toContain('**Commit:** `abc1234`');
    expect(out).toContain('**Diff:** 3 files, +120 / -15');
    expect(out).toContain('## Validators');
    expect(out).toContain('- **build** (build): PASS (2s)');
    expect(out).toContain('- **tests** (test): PASS (8s)');
    expect(out).toContain('## Artifacts');
    expect(out).toContain('- `packages/cli/src/topics/run-state/render.ts`');
    expect(out).toContain('## Notes');
    expect(out).toContain('Byte-equal on all canonical fixtures.');
  });

  test('halted: failing validator embeds output fenced block', () => {
    const report = loadCase<ReportData>('report_halted.json');
    const out = renderReport(report);
    expect(out).toContain('**Status:** [H]');
    // no commit sha line
    expect(out).not.toContain('**Commit:**');
    // no diff (all zeros)
    expect(out).not.toContain('**Diff:**');
    expect(out).toContain('- **lint** (lint): FAIL (1s)');
    expect(out).toContain('```\nerr: unused variable `foo`\nerr: unused variable `bar`\n```');
    // empty artifacts and empty notes sections elided
    expect(out).not.toContain('## Artifacts');
    expect(out).not.toContain('## Notes');
  });

  test('json: pretty dump', () => {
    const report = loadCase<ReportData>('report_completed.json');
    const out = renderReport(report, { format: 'json' });
    expect(out).toBe(`${JSON.stringify(report, null, 2)}\n`);
  });

  test('missing fields fall back to "?"', () => {
    const report = { schema_version: '1', kind: 'report' } as unknown as ReportData;
    const out = renderReport(report);
    expect(out).toContain('# Step Report: `?`');
    expect(out).toContain('**Task:** `?`');
    expect(out).toContain('**Status:** ?');
  });
});

// ---------------------------------------------------------------------------
// renderSummary
// ---------------------------------------------------------------------------

describe('renderSummary', () => {
  test('in_progress: elides zero counts, prints Current line', () => {
    const state = loadCase<StateData>('state_in_progress.json');
    const out = renderSummary(state);
    expect(out).toBe(
      'Run feature/demo/demo: running\n' +
        'Tasks — in_progress: 1\n' +
        'Steps — in_progress: 1, completed: 1\n' +
        'Current: 1.1.2\n',
    );
  });

  test('completed: no Current line, counts reflect completed', () => {
    const state = loadCase<StateData>('state_completed.json');
    const out = renderSummary(state);
    expect(out).toBe(
      'Run feature/demo/demo: completed\n' + 'Tasks — completed: 1\n' + 'Steps — completed: 1\n',
    );
  });

  test('halted: halt counts are reflected', () => {
    const state = loadCase<StateData>('state_halted.json');
    const out = renderSummary(state);
    expect(out).toContain('Run feature/demo/demo: halted');
    expect(out).toContain('Tasks — halted: 1');
    expect(out).toContain('Steps — halted: 1');
  });

  test('pending: counts pending tasks and steps', () => {
    const state = loadCase<StateData>('state_pending.json');
    const out = renderSummary(state);
    expect(out).toBe(
      'Run feature/demo/demo: pending\n' + 'Tasks — pending: 1\n' + 'Steps — pending: 1\n',
    );
  });
});

// ---------------------------------------------------------------------------
// renderCurrent
// ---------------------------------------------------------------------------

describe('renderCurrent', () => {
  test('md: delegates to renderSummary', () => {
    const state = loadCase<StateData>('state_in_progress.json');
    expect(renderCurrent(state)).toBe(renderSummary(state));
  });

  test('json: matches pretty dump with trailing newline', () => {
    const state = loadCase<StateData>('state_in_progress.json');
    const out = renderCurrent(state, { format: 'json' });
    expect(out).toBe(`${JSON.stringify(state, null, 2)}\n`);
  });
});

// ---------------------------------------------------------------------------
// Dispatch ledger is preserved under JSON dump
// ---------------------------------------------------------------------------

describe('JSON round-trip preserves dispatch ledger', () => {
  test('state JSON keeps multiple dispatch entries verbatim', () => {
    const state = loadCase<StateData>('state_completed.json');
    const out = renderState(state, { format: 'json' });
    const parsed = JSON.parse(out);
    expect(parsed.dispatch.dispatched).toHaveLength(2);
    expect(parsed.dispatch.dispatched[0].key).toBe('step-complete:1.1.1');
    expect(parsed.dispatch.dispatched[1].key).toBe('execution-complete:demo');
  });
});

// ---------------------------------------------------------------------------
// Parity: every Python capture has a byte-equal TS capture.
// ---------------------------------------------------------------------------

describe('render.ts byte-parity with Python render.py', () => {
  const pyFiles = readdirSync(PY_CAP).sort();
  const tsFiles = readdirSync(TS_CAP).sort();

  test('capture sets match', () => {
    expect(tsFiles).toEqual(pyFiles);
  });

  for (const rel of pyFiles) {
    test(`byte-equal: ${rel}`, () => {
      const pyBytes = readFileSync(join(PY_CAP, rel));
      const tsBytes = readFileSync(join(TS_CAP, rel));
      expect(tsBytes.equals(pyBytes)).toBe(true);
    });
  }
});
