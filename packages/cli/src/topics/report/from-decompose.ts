/**
 * Compile a decompose ladder's child list (the structured-output a planning
 * subagent returns one tier down) into a report/v1 `ReportDocument` — a visual
 * preview the operator reviews before the accept gate promotes the children.
 * Mechanical: child list in, blocks out.
 *
 * The input mirrors the decompose skill's `childrenSchema`; only `title` and
 * `description` are required per child, so a partial planner output still
 * previews. This module owns its own input shape (the skill is markdown, not an
 * importable module).
 */

import { type Block, REPORT_SCHEMA_VERSION, type ReportDocument, codeSpan } from './blocks';

/** One acceptance criterion as the planner proposes it (mirrors childrenSchema). */
export interface DecomposeAcceptance {
  text: string;
  verifies_by?: string;
  check?: string;
  idempotent?: boolean;
}

/** One proposed child in a decompose preview (mirrors childrenSchema). */
export interface DecomposeChild {
  title: string;
  description: string;
  blocked_by?: string[];
  acceptance?: DecomposeAcceptance[];
}

/** A decompose child list: the proposed children plus the layer they sit at. */
export interface DecomposeList {
  layer?: string;
  children: DecomposeChild[];
}

/** Verification kinds whose `check` is executable code, not a prose instruction. */
const CODE_CHECK_KINDS = new Set(['bash', 'assert']);

/** One proposed child → a section (description + deps + acceptance table). */
function childSection(child: DecomposeChild, index: number): Block {
  const inner: Block[] = [{ type: 'paragraph', text: child.description }];

  const blockedBy = child.blocked_by ?? [];
  if (blockedBy.length > 0) {
    inner.push({ type: 'keyValue', items: [{ key: 'Blocked by', value: blockedBy.join(', ') }] });
  }

  const acceptance = child.acceptance ?? [];
  if (acceptance.length > 0) {
    inner.push({
      type: 'table',
      columns: ['Criterion', 'Verifies by', 'Check'],
      rows: acceptance.map((a) => {
        // bash/assert checks are code (chip them); agent/gate checks are prose
        const check = a.check ?? '';
        const isCode = CODE_CHECK_KINDS.has(a.verifies_by ?? '');
        return [a.text, a.verifies_by ?? '', isCode ? codeSpan(check) : check];
      }),
    });
  }

  return { type: 'section', title: `${index + 1}. ${child.title}`, blocks: inner };
}

/** Pluralize a decompose layer name for the preview callout. */
function pluralizeLayer(layer: string | undefined, count: number): string {
  if (!layer) return count === 1 ? 'child' : 'children';
  if (count === 1) return layer;
  return layer === 'story' ? 'stories' : `${layer}s`;
}

/**
 * Compile a decompose child list into a preview report/v1 document. The title
 * names the target layer when known; each child becomes a numbered section.
 */
export function decomposeListToReportDocument(list: DecomposeList): ReportDocument {
  const children = list.children ?? [];
  const layerSuffix = list.layer ? `: ${list.layer} children` : '';
  const blocks: Block[] = [
    {
      type: 'callout',
      tone: 'info',
      title: `${children.length} proposed ${pluralizeLayer(list.layer, children.length)}`,
      body: 'Review the proposed children below before accepting them into the tree.',
    },
  ];

  if (children.length > 0) {
    blocks.push(...children.map(childSection));
  } else {
    blocks.push({ type: 'paragraph', text: 'The planner proposed no children.' });
  }

  return {
    schema_version: REPORT_SCHEMA_VERSION,
    title: `Decomposition preview${layerSuffix}`,
    blocks,
  };
}
