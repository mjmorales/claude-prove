/**
 * Milestone Brief — the stakeholder-facing rollup synthesized when a milestone
 * closes. It is the milestone-level analogue of the per-story Review Brief: a
 * Review Brief reports one story's run; a Milestone Brief deduplicates and rolls
 * up every constituent story's brief into one surface an operator reads to
 * judge the whole milestone.
 *
 * This module owns the MECHANICAL half — the section model, the cross-story
 * dedup, and the renderer. It composes the per-story brief primitives rather
 * than re-deriving them: each constituent story is reduced to its attention
 * items (the `hack`/`risk`/open-`assumption` set from `deriveAttentionItems`)
 * plus its decisions and shipped outcome. The PROSE of any narrative tail is the
 * synthesizer skill's judgment; the four stakeholder sections below are
 * mechanical and preservation-safe by construction.
 *
 * The four stakeholder sections, in render order:
 *   1. Needs your attention — deduped hacks/risks/open-assumptions across stories
 *   2. Outcomes shipped     — one row per story that shipped, with its outcome
 *   3. Decisions of record  — every decision carried up, with alternatives
 *   4. What did not ship     — cancelled/superseded stories, with their reasons
 *
 * Recursive preservation rule: every attention-bearing item present in any
 * constituent story brief MUST appear (deduped by entry id) in the milestone
 * brief. `renderMilestoneBrief` embeds each item's entry id so the validator
 * (`milestone-brief-validate` below) can prove preservation mechanically, the
 * same way the per-story brief proves it against its source log.
 */

import { type AttentionItem, type BriefDecision, deriveAttentionItems } from './brief';
import type { LogEntry } from './reasoning-log';

// ---------------------------------------------------------------------------
// Section model — the 4 stakeholder sections, in render order
// ---------------------------------------------------------------------------

/** The 4 milestone-brief sections in render order. Attention sits first. */
export const MILESTONE_BRIEF_SECTIONS = [
  'attention',
  'outcomes',
  'decisions',
  'did_not_ship',
] as const;
export type MilestoneBriefSection = (typeof MILESTONE_BRIEF_SECTIONS)[number];

/**
 * One constituent story fed into the milestone rollup. A story that shipped
 * carries its reasoning-log `entries` (the source for attention items and
 * decisions) and an `outcome` line. A story that did not ship carries a
 * `terminal_reason`/`terminal_detail` instead — its entries are still read so a
 * cancelled story never silently drops a risk it raised before it was cut.
 */
export interface StoryBriefInput {
  /** Scrum task id of the story. */
  story_id: string;
  /** Human-readable story title for the stakeholder rows. */
  title: string;
  /** Whether the story reached `done` (shipped) or a terminal non-done state. */
  shipped: boolean;
  /** The story's reasoning-log entries — the source of attention + decisions. */
  entries: LogEntry[];
  /** One-line shipped outcome (from the story's `synthesis`); empty when none. */
  outcome: string;
  /** Coarse cause a non-shipped story ended (`cancelled`/`parent_cancelled`). */
  terminal_reason: string | null;
  /** Free-text elaboration recorded at cancel time. */
  terminal_detail: string | null;
}

/**
 * One deduped "Needs your attention" item rolled up across stories. Carries the
 * originating story id so a stakeholder can trace each concern back to its
 * story, and the source `AttentionItem` so the kind/body/detail render verbatim.
 */
export interface MilestoneAttentionItem {
  /** Story the item was first seen in (the dedup winner). */
  story_id: string;
  item: AttentionItem;
}

/** One "Outcomes shipped" row — a story that reached `done`. */
export interface MilestoneOutcome {
  story_id: string;
  title: string;
  /** The story's shipped outcome line; falls back to a placeholder when empty. */
  outcome: string;
}

/** One decision of record carried up from a story, with its originating story. */
export interface MilestoneDecisionOfRecord {
  story_id: string;
  decision: BriefDecision;
}

/** One "What did not ship" row — a cancelled/superseded story, with its reason. */
export interface DidNotShipItem {
  story_id: string;
  title: string;
  /** Coarse cause; never empty — defaults to `'unknown'` when none recorded. */
  reason: string;
  /** Free-text elaboration; empty when none was recorded. */
  detail: string;
}

/** The full 4-section milestone brief. All sections are typed and mechanical. */
export interface MilestoneBrief {
  milestone_id: string;
  attention: MilestoneAttentionItem[];
  outcomes: MilestoneOutcome[];
  decisions: MilestoneDecisionOfRecord[];
  did_not_ship: DidNotShipItem[];
}

// ---------------------------------------------------------------------------
// buildMilestoneBrief — assemble the rollup mechanically from the stories
// ---------------------------------------------------------------------------

/**
 * Roll the constituent `stories` up into one milestone brief through four named
 * steps: dedupe attention across stories, collect shipped outcomes, carry up
 * decisions of record, and list what did not ship. Pure: no IO. The result is
 * preservation-safe by construction — every attention item from every story
 * survives into `attention` (deduped by entry id).
 */
export function buildMilestoneBrief(
  milestoneId: string,
  stories: StoryBriefInput[],
): MilestoneBrief {
  const attention = dedupeAttention(stories);
  const outcomes = collectOutcomes(stories);
  const decisions = collectDecisionsOfRecord(stories);
  const did_not_ship = collectDidNotShip(stories);

  return { milestone_id: milestoneId, attention, outcomes, decisions, did_not_ship };
}

/**
 * Collect every story's attention items (hack/risk/open-assumption), deduped by
 * entry id across stories — the same entry id surfacing through two stories
 * (e.g. a shared risk) appears once, attributed to the first story it was seen
 * in. Order follows the per-story attention precedence (hack > risk >
 * assumption, reverse-chronological within a kind) applied across the combined
 * set, so the most pressing concerns read first regardless of which story
 * raised them.
 */
function dedupeAttention(stories: StoryBriefInput[]): MilestoneAttentionItem[] {
  const ownerByEntryId = new Map<string, string>();
  const combined: LogEntry[] = [];

  for (const story of stories) {
    for (const entry of story.entries) {
      if (ownerByEntryId.has(entry.id)) continue;
      ownerByEntryId.set(entry.id, story.story_id);
      combined.push(entry);
    }
  }

  return deriveAttentionItems(combined).map((item) => ({
    story_id: ownerByEntryId.get(item.entry_id) ?? '',
    item,
  }));
}

/** One outcome row per shipped story, in story order. */
function collectOutcomes(stories: StoryBriefInput[]): MilestoneOutcome[] {
  const outcomes: MilestoneOutcome[] = [];
  for (const story of stories) {
    if (!story.shipped) continue;
    outcomes.push({
      story_id: story.story_id,
      title: story.title,
      outcome: story.outcome,
    });
  }
  return outcomes;
}

/**
 * Carry up every decision of record from every story, deduped by entry id (a
 * decision shared across stories is recorded once). A decision is read from its
 * `decision` log entry; its alternatives ride along so the renderer can embed
 * them verbatim, preserving the per-story brief's decision-alternative contract.
 */
function collectDecisionsOfRecord(stories: StoryBriefInput[]): MilestoneDecisionOfRecord[] {
  const seen = new Set<string>();
  const decisions: MilestoneDecisionOfRecord[] = [];

  for (const story of stories) {
    for (const entry of story.entries) {
      if (entry.type !== 'decision') continue;
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      decisions.push({
        story_id: story.story_id,
        decision: {
          entry_id: entry.id,
          ts: entry.ts,
          agent: entry.agent,
          body: entry.body,
          alternatives: entry.alternatives,
          selected_rationale: entry.selected_rationale,
        },
      });
    }
  }

  return decisions;
}

/** One row per story that did not ship, carrying its recorded terminal reason. */
function collectDidNotShip(stories: StoryBriefInput[]): DidNotShipItem[] {
  const items: DidNotShipItem[] = [];
  for (const story of stories) {
    if (story.shipped) continue;
    items.push({
      story_id: story.story_id,
      title: story.title,
      reason: story.terminal_reason ?? 'unknown',
      detail: story.terminal_detail ?? '',
    });
  }
  return items;
}

// ---------------------------------------------------------------------------
// renderMilestoneBrief — deterministic markdown with embedded ids
// ---------------------------------------------------------------------------

/**
 * Render a `MilestoneBrief` to markdown. Every attention item and decision
 * embeds its entry id as a `` `(id)` `` tag, and decisions render each
 * alternative verbatim — this is the contract the validator relies on to prove
 * the recursive preservation rule mechanically.
 */
export function renderMilestoneBrief(brief: MilestoneBrief): string {
  const out: string[] = [];

  out.push('# Milestone Brief', '', `Milestone: ${brief.milestone_id}`, '');

  out.push('## 1. Needs your attention', '');
  if (brief.attention.length === 0) {
    out.push('_None._', '');
  } else {
    for (const a of brief.attention) {
      out.push(
        `- **[${a.item.kind}]** ${a.item.body} — _${a.item.detail}_ \`(${a.item.entry_id})\` (story ${a.story_id})`,
      );
    }
    out.push('');
  }

  out.push('## 2. Outcomes shipped', '');
  if (brief.outcomes.length === 0) {
    out.push('_Nothing shipped._', '');
  } else {
    for (const o of brief.outcomes) {
      const outcome = o.outcome.length > 0 ? o.outcome : '(no outcome recorded)';
      out.push(`- **${o.title}** (story ${o.story_id}): ${outcome}`);
    }
    out.push('');
  }

  out.push('## 3. Decisions of record', '');
  if (brief.decisions.length === 0) {
    out.push('_None._', '');
  } else {
    for (const d of brief.decisions) {
      out.push(`- ${d.decision.body} \`(${d.decision.entry_id})\` (story ${d.story_id})`);
      for (const alt of d.decision.alternatives) out.push(`  - alternative: ${alt}`);
      out.push(`  - selected: ${d.decision.selected_rationale}`);
    }
    out.push('');
  }

  out.push('## 4. What did not ship', '');
  if (brief.did_not_ship.length === 0) {
    out.push('_Everything shipped._', '');
  } else {
    for (const item of brief.did_not_ship) {
      const detail = item.detail.length > 0 ? ` — ${item.detail}` : '';
      out.push(`- **${item.title}** (story ${item.story_id}): ${item.reason}${detail}`);
    }
    out.push('');
  }

  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Recursive preservation validator — proves no story's concern was dropped
// ---------------------------------------------------------------------------

export interface MilestonePreservationResult {
  ok: boolean;
  /** Human-readable ref per dropped item (`<kind>:<id>` / `decision-alternative:<id>:"…"`). Empty when ok. */
  missing: string[];
  /** Number of attention-bearing items (deduped across stories) required. */
  required: number;
}

/**
 * Prove `briefText` preserves every attention-bearing item from every
 * constituent story — the recursive preservation rule. An item is required when
 * it is a `hack`/`risk` or an UNRESOLVED `assumption` in any story, plus every
 * `decision` carrying alternatives. Items are deduped by entry id across
 * stories so a shared concern counts once. For a decision, both the id and
 * every alternative string must appear. Returns `ok: false` plus the flat
 * `missing` list on any drop — the CLI maps that to exit 1 + the list on
 * stderr, the same shape the per-story validator returns.
 */
export function validateMilestonePreservation(
  briefText: string,
  stories: StoryBriefInput[],
): MilestonePreservationResult {
  const missing: string[] = [];
  const seen = new Set<string>();
  let required = 0;

  for (const story of stories) {
    for (const e of story.entries) {
      if (seen.has(e.id)) continue;

      if (e.type === 'hack' || e.type === 'risk') {
        seen.add(e.id);
        required++;
        if (!briefText.includes(e.id)) missing.push(`${e.type}:${e.id}`);
      } else if (e.type === 'assumption' && !e.resolved) {
        seen.add(e.id);
        required++;
        if (!briefText.includes(e.id)) missing.push(`open-assumption:${e.id}`);
      } else if (e.type === 'decision' && e.alternatives.length > 0) {
        seen.add(e.id);
        required++;
        if (!briefText.includes(e.id)) missing.push(`decision:${e.id}`);
        for (const alt of e.alternatives) {
          if (!briefText.includes(alt)) missing.push(`decision-alternative:${e.id}:"${alt}"`);
        }
      }
    }
  }

  return { ok: missing.length === 0, missing, required };
}
