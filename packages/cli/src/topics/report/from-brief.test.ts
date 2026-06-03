/**
 * Brief → report/v1 compiler tests. Every compiled document must validate
 * against the closed block model, and the brief's load-bearing content
 * (attention items + their tones, decisions, provenance) must survive the compile.
 */

import { describe, expect, test } from 'bun:test';
import type { ReviewBrief } from '../acb/brief';
import type { MilestoneBrief } from '../acb/milestone-brief';
import { validateReportDocument } from './blocks';
import { milestoneBriefToReportDocument, reviewBriefToReportDocument } from './from-brief';

function reviewBrief(overrides: Partial<ReviewBrief> = {}): ReviewBrief {
  return {
    summary: 'A summary',
    attention: [],
    decisions: [],
    changes: 'some changes',
    verifications: [],
    bailouts: [],
    provenance: [],
    ...overrides,
  };
}

describe('reviewBriefToReportDocument', () => {
  test('compiles a full brief into a valid report/v1 document', () => {
    const brief = reviewBrief({
      attention: [
        { kind: 'risk', entry_id: 'e1', ts: 't', agent: 'a', body: 'risky', detail: 'sev high' },
        { kind: 'hack', entry_id: 'e2', ts: 't', agent: 'a', body: 'hacky', detail: 'clean later' },
      ],
      decisions: [
        {
          entry_id: 'd1',
          ts: 't',
          agent: 'a',
          body: 'chose X',
          alternatives: ['Y', 'Z'],
          selected_rationale: 'X is simpler',
        },
      ],
      verifications: [
        { entry_id: 'v1', ts: 't', agent: 'a', body: 'tests pass', kind: 'verification' },
      ],
      bailouts: [
        {
          entry_id: 'b1',
          ts: 't',
          agent: 'a',
          body: '',
          attempted: 'tried W',
          reason_abandoned: 'too slow',
        },
      ],
      provenance: [{ decision_id: 'd1', closed_by_id: 'c1', entry_count: 4 }],
    });
    const doc = reviewBriefToReportDocument(brief);
    expect(validateReportDocument(doc)).toEqual([]);
    expect(doc.title).toBe('Review Brief');
  });

  test('maps attention kinds to tones (risk=danger, hack=warn, assumption=info)', () => {
    const doc = reviewBriefToReportDocument(
      reviewBrief({
        attention: [
          { kind: 'risk', entry_id: 'e1', ts: 't', agent: 'a', body: 'r', detail: '' },
          { kind: 'hack', entry_id: 'e2', ts: 't', agent: 'a', body: 'h', detail: '' },
          { kind: 'assumption', entry_id: 'e3', ts: 't', agent: 'a', body: 'a', detail: '' },
        ],
      }),
    );
    const section = doc.blocks.find(
      (b) => b.type === 'section' && b.title?.startsWith('Needs your attention'),
    );
    const tones =
      section?.type === 'section'
        ? section.blocks
            .filter((b) => b.type === 'callout')
            .map((b) => (b.type === 'callout' ? b.tone : ''))
        : [];
    expect(tones).toEqual(['danger', 'warn', 'info']);
  });

  test('an empty brief still validates and shows the empty-state placeholders', () => {
    const doc = reviewBriefToReportDocument(reviewBrief());
    expect(validateReportDocument(doc)).toEqual([]);
    // The optional verification/bailout sections are omitted when empty.
    const titles = doc.blocks.flatMap((b) => (b.type === 'section' && b.title ? [b.title] : []));
    expect(titles).toContain('Summary');
    expect(titles.some((t) => t.startsWith('Verifications'))).toBe(false);
  });
});

describe('milestoneBriefToReportDocument', () => {
  test('compiles a milestone brief into a valid report/v1 document with the milestone id in the title', () => {
    const mb: MilestoneBrief = {
      milestone_id: 'auth-v1',
      attention: [
        {
          story_id: 's1',
          item: { kind: 'risk', entry_id: 'e1', ts: 't', agent: 'a', body: 'r', detail: 'd' },
        },
      ],
      outcomes: [{ story_id: 's1', title: 'Login', outcome: 'shipped JWT' }],
      decisions: [
        {
          story_id: 's1',
          decision: {
            entry_id: 'd1',
            ts: 't',
            agent: 'a',
            body: 'chose JWT',
            alternatives: ['sessions'],
            selected_rationale: 'stateless',
          },
        },
      ],
      did_not_ship: [
        { story_id: 's2', title: 'SSO', reason: 'descoped', detail: 'next milestone' },
      ],
    };
    const doc = milestoneBriefToReportDocument(mb);
    expect(validateReportDocument(doc)).toEqual([]);
    expect(doc.title).toBe('Milestone Brief: auth-v1');
  });

  test('prefixes attention callouts with the originating story id', () => {
    const mb: MilestoneBrief = {
      milestone_id: 'm',
      attention: [
        {
          story_id: 'story-42',
          item: { kind: 'hack', entry_id: 'e1', ts: 't', agent: 'a', body: 'b', detail: '' },
        },
      ],
      outcomes: [],
      decisions: [],
      did_not_ship: [],
    };
    const doc = milestoneBriefToReportDocument(mb);
    const section = doc.blocks.find(
      (b) => b.type === 'section' && b.title?.startsWith('Needs your attention'),
    );
    const title =
      section?.type === 'section' && section.blocks[0]?.type === 'callout'
        ? section.blocks[0].title
        : '';
    expect(title).toContain('[story-42]');
  });
});
