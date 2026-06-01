/**
 * milestone-brief.ts unit tests.
 *
 * Covers:
 *   - buildMilestoneBrief: the four stakeholder sections (deduped attention,
 *     outcomes shipped per story, decisions of record, what-did-not-ship).
 *   - dedup across stories: a shared entry id surfaces once, attributed to the
 *     first story it was seen in.
 *   - renderMilestoneBrief: section assembly + embedded ids for preservation.
 *   - validateMilestonePreservation (recursive): every constituent story-brief
 *     hack/risk/open-assumption appears (deduped); a missing one fails.
 */

import { describe, expect, test } from 'bun:test';
import {
  type StoryBriefInput,
  buildMilestoneBrief,
  renderMilestoneBrief,
  validateMilestonePreservation,
} from './milestone-brief';
import type { LogEntry } from './reasoning-log';

// ---------------------------------------------------------------------------
// Entry fixture builders (mirror brief.test.ts)
// ---------------------------------------------------------------------------

function envelope(id: string, type: string, ts: string, body = `${type} ${id}`) {
  return { id, ts, type, agent: 'engineer', run_path: '/run', body };
}
function hack(id: string, ts: string): LogEntry {
  return {
    ...envelope(id, 'hack', ts),
    file_refs: ['x.ts'],
    cleanup_condition: 'later',
  } as LogEntry;
}
function risk(id: string, ts: string): LogEntry {
  return { ...envelope(id, 'risk', ts), severity: 'high', mitigation: 'watch it' } as LogEntry;
}
function assumption(id: string, ts: string, resolved: boolean): LogEntry {
  return {
    ...envelope(id, 'assumption', ts),
    resolved,
    resolution_ref: resolved ? 'r' : null,
  } as LogEntry;
}
function decision(id: string, ts: string, alternatives: string[]): LogEntry {
  return {
    ...envelope(id, 'decision', ts),
    alternatives,
    selected_rationale: 'a won',
  } as LogEntry;
}
function bailout(id: string, ts: string): LogEntry {
  return {
    ...envelope(id, 'bailout', ts),
    attempted: 'X',
    reason_abandoned: 'dead end',
  } as LogEntry;
}

// ---------------------------------------------------------------------------
// Story fixture builders
// ---------------------------------------------------------------------------

function shippedStory(
  storyId: string,
  title: string,
  entries: LogEntry[],
  outcome: string,
): StoryBriefInput {
  return {
    story_id: storyId,
    title,
    shipped: true,
    entries,
    outcome,
    terminal_reason: null,
    terminal_detail: null,
  };
}

function cancelledStory(
  storyId: string,
  title: string,
  entries: LogEntry[],
  reason: string,
  detail: string,
): StoryBriefInput {
  return {
    story_id: storyId,
    title,
    shipped: false,
    entries,
    outcome: '',
    terminal_reason: reason,
    terminal_detail: detail,
  };
}

// ===========================================================================
// buildMilestoneBrief — the four stakeholder sections
// ===========================================================================

describe('buildMilestoneBrief', () => {
  test('rolls up attention, outcomes, decisions, and what-did-not-ship', () => {
    const stories: StoryBriefInput[] = [
      shippedStory(
        's1',
        'Auth login',
        [
          decision('d1', '2026-06-01T00:00:00Z', ['oauth', 'sessions']),
          hack('h1', '2026-06-01T01:00:00Z'),
          risk('r1', '2026-06-01T02:00:00Z'),
        ],
        'login works',
      ),
      shippedStory(
        's2',
        'Token refresh',
        [assumption('a-open', '2026-06-01T03:00:00Z', false)],
        'refresh shipped',
      ),
      cancelledStory(
        's3',
        'Magic links',
        [risk('r-cut', '2026-06-01T04:00:00Z')],
        'cancelled',
        'descoped to next milestone',
      ),
    ];

    const brief = buildMilestoneBrief('auth-v1', stories);

    expect(brief.milestone_id).toBe('auth-v1');
    // Attention: hacks first, then risks (reverse-chron), then open assumptions.
    expect(brief.attention.map((a) => a.item.entry_id)).toEqual(['h1', 'r-cut', 'r1', 'a-open']);
    // Outcomes: only shipped stories, in story order.
    expect(brief.outcomes.map((o) => o.story_id)).toEqual(['s1', 's2']);
    expect(brief.outcomes[0]?.outcome).toBe('login works');
    // Decisions of record carried up with alternatives.
    expect(brief.decisions.map((d) => d.decision.entry_id)).toEqual(['d1']);
    expect(brief.decisions[0]?.decision.alternatives).toEqual(['oauth', 'sessions']);
    // What did not ship: the cancelled story with its reason + detail.
    expect(brief.did_not_ship.map((i) => i.story_id)).toEqual(['s3']);
    expect(brief.did_not_ship[0]?.reason).toBe('cancelled');
    expect(brief.did_not_ship[0]?.detail).toBe('descoped to next milestone');
  });

  test('attention attributes each item to the first story it was seen in', () => {
    const stories: StoryBriefInput[] = [
      shippedStory('s1', 'A', [hack('h1', '2026-06-01T01:00:00Z')], 'a'),
      shippedStory('s2', 'B', [risk('r1', '2026-06-01T02:00:00Z')], 'b'),
    ];
    const brief = buildMilestoneBrief('m', stories);
    const byId = new Map(brief.attention.map((a) => [a.item.entry_id, a.story_id]));
    expect(byId.get('h1')).toBe('s1');
    expect(byId.get('r1')).toBe('s2');
  });

  test('a hack shared across two stories is deduped to one attention item', () => {
    const shared = hack('h-shared', '2026-06-01T01:00:00Z');
    const stories: StoryBriefInput[] = [
      shippedStory('s1', 'A', [shared], 'a'),
      shippedStory('s2', 'B', [shared], 'b'),
    ];
    const brief = buildMilestoneBrief('m', stories);
    expect(brief.attention.filter((a) => a.item.entry_id === 'h-shared')).toHaveLength(1);
    expect(brief.attention[0]?.story_id).toBe('s1'); // first story wins
  });

  test('resolved assumptions are excluded; bailouts are not attention items', () => {
    const stories: StoryBriefInput[] = [
      shippedStory(
        's1',
        'A',
        [
          assumption('a-done', '2026-06-01T01:00:00Z', true),
          assumption('a-open', '2026-06-01T02:00:00Z', false),
          bailout('b1', '2026-06-01T03:00:00Z'),
        ],
        'a',
      ),
    ];
    const brief = buildMilestoneBrief('m', stories);
    expect(brief.attention.map((a) => a.item.entry_id)).toEqual(['a-open']);
  });

  test('empty milestone yields empty sections', () => {
    const brief = buildMilestoneBrief('m', []);
    expect(brief.attention).toEqual([]);
    expect(brief.outcomes).toEqual([]);
    expect(brief.decisions).toEqual([]);
    expect(brief.did_not_ship).toEqual([]);
  });
});

// ===========================================================================
// renderMilestoneBrief — markdown + embedded ids
// ===========================================================================

describe('renderMilestoneBrief', () => {
  test('renders all four sections with embedded ids and decision alternatives', () => {
    const stories: StoryBriefInput[] = [
      shippedStory(
        's1',
        'Auth login',
        [
          decision('d1', '2026-06-01T00:00:00Z', ['oauth', 'sessions']),
          hack('h1', '2026-06-01T01:00:00Z'),
        ],
        'login works',
      ),
      cancelledStory(
        's2',
        'Magic links',
        [risk('r-cut', '2026-06-01T02:00:00Z')],
        'cancelled',
        'descoped',
      ),
    ];
    const md = renderMilestoneBrief(buildMilestoneBrief('auth-v1', stories));

    for (const h of [
      '## 1. Needs your attention',
      '## 2. Outcomes shipped',
      '## 3. Decisions of record',
      '## 4. What did not ship',
    ]) {
      expect(md).toContain(h);
    }
    // Preservation: attention + decision ids embedded, alternatives verbatim.
    for (const id of ['h1', 'r-cut', 'd1']) expect(md).toContain(`(${id})`);
    expect(md).toContain('oauth');
    expect(md).toContain('sessions');
    // Outcomes + did-not-ship render their stories.
    expect(md).toContain('login works');
    expect(md).toContain('Magic links');
    expect(md).toContain('descoped');
  });

  test('empty brief renders all four sections with placeholders', () => {
    const md = renderMilestoneBrief(buildMilestoneBrief('m', []));
    expect(md).toContain('_None._');
    expect(md).toContain('_Nothing shipped._');
    expect(md).toContain('_Everything shipped._');
  });
});

// ===========================================================================
// validateMilestonePreservation — recursive preservation rule
// ===========================================================================

describe('validateMilestonePreservation', () => {
  function stories(): StoryBriefInput[] {
    return [
      shippedStory(
        's1',
        'A',
        [
          hack('h1', '2026-06-01T01:00:00Z'),
          decision('d1', '2026-06-01T00:00:00Z', ['alpha', 'beta']),
        ],
        'a',
      ),
      cancelledStory('s2', 'B', [risk('r-cut', '2026-06-01T02:00:00Z')], 'cancelled', 'descoped'),
    ];
  }

  test('PASSES when the rendered milestone brief carries every required item', () => {
    const s = stories();
    const md = renderMilestoneBrief(buildMilestoneBrief('m', s));
    const result = validateMilestonePreservation(md, s);
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.required).toBe(3); // h1 + r-cut + d1
  });

  test('FAILS listing every dropped constituent hack/risk/open-assumption', () => {
    const s = [
      shippedStory('s1', 'A', [hack('h1', '2026-06-01T01:00:00Z')], 'a'),
      cancelledStory('s2', 'B', [risk('r-cut', '2026-06-01T02:00:00Z')], 'cancelled', ''),
    ];
    const result = validateMilestonePreservation('mentions nothing relevant', s);
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['hack:h1', 'risk:r-cut']);
  });

  test('FAILS when a cancelled story drops a risk it raised before being cut', () => {
    const s = stories();
    // Build a brief, then strike the cancelled story's risk id from the text.
    const md = renderMilestoneBrief(buildMilestoneBrief('m', s)).replaceAll('r-cut', 'redacted');
    const result = validateMilestonePreservation(md, s);
    expect(result.ok).toBe(false);
    expect(result.missing).toContain('risk:r-cut');
  });

  test('FAILS when a decision alternative is dropped even if the id is present', () => {
    const s = [
      shippedStory('s1', 'A', [decision('d1', '2026-06-01T00:00:00Z', ['kept', 'dropped'])], 'a'),
    ];
    const result = validateMilestonePreservation('decision d1 considered kept', s);
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['decision-alternative:d1:"dropped"']);
  });

  test('a shared required item counts once across stories', () => {
    const shared = risk('r-shared', '2026-06-01T01:00:00Z');
    const s = [shippedStory('s1', 'A', [shared], 'a'), shippedStory('s2', 'B', [shared], 'b')];
    const md = renderMilestoneBrief(buildMilestoneBrief('m', s));
    const result = validateMilestonePreservation(md, s);
    expect(result.ok).toBe(true);
    expect(result.required).toBe(1);
  });
});
