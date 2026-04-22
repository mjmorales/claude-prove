/**
 * Tests for the PCD Round 2 batch former (TypeScript port of
 * `tools/pcd/test_batch_former.py`).
 *
 * Every assertion mirrors a Python test case verbatim. Keep the structure
 * and test names aligned — changes must land in lockstep with the Python
 * source file until the Python version is retired.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type BatchDefinition, _estimateTokens, formBatches } from './batch-former';
import type { CollapsedManifest, TriageCard } from './collapse';
import { validateArtifact } from './schemas';
import type { StructuralMap, StructuralMapCluster, StructuralMapModule } from './structural-map';

// ---------------------------------------------------------------------------
// Fixture builders (mirror of test_batch_former.py helpers)
// ---------------------------------------------------------------------------

function makeTriageCard(file = 'src/main.py', risk = 'high', confidence = 4): TriageCard {
  return {
    file,
    lines: 100,
    risk,
    confidence,
    findings: [
      {
        category: 'error_handling',
        brief: `Issue in ${file}`,
        line_range: [1, 10],
      },
    ],
    questions: [],
  };
}

function makeCollapsedManifest(
  preservedCards: TriageCard[],
  questionIndex: Array<Record<string, unknown>> = [],
): CollapsedManifest {
  const preserved = preservedCards.length;
  const total = preserved + 2;
  return {
    version: 1,
    stats: {
      total_cards: total,
      preserved,
      collapsed: 2,
      compression_ratio: preserved > 0 ? 2 / total : 0.0,
    },
    preserved_cards: preservedCards,
    collapsed_summaries: [
      {
        cluster_id: 99,
        file_count: 2,
        files: ['lib/helper.py', 'lib/utils.py'],
        max_risk: 'low',
        aggregate_signals: ['Minor style issue'],
      },
    ],
    question_index: questionIndex,
  };
}

const DEFAULT_MODULES: StructuralMapModule[] = [
  {
    path: 'src/main.py',
    lines: 100,
    language: 'python',
    exports: ['main'],
    imports_from: ['src/util.py'],
    imported_by: [],
    cluster_id: 0,
  },
  {
    path: 'src/util.py',
    lines: 50,
    language: 'python',
    exports: ['helper'],
    imports_from: [],
    imported_by: ['src/main.py'],
    cluster_id: 0,
  },
  {
    path: 'src/db.py',
    lines: 80,
    language: 'python',
    exports: ['connect'],
    imports_from: [],
    imported_by: ['src/main.py'],
    cluster_id: 1,
  },
];

const DEFAULT_CLUSTERS: StructuralMapCluster[] = [
  {
    id: 0,
    name: 'core',
    files: ['src/main.py', 'src/util.py'],
    internal_edges: 1,
    external_edges: 0,
  },
  {
    id: 1,
    name: 'data',
    files: ['src/db.py'],
    internal_edges: 0,
    external_edges: 1,
  },
];

function makeStructuralMap(
  modules: StructuralMapModule[] = DEFAULT_MODULES,
  clusters: StructuralMapCluster[] = DEFAULT_CLUSTERS,
): StructuralMap {
  return {
    version: 1,
    timestamp: '2026-03-28T00:00:00+00:00',
    generated_by: 'deterministic',
    summary: {
      total_files: 5,
      total_lines: 500,
      languages: { python: 500 },
    },
    modules,
    clusters,
    dependency_edges: [
      { from: 'src/main.py', to: 'src/util.py', type: 'internal' },
      { from: 'src/main.py', to: 'src/db.py', type: 'internal' },
    ],
  };
}

// ---------------------------------------------------------------------------
// Basic batching (mirrors Python TestBasicBatching)
// ---------------------------------------------------------------------------

describe('basic batching', () => {
  test('two clusters produce two batches', () => {
    const cards = [
      makeTriageCard('src/main.py'),
      makeTriageCard('src/util.py'),
      makeTriageCard('src/db.py'),
    ];
    const manifest = makeCollapsedManifest(cards);
    const structMap = makeStructuralMap();

    const batches = formBatches(manifest, structMap);

    expect(batches.length).toBe(2);

    const cluster0Batch = batches.find((b) => b.files.includes('src/main.py'));
    expect(cluster0Batch).toBeDefined();
    expect(cluster0Batch?.files).toContain('src/util.py');

    const cluster1Batch = batches.find((b) => b.files.includes('src/db.py'));
    expect(cluster1Batch?.files).toEqual(['src/db.py']);
  });

  test('batch ids are sequential starting at 1', () => {
    const cards = [makeTriageCard('src/main.py'), makeTriageCard('src/db.py')];
    const manifest = makeCollapsedManifest(cards);
    const structMap = makeStructuralMap();

    const batches = formBatches(manifest, structMap);
    const ids = batches.map((b) => b.batch_id);
    expect(ids).toEqual(Array.from({ length: batches.length }, (_, i) => i + 1));
  });
});

// ---------------------------------------------------------------------------
// Split large cluster (mirrors Python TestSplitLargeCluster)
// ---------------------------------------------------------------------------

describe('split large cluster', () => {
  test('cluster over max_files_per_batch splits by subdir/chunk', () => {
    const files = Array.from({ length: 5 }, (_, i) => `src/mod${i}.py`);
    const cards = files.map((f) => makeTriageCard(f));
    const modules: StructuralMapModule[] = files.map((f) => ({
      path: f,
      lines: 50,
      language: 'python',
      exports: [],
      imports_from: [],
      imported_by: [],
      cluster_id: 0,
    }));
    const clusters: StructuralMapCluster[] = [
      {
        id: 0,
        name: 'big_cluster',
        files,
        internal_edges: 4,
        external_edges: 0,
      },
    ];

    const manifest = makeCollapsedManifest(cards);
    const structMap = makeStructuralMap(modules, clusters);

    const batches = formBatches(manifest, structMap, 2);

    expect(batches.length).toBe(3);
    const totalFiles = batches.reduce((sum, b) => sum + b.files.length, 0);
    expect(totalFiles).toBe(5);
    for (const batch of batches) {
      expect(batch.files.length).toBeLessThanOrEqual(2);
    }
  });
});

// ---------------------------------------------------------------------------
// Question routing (mirrors Python TestQuestionRouting)
// ---------------------------------------------------------------------------

describe('question routing', () => {
  test('direct routing: question lands in batch containing target file', () => {
    const cards = [makeTriageCard('src/main.py'), makeTriageCard('src/db.py')];
    const questions = [
      {
        id: 'q-001',
        from_file: 'src/main.py',
        target_files: ['src/db.py'],
        question_type: 'error_handling',
        text: 'What happens on connection failure?',
      },
    ];
    const manifest = makeCollapsedManifest(cards, questions);
    const structMap = makeStructuralMap();

    const batches = formBatches(manifest, structMap);

    const dbBatch = batches.find((b) => b.files.includes('src/db.py'));
    expect(dbBatch?.routed_questions.length).toBe(1);
    expect(dbBatch?.routed_questions[0]?.id).toBe('q-001');
    expect(dbBatch?.routed_questions[0]?.from_file).toBe('src/main.py');
    expect(dbBatch?.routed_questions[0]?.question).toBe('What happens on connection failure?');
  });
});

// ---------------------------------------------------------------------------
// Unroutable question (mirrors Python TestUnroutableQuestion)
// ---------------------------------------------------------------------------

describe('unroutable question', () => {
  test('question with missing target falls back to closest batch', () => {
    const cards = [makeTriageCard('src/main.py'), makeTriageCard('src/db.py')];
    const questions = [
      {
        id: 'q-002',
        from_file: 'src/main.py',
        target_files: ['src/config.py'],
        question_type: 'contract',
        text: 'What is the config schema?',
      },
    ];
    const manifest = makeCollapsedManifest(cards, questions);
    const structMap = makeStructuralMap();

    const batches = formBatches(manifest, structMap);

    const allRouted = batches.flatMap((b) => b.routed_questions);
    expect(allRouted.length).toBe(1);
    expect(allRouted[0]?.id).toBe('q-002');
  });
});

// ---------------------------------------------------------------------------
// Empty manifest (mirrors Python TestEmptyManifest)
// ---------------------------------------------------------------------------

describe('empty manifest', () => {
  test('no preserved cards -> no batches', () => {
    const manifest = makeCollapsedManifest([]);
    const structMap = makeStructuralMap();

    const batches = formBatches(manifest, structMap);
    expect(batches).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Single file batch (mirrors Python TestSingleFileBatch)
// ---------------------------------------------------------------------------

describe('single file batch', () => {
  test('single card produces single-file batch', () => {
    const cards = [makeTriageCard('src/main.py')];
    const manifest = makeCollapsedManifest(cards);
    const structMap = makeStructuralMap();

    const batches = formBatches(manifest, structMap);

    expect(batches.length).toBe(1);
    expect(batches[0]?.files).toEqual(['src/main.py']);
    expect(batches[0]?.triage_cards.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Cluster context (mirrors Python TestClusterContextAttached)
// ---------------------------------------------------------------------------

describe('cluster context attached', () => {
  test('each batch includes cluster metadata', () => {
    const cards = [makeTriageCard('src/main.py'), makeTriageCard('src/db.py')];
    const manifest = makeCollapsedManifest(cards);
    const structMap = makeStructuralMap();

    const batches = formBatches(manifest, structMap);

    for (const batch of batches) {
      expect(Array.isArray(batch.cluster_context)).toBe(true);
      if (batch.cluster_context.length > 0) {
        const ctx = batch.cluster_context[0];
        expect(ctx).toHaveProperty('id');
        expect(ctx).toHaveProperty('name');
        expect(ctx).toHaveProperty('files');
      }
    }
  });

  test('correct cluster assigned by cluster_id lookup', () => {
    const cards = [makeTriageCard('src/main.py'), makeTriageCard('src/db.py')];
    const manifest = makeCollapsedManifest(cards);
    const structMap = makeStructuralMap();

    const batches = formBatches(manifest, structMap);

    const coreBatch = batches.find((b) => b.files.includes('src/main.py'));
    expect(coreBatch?.cluster_context[0]?.name).toBe('core');

    const dataBatch = batches.find((b) => b.files.includes('src/db.py'));
    expect(dataBatch?.cluster_context[0]?.name).toBe('data');
  });
});

// ---------------------------------------------------------------------------
// Token estimation (mirrors Python TestTokenEstimation)
// ---------------------------------------------------------------------------

describe('token estimation', () => {
  test('estimated_tokens > 0 for non-empty batches', () => {
    const cards = [makeTriageCard('src/main.py')];
    const manifest = makeCollapsedManifest(cards);
    const structMap = makeStructuralMap();

    const batches = formBatches(manifest, structMap);

    expect(batches.length).toBeGreaterThan(0);
    for (const batch of batches) {
      expect(batch.estimated_tokens).toBeGreaterThan(0);
    }
  });

  test('_estimateTokens falls back for non-existent files (4000 each)', () => {
    const tokens = _estimateTokens(['nonexistent/file.py'], '.');
    expect(tokens).toBeGreaterThan(0);
    // 16000 chars / 4 = 4000.
    expect(tokens).toBe(4000);
  });

  test('_estimateTokens returns 0 for empty file list', () => {
    expect(_estimateTokens([], '.')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Schema validation (mirrors Python TestBatchSchemaValidation)
// ---------------------------------------------------------------------------

describe('batch schema validation', () => {
  test('every batch validates against BATCH_DEFINITION_SCHEMA', () => {
    const cards = [makeTriageCard('src/main.py'), makeTriageCard('src/db.py')];
    const questions = [
      {
        id: 'q-001',
        from_file: 'src/main.py',
        target_files: ['src/db.py'],
        question_type: 'error_handling',
        text: 'What happens on failure?',
      },
    ];
    const manifest = makeCollapsedManifest(cards, questions);
    const structMap = makeStructuralMap();

    const batches = formBatches(manifest, structMap);

    for (const batch of batches) {
      const result = validateArtifact(batch, 'batch_definition');
      expect(result.errors).toEqual([]);
      expect(result.ok).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Python parity fixtures — byte-equal JSON vs Python captures
// ---------------------------------------------------------------------------

describe('python parity fixtures', () => {
  const fixturesDir = join(__dirname, '__fixtures__', 'batch-former', 'python-captures');

  // Must stay in sync with capture.sh `CASES` array.
  const cases: Array<{ name: string; maxFiles: number }> = [
    { name: 'small', maxFiles: 15 },
    { name: 'oversized', maxFiles: 2 },
    { name: 'cross-cluster-questions', maxFiles: 15 },
    { name: 'empty', maxFiles: 15 },
    { name: 'single-file-cluster', maxFiles: 15 },
    { name: 'unroutable-question', maxFiles: 15 },
  ];

  for (const { name, maxFiles } of cases) {
    test(`parity: ${name}`, () => {
      const collapsedPath = join(fixturesDir, `${name}.collapsed.json`);
      const structuralPath = join(fixturesDir, `${name}.structural.json`);
      const expectedPath = join(fixturesDir, `${name}.output.json`);

      const collapsed = JSON.parse(readFileSync(collapsedPath, 'utf8')) as CollapsedManifest;
      const structural = JSON.parse(readFileSync(structuralPath, 'utf8')) as StructuralMap;
      const expected = JSON.parse(readFileSync(expectedPath, 'utf8')) as BatchDefinition[];

      // Use the same non-existent project_root the capture script uses so the
      // token estimator hits the 16000-char fallback on both sides.
      const result = formBatches(collapsed, structural, maxFiles, '/nonexistent-root-for-parity');

      expect(result).toEqual(expected);
    });
  }
});
