/**
 * Decompose child-list → report/v1 preview compiler tests. The compiled preview
 * must validate and surface each proposed child with its deps + acceptance.
 */

import { describe, expect, test } from 'bun:test';
import { validateReportDocument } from './blocks';
import { type DecomposeList, decomposeListToReportDocument } from './from-decompose';

describe('decomposeListToReportDocument', () => {
  test('compiles a child list into a valid numbered preview', () => {
    const list: DecomposeList = {
      layer: 'story',
      children: [
        {
          title: 'Login flow',
          description: 'OAuth login',
          blocked_by: ['Token store'],
          acceptance: [{ text: 'returns a JWT', verifies_by: 'bash', check: 'go test ./auth' }],
        },
        { title: 'Token store', description: 'persist tokens' },
      ],
    };
    const doc = decomposeListToReportDocument(list);
    expect(validateReportDocument(doc)).toEqual([]);
    expect(doc.title).toBe('Decomposition preview: story children');
    const sections = doc.blocks.filter((b) => b.type === 'section');
    expect(sections.map((s) => (s.type === 'section' ? s.title : ''))).toEqual([
      '1. Login flow',
      '2. Token store',
    ]);
  });

  test('surfaces a child blocked_by + acceptance', () => {
    const doc = decomposeListToReportDocument({
      children: [
        {
          title: 'X',
          description: 'd',
          blocked_by: ['Y', 'Z'],
          acceptance: [{ text: 'holds', verifies_by: 'assert' }],
        },
      ],
    });
    const section = doc.blocks.find((b) => b.type === 'section');
    const inner = section?.type === 'section' ? section.blocks : [];
    const kv = inner.find((b) => b.type === 'keyValue');
    expect(kv?.type === 'keyValue' ? kv.items[0]?.value : '').toBe('Y, Z');
    expect(inner.some((b) => b.type === 'table')).toBe(true);
  });

  test('an empty child list still validates with a no-children note', () => {
    const doc = decomposeListToReportDocument({ children: [] });
    expect(validateReportDocument(doc)).toEqual([]);
  });

  test('marks bash/assert checks as inline code; agent checks stay prose', () => {
    const doc = decomposeListToReportDocument({
      children: [
        {
          title: 'X',
          description: 'd',
          acceptance: [
            { text: 'builds', verifies_by: 'bash', check: 'bun run build' },
            { text: 'reviewed', verifies_by: 'agent', check: 'Read the diff and confirm intent.' },
          ],
        },
      ],
    });
    const section = doc.blocks.find((b) => b.type === 'section');
    const table =
      section?.type === 'section' ? section.blocks.find((b) => b.type === 'table') : undefined;
    const rows = table?.type === 'table' ? table.rows : [];
    expect(rows[0]?.[2]).toBe('`bun run build`');
    expect(rows[1]?.[2]).toBe('Read the diff and confirm intent.');
  });

  test('pluralizes the proposed-children callout per layer', () => {
    const callOutTitle = (layer: string | undefined, n: number): string => {
      const doc = decomposeListToReportDocument({
        layer,
        children: Array.from({ length: n }, (_, i) => ({ title: `c${i}`, description: 'd' })),
      });
      const callout = doc.blocks.find((b) => b.type === 'callout');
      return callout?.type === 'callout' ? (callout.title ?? '') : '';
    };
    expect(callOutTitle('story', 4)).toBe('4 proposed stories');
    expect(callOutTitle('story', 1)).toBe('1 proposed story');
    expect(callOutTitle('epic', 2)).toBe('2 proposed epics');
    expect(callOutTitle(undefined, 2)).toBe('2 proposed children');
  });
});
