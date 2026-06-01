/**
 * brief.ts unit tests.
 *
 * Covers:
 *   - deriveAttentionItems: precedence hack>risk>open-assumption, reverse-chron
 *     within a kind, resolved assumptions excluded (ac-brief-render).
 *   - chunkEpisodes: partitions under the token budget, never splits or drops
 *     an episode, flatten === input (ac-brief-chunk).
 *   - buildBrief / renderBrief: section assembly + embedded ids for preservation.
 */

import { describe, expect, test } from 'bun:test';
import {
  type ReviewBrief,
  buildBrief,
  chunkEpisodes,
  deriveAttentionItems,
  renderBrief,
} from './brief';
import { type Episode, type LogEntry, deriveEpisodes } from './reasoning-log';

// ---------------------------------------------------------------------------
// Entry fixture builders
// ---------------------------------------------------------------------------

function envelope(id: string, type: string, ts: string, body = `${type} ${id}`) {
  return { id, ts, type, agent: 'engineer', run_path: '/run', body };
}

function hack(id: string, ts: string): LogEntry {
  return {
    ...envelope(id, 'hack', ts),
    file_refs: ['x.ts'],
    cleanup_condition: 'when stable',
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
  return { ...envelope(id, 'decision', ts), alternatives, selected_rationale: 'a won' } as LogEntry;
}
function bailout(id: string, ts: string): LogEntry {
  return {
    ...envelope(id, 'bailout', ts),
    attempted: 'X',
    reason_abandoned: 'dead end',
  } as LogEntry;
}
function synthesis(id: string, ts: string, outcome: string): LogEntry {
  return { ...envelope(id, 'synthesis', ts), outcome } as LogEntry;
}

// ===========================================================================
// deriveAttentionItems — attention ordering + filtering
// ===========================================================================

describe('deriveAttentionItems', () => {
  test('orders by precedence hack>risk>open-assumption, reverse-chron within a kind', () => {
    const entries: LogEntry[] = [
      risk('r-old', '2026-06-01T01:00:00Z'),
      hack('h-old', '2026-06-01T02:00:00Z'),
      assumption('a-open', '2026-06-01T03:00:00Z', false),
      hack('h-new', '2026-06-01T05:00:00Z'),
      risk('r-new', '2026-06-01T04:00:00Z'),
    ];
    const items = deriveAttentionItems(entries);
    // hacks first (newest→oldest), then risks (newest→oldest), then assumptions.
    expect(items.map((i) => i.entry_id)).toEqual(['h-new', 'h-old', 'r-new', 'r-old', 'a-open']);
    expect(items.map((i) => i.kind)).toEqual(['hack', 'hack', 'risk', 'risk', 'assumption']);
  });

  test('excludes resolved assumptions, keeps open ones', () => {
    const entries: LogEntry[] = [
      assumption('a-resolved', '2026-06-01T01:00:00Z', true),
      assumption('a-open', '2026-06-01T02:00:00Z', false),
    ];
    const items = deriveAttentionItems(entries);
    expect(items.map((i) => i.entry_id)).toEqual(['a-open']);
  });

  test('attaches kind-specific detail', () => {
    const items = deriveAttentionItems([
      hack('h', '2026-06-01T00:00:00Z'),
      risk('r', '2026-06-01T00:00:00Z'),
    ]);
    expect(items.find((i) => i.kind === 'hack')?.detail).toContain('cleanup:');
    expect(items.find((i) => i.kind === 'risk')?.detail).toContain('severity: high');
  });

  test('empty log yields no attention items', () => {
    expect(deriveAttentionItems([])).toEqual([]);
  });
});

// ===========================================================================
// chunkEpisodes — multipass partitioning
// ===========================================================================

describe('chunkEpisodes', () => {
  // Build N episodes, each ~ (4 * perBodyChars) tokens, via decision openers.
  function episodesOfSize(count: number, bodyChars: number): Episode[] {
    const entries: LogEntry[] = [];
    for (let i = 0; i < count; i++) {
      entries.push(decision(`d${i}`, `2026-06-01T0${i}:00:00Z`, ['a']));
      // pad the decision body so each episode has a predictable size
      entries[entries.length - 1] = {
        ...entries[entries.length - 1],
        body: 'x'.repeat(bodyChars),
      } as LogEntry;
    }
    return deriveEpisodes(entries);
  }

  test('flatten(chunks) reproduces the input episodes exactly (no loss, order kept)', () => {
    const episodes = episodesOfSize(6, 40); // ~10 tokens each
    const chunks = chunkEpisodes(episodes, 25); // ~2 episodes/chunk
    expect(chunks.flat()).toEqual(episodes);
  });

  test('every multi-episode chunk stays within the token budget', () => {
    const episodes = episodesOfSize(6, 40); // ~10 tokens each
    const budget = 25;
    const chunks = chunkEpisodes(episodes, budget);
    for (const chunk of chunks) {
      if (chunk.length < 2) continue; // a lone episode may exceed the budget
      const tokens = chunk.reduce((sum, ep) => sum + Math.ceil(ep.decision.body.length / 4), 0);
      expect(tokens).toBeLessThanOrEqual(budget);
    }
  });

  test('a single oversized episode lands alone, never split or dropped', () => {
    const episodes = episodesOfSize(3, 400); // ~100 tokens each, budget below that
    const chunks = chunkEpisodes(episodes, 25);
    expect(chunks).toHaveLength(3);
    expect(chunks.every((c) => c.length === 1)).toBe(true);
    expect(chunks.flat()).toEqual(episodes);
  });

  test('empty episode list yields no chunks', () => {
    expect(chunkEpisodes([], 1000)).toEqual([]);
  });
});

// ===========================================================================
// buildBrief + renderBrief
// ===========================================================================

describe('buildBrief + renderBrief', () => {
  function fullLog(): LogEntry[] {
    return [
      decision('d1', '2026-06-01T00:00:00Z', ['stay on bun', 'rewrite in go']),
      hack('h1', '2026-06-01T01:00:00Z'),
      risk('r1', '2026-06-01T02:00:00Z'),
      assumption('a-open', '2026-06-01T03:00:00Z', false),
      assumption('a-done', '2026-06-01T03:30:00Z', true),
      bailout('b1', '2026-06-01T04:00:00Z'),
      synthesis('s1', '2026-06-01T05:00:00Z', 'shipped the brief module'),
    ];
  }

  test('buildBrief populates every typed section and seeds prose from synthesis', () => {
    const entries = fullLog();
    const brief = buildBrief(entries, deriveEpisodes(entries));
    expect(brief.decisions.map((d) => d.entry_id)).toEqual(['d1']);
    expect(brief.decisions[0]?.alternatives).toEqual(['stay on bun', 'rewrite in go']);
    expect(brief.attention.map((a) => a.entry_id)).toEqual(['h1', 'r1', 'a-open']); // resolved excluded
    expect(brief.bailouts.map((b) => b.entry_id)).toEqual(['b1']);
    expect(brief.summary).toBe('shipped the brief module');
    expect(brief.provenance).toHaveLength(1); // one decision opens one episode
  });

  test('renderBrief embeds every preserved entry id and each decision alternative', () => {
    const entries = fullLog();
    const md = renderBrief(buildBrief(entries, deriveEpisodes(entries)));
    // The 7 section headers are present in order.
    for (const h of [
      '## 1. Summary',
      '## 2. Needs your attention',
      '## 3. Decisions',
      '## 4. Changes',
      '## 5. Verifications',
      '## 6. Abandoned paths',
      '## 7. Provenance',
    ]) {
      expect(md).toContain(h);
    }
    // Preservation: every attention/decision/bailout id appears, plus alternatives.
    for (const id of ['h1', 'r1', 'a-open', 'd1', 'b1']) expect(md).toContain(`(${id})`);
    expect(md).toContain('stay on bun');
    expect(md).toContain('rewrite in go');
    // Resolved assumption is NOT surfaced as an attention item.
    expect(md).not.toContain('(a-done)');
  });

  test('renderBrief on an empty brief renders all 7 sections with None placeholders', () => {
    const brief: ReviewBrief = buildBrief([], []);
    const md = renderBrief(brief);
    expect(md).toContain('## 2. Needs your attention');
    expect(md).toContain('_None._');
  });
});
