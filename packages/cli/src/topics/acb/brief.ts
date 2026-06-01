/**
 * Review Brief — the 7-section risk-forward brief synthesized from a run's
 * reasoning log (onleash 09 §10.5–10.6, audit §5.1). This module owns the
 * MECHANICAL half: the section model, the preservation-critical attention
 * ordering, the episode chunker for multipass synthesis, and the renderer.
 *
 * The PROSE of the two narrative sections (summary, changes) is the skill's
 * judgment (`skills/reasoning-brief`, ADR0015 classes brief synthesis as
 * Claude-owned). `buildBrief` seeds those from synthesis-entry outcomes so a
 * mechanical brief is always complete and preservation-safe even before the
 * skill refines it — the skill rewrites `summary`/`changes`, never the
 * attention/decision/bailout sections.
 *
 * Preservation rule (audit §5.1): a brief must never drop an attention-bearing
 * item — every `hack`, `risk`, `bailout`, open `assumption`, and every
 * `decision`'s `alternatives`. `renderBrief` embeds each such entry's id so the
 * Stage-1 validator (`brief-validate.ts`) can mechanically prove preservation
 * against the source log.
 */

import type { Episode, LogEntry } from './reasoning-log';

// ---------------------------------------------------------------------------
// Section model — the 7 risk-forward sections, in render order
// ---------------------------------------------------------------------------

/**
 * The 7 brief sections in render order. `attention` (§2) is risk-forward — it
 * sits second, directly under the summary, so the reader sees what needs their
 * attention before the narrative.
 */
export const BRIEF_SECTIONS = [
  'summary',
  'attention',
  'decisions',
  'changes',
  'verifications',
  'bailouts',
  'provenance',
] as const;
export type BriefSection = (typeof BRIEF_SECTIONS)[number];

/** The three attention-bearing kinds §2 surfaces, in fixed precedence order. */
export type AttentionKind = 'hack' | 'risk' | 'assumption';

const ATTENTION_PRECEDENCE: Record<AttentionKind, number> = { hack: 0, risk: 1, assumption: 2 };

/** One §2 "Needs your attention" item. `detail` carries the kind-specific tail. */
export interface AttentionItem {
  kind: AttentionKind;
  entry_id: string;
  ts: string;
  agent: string;
  body: string;
  /** hack → cleanup condition; risk → severity + mitigation; assumption → "open". */
  detail: string;
}

/** §3 decision of record. `alternatives` are preservation-critical. */
export interface BriefDecision {
  entry_id: string;
  ts: string;
  agent: string;
  body: string;
  alternatives: string[];
  selected_rationale: string;
}

/** §5 verification / review-feedback entry. */
export interface BriefVerification {
  entry_id: string;
  ts: string;
  agent: string;
  body: string;
  kind: 'verification' | 'review_feedback';
}

/** §6 abandoned path — preserved so future work does not retry a dead end. */
export interface BriefBailout {
  entry_id: string;
  ts: string;
  agent: string;
  body: string;
  attempted: string;
  reason_abandoned: string;
}

/** §7 provenance — one row per derived episode. */
export interface BriefEpisode {
  decision_id: string;
  closed_by_id: string | null;
  entry_count: number;
}

/** The full 7-section brief. `summary`/`changes` are prose; the rest are typed. */
export interface ReviewBrief {
  summary: string;
  attention: AttentionItem[];
  decisions: BriefDecision[];
  changes: string;
  verifications: BriefVerification[];
  bailouts: BriefBailout[];
  provenance: BriefEpisode[];
}

// ---------------------------------------------------------------------------
// deriveAttentionItems — §2, mechanical and preservation-critical
// ---------------------------------------------------------------------------

/**
 * Collect the §2 attention items from a log: every `hack` and `risk`, plus
 * UNRESOLVED `assumption`s (a resolved assumption is a settled fact, not a
 * standing concern — excluded). Ordered by fixed precedence `hack > risk >
 * assumption`, then reverse-chronological within a kind (newest first) so the
 * most recent concern in each band reads first.
 */
export function deriveAttentionItems(entries: LogEntry[]): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const e of entries) {
    if (e.type === 'hack') {
      items.push(item('hack', e, `cleanup: ${e.cleanup_condition}`));
    } else if (e.type === 'risk') {
      items.push(item('risk', e, `severity: ${e.severity}; mitigation: ${e.mitigation}`));
    } else if (e.type === 'assumption' && !e.resolved) {
      items.push(item('assumption', e, 'open'));
    }
  }
  items.sort((a, b) => {
    const byKind = ATTENTION_PRECEDENCE[a.kind] - ATTENTION_PRECEDENCE[b.kind];
    if (byKind !== 0) return byKind;
    // Reverse-chronological within a kind; entry id as a stable DESC tiebreak.
    return a.ts === b.ts ? cmpDesc(a.entry_id, b.entry_id) : cmpDesc(a.ts, b.ts);
  });
  return items;
}

function item(kind: AttentionKind, e: LogEntry, detail: string): AttentionItem {
  return { kind, entry_id: e.id, ts: e.ts, agent: e.agent, body: e.body, detail };
}

// ---------------------------------------------------------------------------
// buildBrief — assemble a complete, preservation-safe brief from the log
// ---------------------------------------------------------------------------

/**
 * Assemble a full `ReviewBrief` mechanically from a run's entries + derived
 * episodes. The typed sections (attention/decisions/verifications/bailouts/
 * provenance) are final; `summary`/`changes` are seeded from `synthesis`
 * outcomes/bodies as a starting point the skill rewrites into prose.
 */
export function buildBrief(entries: LogEntry[], episodes: Episode[]): ReviewBrief {
  const decisions: BriefDecision[] = [];
  const verifications: BriefVerification[] = [];
  const bailouts: BriefBailout[] = [];
  const synthesisOutcomes: string[] = [];
  const synthesisBodies: string[] = [];

  for (const e of entries) {
    if (e.type === 'decision') {
      decisions.push({
        entry_id: e.id,
        ts: e.ts,
        agent: e.agent,
        body: e.body,
        alternatives: e.alternatives,
        selected_rationale: e.selected_rationale,
      });
    } else if (e.type === 'verification' || e.type === 'review_feedback') {
      verifications.push({ entry_id: e.id, ts: e.ts, agent: e.agent, body: e.body, kind: e.type });
    } else if (e.type === 'bailout') {
      bailouts.push({
        entry_id: e.id,
        ts: e.ts,
        agent: e.agent,
        body: e.body,
        attempted: e.attempted,
        reason_abandoned: e.reason_abandoned,
      });
    } else if (e.type === 'synthesis') {
      synthesisOutcomes.push(e.outcome);
      synthesisBodies.push(e.body);
    }
  }

  const attention = deriveAttentionItems(entries);
  const provenance: BriefEpisode[] = episodes.map((ep) => ({
    decision_id: ep.decision.id,
    closed_by_id: ep.closed_by?.id ?? null,
    entry_count: ep.entries.length,
  }));

  return {
    summary:
      synthesisOutcomes.length > 0
        ? synthesisOutcomes.join('; ')
        : `${decisions.length} decision(s), ${attention.length} attention item(s) across ${episodes.length} episode(s).`,
    attention,
    decisions,
    changes: synthesisBodies.length > 0 ? synthesisBodies.join('\n\n') : '(no synthesis recorded)',
    verifications,
    bailouts,
    provenance,
  };
}

// ---------------------------------------------------------------------------
// chunkEpisodes — multipass partitioning input
// ---------------------------------------------------------------------------

/**
 * Partition `episodes` into consecutive chunks each under `tokenBudget`,
 * preserving order and NEVER splitting or dropping an episode. A single
 * episode larger than the budget lands alone in its own (over-budget) chunk —
 * it cannot be split, but it is never lost. Flattening the result always
 * reproduces the input list exactly. The chunks feed the skill's multipass
 * episode-chunk → fragment → merge synthesis.
 */
export function chunkEpisodes(episodes: Episode[], tokenBudget: number): Episode[][] {
  const chunks: Episode[][] = [];
  let current: Episode[] = [];
  let currentTokens = 0;

  for (const episode of episodes) {
    const size = estimateEpisodeTokens(episode);
    if (current.length > 0 && currentTokens + size > tokenBudget) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(episode);
    currentTokens += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Cheap deterministic token estimate for an episode: ~4 chars/token over every
 * body it carries (the decision opener, attached entries, and closer). A
 * heuristic, not a BPE pass — good enough to bound chunk size for synthesis.
 */
function estimateEpisodeTokens(episode: Episode): number {
  let chars = episode.decision.body.length;
  for (const entry of episode.entries) chars += entry.body.length;
  if (episode.closed_by) chars += episode.closed_by.body.length;
  return Math.ceil(chars / 4);
}

// ---------------------------------------------------------------------------
// renderBrief — deterministic markdown with embedded ids for preservation
// ---------------------------------------------------------------------------

/**
 * Render a `ReviewBrief` to markdown. Every attention item, decision, and
 * bailout embeds its entry id as a `` `(id)` `` tag, and decisions render each
 * alternative verbatim — this is the contract `brief-validate.ts` relies on to
 * prove the preservation rule mechanically.
 */
export function renderBrief(brief: ReviewBrief): string {
  const out: string[] = [];

  out.push('# Review Brief', '');
  out.push('## 1. Summary', '', brief.summary, '');

  out.push('## 2. Needs your attention', '');
  if (brief.attention.length === 0) {
    out.push('_None._', '');
  } else {
    for (const a of brief.attention) {
      out.push(`- **[${a.kind}]** ${a.body} — _${a.detail}_ \`(${a.entry_id})\``);
    }
    out.push('');
  }

  out.push('## 3. Decisions', '');
  if (brief.decisions.length === 0) {
    out.push('_None._', '');
  } else {
    for (const d of brief.decisions) {
      out.push(`- ${d.body} \`(${d.entry_id})\``);
      for (const alt of d.alternatives) out.push(`  - alternative: ${alt}`);
      out.push(`  - selected: ${d.selected_rationale}`);
    }
    out.push('');
  }

  out.push('## 4. Changes', '', brief.changes, '');

  out.push('## 5. Verifications', '');
  if (brief.verifications.length === 0) {
    out.push('_None._', '');
  } else {
    for (const v of brief.verifications) {
      out.push(`- **[${v.kind}]** ${v.body} \`(${v.entry_id})\``);
    }
    out.push('');
  }

  out.push('## 6. Abandoned paths', '');
  if (brief.bailouts.length === 0) {
    out.push('_None._', '');
  } else {
    for (const b of brief.bailouts) {
      out.push(`- ${b.body} \`(${b.entry_id})\``);
      out.push(`  - attempted: ${b.attempted}`);
      out.push(`  - abandoned because: ${b.reason_abandoned}`);
    }
    out.push('');
  }

  out.push('## 7. Provenance', '');
  if (brief.provenance.length === 0) {
    out.push('_No episodes._', '');
  } else {
    for (const p of brief.provenance) {
      const closer = p.closed_by_id ? `closed by ${p.closed_by_id}` : 'open';
      out.push(`- episode ${p.decision_id}: ${p.entry_count} entr(ies), ${closer}`);
    }
    out.push('');
  }

  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Descending string compare (newest/largest first). */
function cmpDesc(a: string, b: string): number {
  return a > b ? -1 : a < b ? 1 : 0;
}
