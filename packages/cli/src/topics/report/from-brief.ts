/**
 * Compile a Review Brief / Milestone Brief into a report/v1 `ReportDocument`.
 * Mechanical: brief JSON in, blocks out — no synthesis, no markup. The report
 * renderer (`render.ts`) turns the document into self-contained HTML, so a brief
 * gets an HTML view beside its markdown with zero bespoke templating.
 *
 * The two brief shapes are imported from the acb topic (the single source of
 * truth for the brief models); this module only maps their fields to blocks.
 */

import type { AttentionItem, BriefDecision, ReviewBrief } from '../acb/brief';
import type { MilestoneBrief } from '../acb/milestone-brief';
import type { Block, ReportDocument, Tone } from './blocks';

/** Attention kind → callout tone. A hack wants cleanup; a risk is the loudest. */
function attentionTone(kind: AttentionItem['kind']): Tone {
  switch (kind) {
    case 'risk':
      return 'danger';
    case 'hack':
      return 'warn';
    case 'assumption':
      return 'info';
  }
}

/** One attention item → a toned callout (kind + detail surfaced). */
function attentionCallout(item: AttentionItem): Block {
  const detail = item.detail ? `\n${item.detail}` : '';
  return {
    type: 'callout',
    tone: attentionTone(item.kind),
    title: `${item.kind} — ${item.agent}`,
    body: `${item.body}${detail}`,
  };
}

/** One decision-of-record → a callout (rationale) + its alternatives list. */
function decisionBlocks(decision: BriefDecision): Block[] {
  const blocks: Block[] = [
    {
      type: 'callout',
      tone: 'neutral',
      title: decision.body,
      body: decision.selected_rationale
        ? `Rationale: ${decision.selected_rationale}`
        : 'Rationale: (none recorded)',
    },
  ];
  if (decision.alternatives.length > 0) {
    blocks.push({ type: 'list', ordered: false, items: decision.alternatives });
  }
  return blocks;
}

/** Compile a Review Brief into a report/v1 document (7 sections, render order). */
export function reviewBriefToReportDocument(brief: ReviewBrief): ReportDocument {
  const blocks: Block[] = [];

  blocks.push({
    type: 'section',
    title: 'Summary',
    blocks: [{ type: 'paragraph', text: brief.summary || '(no summary)' }],
  });

  blocks.push({
    type: 'section',
    title: `Needs your attention (${brief.attention.length})`,
    blocks:
      brief.attention.length > 0
        ? brief.attention.map(attentionCallout)
        : [{ type: 'paragraph', text: 'Nothing flagged.' }],
  });

  blocks.push({
    type: 'section',
    title: `Decisions (${brief.decisions.length})`,
    blocks:
      brief.decisions.length > 0
        ? brief.decisions.flatMap(decisionBlocks)
        : [{ type: 'paragraph', text: 'No decisions of record.' }],
  });

  blocks.push({
    type: 'section',
    title: 'Changes',
    blocks: [{ type: 'paragraph', text: brief.changes || '(none)' }],
  });

  if (brief.verifications.length > 0) {
    blocks.push({
      type: 'section',
      title: `Verifications (${brief.verifications.length})`,
      blocks: [
        {
          type: 'list',
          ordered: false,
          items: brief.verifications.map((v) => `${v.kind}: ${v.body}`),
        },
      ],
    });
  }

  if (brief.bailouts.length > 0) {
    blocks.push({
      type: 'section',
      title: `Bailouts (${brief.bailouts.length})`,
      blocks: brief.bailouts.map(
        (b): Block => ({
          type: 'callout',
          tone: 'neutral',
          title: b.attempted,
          body: `Abandoned: ${b.reason_abandoned}`,
        }),
      ),
    });
  }

  blocks.push({
    type: 'section',
    title: 'Provenance',
    blocks: [
      {
        type: 'table',
        columns: ['Decision', 'Closed by', 'Entries'],
        rows: brief.provenance.map((e) => [
          e.decision_id,
          e.closed_by_id ?? '(open)',
          String(e.entry_count),
        ]),
      },
    ],
  });

  return { schema_version: '1', title: 'Review Brief', blocks };
}

/** Compile a Milestone Brief into a report/v1 document (4 stakeholder sections). */
export function milestoneBriefToReportDocument(brief: MilestoneBrief): ReportDocument {
  const blocks: Block[] = [];

  blocks.push({
    type: 'section',
    title: `Needs your attention (${brief.attention.length})`,
    blocks:
      brief.attention.length > 0
        ? brief.attention.map((a): Block => {
            const callout = attentionCallout(a.item);
            // Prefix the story the item was first seen in.
            return callout.type === 'callout'
              ? { ...callout, title: `[${a.story_id}] ${callout.title}` }
              : callout;
          })
        : [{ type: 'paragraph', text: 'Nothing flagged across the milestone.' }],
  });

  blocks.push({
    type: 'section',
    title: `Outcomes (${brief.outcomes.length})`,
    blocks: [
      {
        type: 'table',
        columns: ['Story', 'Title', 'Outcome'],
        rows: brief.outcomes.map((o) => [o.story_id, o.title, o.outcome]),
      },
    ],
  });

  blocks.push({
    type: 'section',
    title: `Decisions of record (${brief.decisions.length})`,
    blocks:
      brief.decisions.length > 0
        ? brief.decisions.flatMap((d) =>
            decisionBlocks(d.decision).map(
              (b): Block =>
                b.type === 'callout' ? { ...b, title: `[${d.story_id}] ${b.title ?? ''}` } : b,
            ),
          )
        : [{ type: 'paragraph', text: 'No decisions of record.' }],
  });

  blocks.push({
    type: 'section',
    title: `Did not ship (${brief.did_not_ship.length})`,
    blocks:
      brief.did_not_ship.length > 0
        ? [
            {
              type: 'table',
              columns: ['Story', 'Title', 'Reason', 'Detail'],
              rows: brief.did_not_ship.map((d) => [d.story_id, d.title, d.reason, d.detail]),
            },
          ]
        : [{ type: 'paragraph', text: 'Everything in scope shipped.' }],
  });

  return { schema_version: '1', title: `Milestone Brief: ${brief.milestone_id}`, blocks };
}
