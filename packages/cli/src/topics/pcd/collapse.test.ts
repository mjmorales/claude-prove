/**
 * Tests for the PCD collapse round (TypeScript port of
 * `tools/pcd/test_collapse.py`).
 *
 * Every assertion mirrors a Python test case verbatim. Keep the structure
 * and test names aligned — changes must land in lockstep with the Python
 * source file until the Python version is retired.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type CollapsedManifest,
  type TriageCard,
  type TriageManifest,
  collapseManifest,
  serializeCollapsedManifest,
} from './collapse';
import { validateArtifact } from './schemas';

// ---------------------------------------------------------------------------
// Fixture builders (mirror of test_collapse.py helpers)
// ---------------------------------------------------------------------------

interface MakeCardOptions {
  file?: string;
  risk?: string;
  confidence?: number;
  findings?: Array<Record<string, unknown>>;
  questions?: Array<Record<string, unknown>>;
  cluster_id?: number;
  status?: string;
}

function makeCard(opts: MakeCardOptions = {}): TriageCard {
  const file = opts.file ?? 'src/main.py';
  const card: TriageCard = {
    file,
    lines: 100,
    risk: opts.risk ?? 'high',
    confidence: opts.confidence ?? 4,
    findings: opts.findings ?? [
      {
        category: 'error_handling',
        brief: `Issue in ${file}`,
        line_range: [1, 10],
      },
    ],
    questions: opts.questions ?? [],
  };
  if (opts.cluster_id !== undefined) card.cluster_id = opts.cluster_id;
  if (opts.status !== undefined) card.status = opts.status;
  return card;
}

function makeCleanCard(file = 'src/util.py', confidence = 5): TriageCard {
  return {
    file,
    lines: 20,
    risk: 'low',
    confidence,
    status: 'clean',
  };
}

function makeManifest(
  cards: TriageCard[],
  questionIndex: Array<Record<string, unknown>> = [],
): TriageManifest {
  const countRisk = (target: string): number => cards.filter((c) => c.risk === target).length;
  const totalQuestions = cards.reduce(
    (sum, c) => sum + (Array.isArray(c.questions) ? c.questions.length : 0),
    0,
  );
  return {
    version: 1,
    stats: {
      files_reviewed: cards.length,
      high_risk: countRisk('high'),
      medium_risk: countRisk('medium'),
      low_risk: countRisk('low'),
      total_questions: totalQuestions,
    },
    cards,
    question_index: questionIndex,
  };
}

// ---------------------------------------------------------------------------
// Preserve-rule tests (mirror Python TestPreserveHighRisk etc.)
// ---------------------------------------------------------------------------

describe('preserve high risk', () => {
  test('high and critical preserved', () => {
    const manifest = makeManifest([
      makeCard({ file: 'a.py', risk: 'high', confidence: 5 }),
      makeCard({ file: 'b.py', risk: 'critical', confidence: 5 }),
    ]);
    const result = collapseManifest(manifest);
    expect(result.stats.preserved).toBe(2);
    expect(result.stats.collapsed).toBe(0);
    const preservedFiles = result.preserved_cards.map((c) => c.file);
    expect(preservedFiles).toContain('a.py');
    expect(preservedFiles).toContain('b.py');
  });
});

describe('preserve medium risk', () => {
  test('medium risk preserved even at confidence 5', () => {
    const manifest = makeManifest([makeCard({ file: 'a.py', risk: 'medium', confidence: 5 })]);
    const result = collapseManifest(manifest);
    expect(result.stats.preserved).toBe(1);
    expect(result.stats.collapsed).toBe(0);
  });
});

describe('preserve low confidence', () => {
  test('risk=low confidence=3 preserved (boundary)', () => {
    const manifest = makeManifest([makeCard({ file: 'a.py', risk: 'low', confidence: 3 })]);
    const result = collapseManifest(manifest);
    expect(result.stats.preserved).toBe(1);
    expect(result.stats.collapsed).toBe(0);
  });

  test('confidence=2 preserved', () => {
    const manifest = makeManifest([makeCard({ file: 'a.py', risk: 'low', confidence: 2 })]);
    const result = collapseManifest(manifest);
    expect(result.stats.preserved).toBe(1);
  });

  test('confidence=1 preserved', () => {
    const manifest = makeManifest([makeCard({ file: 'a.py', risk: 'low', confidence: 1 })]);
    const result = collapseManifest(manifest);
    expect(result.stats.preserved).toBe(1);
  });
});

describe('collapse low risk high confidence', () => {
  test('risk=low confidence=4 collapsed (boundary)', () => {
    const manifest = makeManifest([makeCard({ file: 'a.py', risk: 'low', confidence: 4 })]);
    const result = collapseManifest(manifest);
    expect(result.stats.preserved).toBe(0);
    expect(result.stats.collapsed).toBe(1);
    expect(result.collapsed_summaries.length).toBe(1);
  });

  test('confidence=5 collapsed', () => {
    const manifest = makeManifest([makeCard({ file: 'a.py', risk: 'low', confidence: 5 })]);
    const result = collapseManifest(manifest);
    expect(result.stats.collapsed).toBe(1);
  });
});

describe('clean bill always collapsed', () => {
  test('clean card is collapsed', () => {
    const manifest = makeManifest([makeCleanCard()]);
    const result = collapseManifest(manifest);
    expect(result.stats.collapsed).toBe(1);
    expect(result.stats.preserved).toBe(0);
  });

  test('clean card collapsed even with low confidence', () => {
    const card = makeCleanCard();
    card.confidence = 1;
    const manifest = makeManifest([card]);
    const result = collapseManifest(manifest);
    expect(result.stats.collapsed).toBe(1);
    expect(result.stats.preserved).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Question index passthrough (mirror Python TestQuestionsAlwaysPreserved)
// ---------------------------------------------------------------------------

describe('questions always preserved', () => {
  test('question index passes through unchanged when all cards collapse', () => {
    const questions = [
      {
        id: 'q-001',
        from_file: 'src/main.py',
        target_files: ['src/db.py'],
        question_type: 'error_handling',
      },
      {
        id: 'q-002',
        from_file: 'src/util.py',
        target_files: ['src/config.py'],
        question_type: 'contract',
      },
    ];
    const manifest = makeManifest(
      [
        makeCard({ file: 'src/main.py', risk: 'low', confidence: 5 }),
        makeCard({ file: 'src/util.py', risk: 'low', confidence: 5 }),
      ],
      questions,
    );
    const result = collapseManifest(manifest);
    expect(result.question_index).toEqual(questions);
    expect(result.question_index.length).toBe(2);
  });

  test('question_index preserves input key order', () => {
    const q: Record<string, unknown> = {};
    // Insert keys in a non-alphabetical order.
    q.question_type = 'contract';
    q.id = 'q-1';
    q.target_files = ['b.py'];
    q.from_file = 'a.py';
    const manifest = makeManifest([makeCleanCard('a.py')], [q]);
    const result = collapseManifest(manifest);
    expect(Object.keys(result.question_index[0] ?? {})).toEqual([
      'question_type',
      'id',
      'target_files',
      'from_file',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Compression ratio stats
// ---------------------------------------------------------------------------

describe('compression ratio', () => {
  test('half collapsed -> 0.5', () => {
    const manifest = makeManifest([
      makeCard({ file: 'a.py', risk: 'high', confidence: 5 }),
      makeCard({ file: 'b.py', risk: 'low', confidence: 5 }),
    ]);
    expect(collapseManifest(manifest).stats.compression_ratio).toBeCloseTo(0.5);
  });

  test('all collapsed -> 1.0', () => {
    const manifest = makeManifest([
      makeCard({ file: 'a.py', risk: 'low', confidence: 5 }),
      makeCard({ file: 'b.py', risk: 'low', confidence: 5 }),
    ]);
    expect(collapseManifest(manifest).stats.compression_ratio).toBeCloseTo(1.0);
  });

  test('none collapsed -> 0.0', () => {
    const manifest = makeManifest([makeCard({ file: 'a.py', risk: 'high', confidence: 5 })]);
    expect(collapseManifest(manifest).stats.compression_ratio).toBeCloseTo(0.0);
  });
});

// ---------------------------------------------------------------------------
// Bulk group tests
// ---------------------------------------------------------------------------

describe('all high risk', () => {
  test('no collapse when every card is high/critical', () => {
    const manifest = makeManifest([
      makeCard({ file: 'a.py', risk: 'high' }),
      makeCard({ file: 'b.py', risk: 'critical' }),
      makeCard({ file: 'c.py', risk: 'high' }),
    ]);
    const result = collapseManifest(manifest);
    expect(result.stats.preserved).toBe(3);
    expect(result.stats.collapsed).toBe(0);
    expect(result.collapsed_summaries.length).toBe(0);
  });
});

describe('all low risk', () => {
  test('all collapsed when every card is low-risk high-confidence', () => {
    const manifest = makeManifest([
      makeCard({ file: 'a.py', risk: 'low', confidence: 5 }),
      makeCard({ file: 'b.py', risk: 'low', confidence: 4 }),
      makeCard({ file: 'c.py', risk: 'low', confidence: 5 }),
    ]);
    const result = collapseManifest(manifest);
    expect(result.stats.preserved).toBe(0);
    expect(result.stats.collapsed).toBe(3);
    expect(result.collapsed_summaries.length).toBeGreaterThanOrEqual(1);
  });
});

describe('empty manifest', () => {
  test('zero cards produces empty arrays and 0.0 ratio', () => {
    const manifest = makeManifest([]);
    const result = collapseManifest(manifest);
    expect(result.stats.total_cards).toBe(0);
    expect(result.stats.preserved).toBe(0);
    expect(result.stats.collapsed).toBe(0);
    expect(result.stats.compression_ratio).toBeCloseTo(0.0);
    expect(result.preserved_cards).toEqual([]);
    expect(result.collapsed_summaries).toEqual([]);
  });

  test('empty manifest validates against schema', () => {
    const manifest = makeManifest([]);
    const result = collapseManifest(manifest);
    expect(validateArtifact(result, 'collapsed_manifest').errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Aggregate signals & schema shape
// ---------------------------------------------------------------------------

describe('aggregate signals', () => {
  test('deduplicates briefs across a cluster', () => {
    const cards: TriageCard[] = [
      makeCard({
        file: 'src/a.py',
        risk: 'low',
        confidence: 5,
        cluster_id: 1,
        findings: [
          { category: 'naming', brief: 'Inconsistent naming', line_range: [1, 5] },
          { category: 'dead_code', brief: 'Unused import', line_range: [6, 6] },
        ],
      }),
      makeCard({
        file: 'src/b.py',
        risk: 'low',
        confidence: 5,
        cluster_id: 1,
        findings: [
          { category: 'naming', brief: 'Inconsistent naming', line_range: [1, 3] },
          { category: 'performance', brief: 'Unoptimized loop', line_range: [10, 20] },
        ],
      }),
    ];
    const result = collapseManifest(makeManifest(cards));

    expect(result.collapsed_summaries.length).toBe(1);
    const summary = result.collapsed_summaries[0];
    if (!summary) throw new Error('expected collapsed summary');
    const signals = summary.aggregate_signals;
    expect(signals.filter((s) => s === 'Inconsistent naming').length).toBe(1);
    expect(signals).toContain('Unused import');
    expect(signals).toContain('Unoptimized loop');
    expect(signals.length).toBe(3);
  });

  test('collapsed manifest conforms to COLLAPSED_MANIFEST_SCHEMA', () => {
    const manifest = makeManifest(
      [
        makeCard({ file: 'a.py', risk: 'high', confidence: 4 }),
        makeCard({ file: 'b.py', risk: 'low', confidence: 5, cluster_id: 1 }),
        makeCleanCard('c.py'),
      ],
      [
        {
          id: 'q-001',
          from_file: 'a.py',
          target_files: ['b.py'],
          question_type: 'error_handling',
        },
      ],
    );
    const result = collapseManifest(manifest);
    const errors = validateArtifact(result, 'collapsed_manifest').errors;
    expect(errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Byte-parity JSON serialization
// ---------------------------------------------------------------------------

describe('serializeCollapsedManifest', () => {
  test('integer-valued compression_ratio renders as 0.0', () => {
    const manifest = makeManifest([]);
    const out = serializeCollapsedManifest(collapseManifest(manifest));
    expect(out).toContain('"compression_ratio": 0.0');
    expect(out).not.toMatch(/"compression_ratio": 0(,|\s*\n)/);
  });

  test('integer-valued compression_ratio renders as 1.0', () => {
    const manifest = makeManifest([makeCard({ file: 'a.py', risk: 'low', confidence: 5 })]);
    const out = serializeCollapsedManifest(collapseManifest(manifest));
    expect(out).toContain('"compression_ratio": 1.0');
  });

  test('fractional ratio keeps Python repr precision', () => {
    const manifest = makeManifest([
      makeCard({ file: 'a.py', risk: 'high' }),
      makeCard({ file: 'b.py', risk: 'low', confidence: 5 }),
      makeCard({ file: 'c.py', risk: 'low', confidence: 5 }),
    ]);
    const out = serializeCollapsedManifest(collapseManifest(manifest));
    // 2/3 -> 0.6666666666666666 in both Python repr and JS Number->String.
    expect(out).toContain('"compression_ratio": 0.6666666666666666');
  });
});

// ---------------------------------------------------------------------------
// Python parity fixtures — byte-equal JSON vs Python captures
// ---------------------------------------------------------------------------

describe('python parity fixtures', () => {
  const fixturesDir = join(__dirname, '__fixtures__', 'collapse', 'python-captures');

  const cases: string[] = [
    'all-clean',
    'all-critical',
    'boundary-risk-low-conf-3',
    'boundary-risk-low-conf-4',
    'boundary-risk-medium-conf-5',
    'mixed',
    'empty-manifest',
  ];

  for (const name of cases) {
    test(`parity: ${name}`, () => {
      const inputPath = join(fixturesDir, `${name}.input.json`);
      const expectedPath = join(fixturesDir, `${name}.output.json`);
      const manifest = JSON.parse(readFileSync(inputPath, 'utf8')) as TriageManifest;
      const expectedText = readFileSync(expectedPath, 'utf8');
      const expected = JSON.parse(expectedText) as CollapsedManifest;
      const result = collapseManifest(manifest, 8000);

      // Structural equality (JSON-normalized so `0.0`/`0` compare equal).
      expect(result).toEqual(expected);

      // Byte-equal serialization against the Python-captured text. Python
      // writes with `indent=2` and a trailing newline (json.dump + write("\n")).
      const actualText = `${serializeCollapsedManifest(result, 2)}\n`;
      expect(actualText).toBe(expectedText);
    });
  }
});
