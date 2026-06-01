/**
 * brief-validate.ts unit tests (Stage-1 preservation, ac-brief-preserve).
 *
 * Covers: PASSES when a rendered brief carries every attention-bearing item;
 * FAILS with a missing list when any hack/risk/bailout/open-assumption id or
 * decision alternative is absent; resolved assumptions are not required.
 */

import { describe, expect, test } from 'bun:test';
import { buildBrief, renderBrief } from './brief';
import { validatePreservation } from './brief-validate';
import { type LogEntry, deriveEpisodes } from './reasoning-log';

function envelope(id: string, type: string, body = `${type} ${id}`) {
  return { id, ts: `2026-06-01T00:00:00Z#${id}`, type, agent: 'engineer', run_path: '/run', body };
}
const hack = (id: string): LogEntry =>
  ({ ...envelope(id, 'hack'), file_refs: [], cleanup_condition: 'later' }) as LogEntry;
const risk = (id: string): LogEntry =>
  ({ ...envelope(id, 'risk'), severity: 'high', mitigation: 'm' }) as LogEntry;
const bailout = (id: string): LogEntry =>
  ({ ...envelope(id, 'bailout'), attempted: 'a', reason_abandoned: 'r' }) as LogEntry;
const assumption = (id: string, resolved: boolean): LogEntry =>
  ({ ...envelope(id, 'assumption'), resolved, resolution_ref: resolved ? 'r' : null }) as LogEntry;
const decision = (id: string, alternatives: string[]): LogEntry =>
  ({ ...envelope(id, 'decision'), alternatives, selected_rationale: 'won' }) as LogEntry;

/** The mechanical brief text for a set of entries — preserves everything by construction. */
function brief(entries: LogEntry[]): string {
  return renderBrief(buildBrief(entries, deriveEpisodes(entries)));
}

describe('validatePreservation', () => {
  test('PASSES when the rendered brief carries every required item', () => {
    const entries = [
      hack('h1'),
      risk('r1'),
      bailout('b1'),
      assumption('a-open', false),
      decision('d1', ['alpha-path', 'beta-path']),
    ];
    const result = validatePreservation(brief(entries), entries);
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.required).toBe(5);
  });

  test('FAILS listing the dropped hack/risk/bailout/open-assumption ids', () => {
    const entries = [hack('h1'), risk('r1'), bailout('b1'), assumption('a-open', false)];
    const result = validatePreservation('a brief that mentions nothing relevant', entries);
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['hack:h1', 'risk:r1', 'bailout:b1', 'open-assumption:a-open']);
  });

  test('FAILS when a decision alternative is dropped even if the id is present', () => {
    const entries = [decision('d1', ['kept-alt', 'dropped-alt'])];
    // Brief mentions the decision id and one alternative, but not the other.
    const partial = 'decision d1 considered kept-alt';
    const result = validatePreservation(partial, entries);
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['decision-alternative:d1:"dropped-alt"']);
  });

  test('resolved assumptions are not required (a brief may omit them)', () => {
    const entries = [assumption('a-resolved', true), assumption('a-open', false)];
    // Brief carries only the open assumption.
    const result = validatePreservation('open concern a-open', entries);
    expect(result.ok).toBe(true);
    expect(result.required).toBe(1);
  });

  test('decisions without alternatives impose no requirement', () => {
    const entries = [decision('d1', [])];
    const result = validatePreservation('says nothing', entries);
    expect(result.ok).toBe(true);
    expect(result.required).toBe(0);
  });
});
