/**
 * Schema + validator parity tests for the PCD artifact DSL.
 *
 * Covers the same surface as `tools/pcd/test_schemas.py` plus parity fixtures
 * under `__fixtures__/schemas/python-captures/` that pin error strings to the
 * Python source byte-for-byte.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  ANSWER_STATUSES,
  BATCH_FINDING_CATEGORIES,
  BATCH_FINDING_SEVERITIES,
  COMPLEXITY_LEVELS,
  EDGE_TYPES,
  FINDING_CATEGORIES,
  GENERATED_BY,
  QUESTION_TYPES,
  RISK_LEVELS,
  SCHEMA_REGISTRY,
  validateArtifact,
} from './schemas';

// ---------------------------------------------------------------------------
// Fixture builders — mirror `tools/pcd/test_schemas.py` helpers
// ---------------------------------------------------------------------------

function makeStructuralMap(): Record<string, unknown> {
  return {
    version: 1,
    timestamp: '2026-03-28T00:00:00Z',
    generated_by: 'deterministic',
    summary: {
      total_files: 2,
      total_lines: 100,
      languages: { python: 80, markdown: 20 },
    },
    modules: [
      {
        path: 'src/main.py',
        lines: 80,
        language: 'python',
        exports: ['main'],
        imports_from: ['src/util.py'],
        imported_by: [],
        cluster_id: 0,
      },
    ],
    clusters: [
      {
        id: 0,
        name: 'core',
        files: ['src/main.py'],
        internal_edges: 1,
        external_edges: 0,
      },
    ],
    dependency_edges: [{ from: 'src/main.py', to: 'src/util.py', type: 'internal' }],
  };
}

function makeTriageCard(): Record<string, unknown> {
  return {
    file: 'src/main.py',
    lines: 80,
    risk: 'high',
    confidence: 4,
    findings: [
      {
        category: 'error_handling',
        brief: 'Unchecked return value',
        line_range: [10, 15],
      },
    ],
    questions: [
      {
        id: 'q-001',
        referencing_file: 'src/main.py',
        referenced_symbol: 'connect',
        referenced_files: ['src/db.py'],
        question_type: 'error_handling',
        text: 'What happens when connect() fails?',
      },
    ],
  };
}

function makeTriageCardClean(): Record<string, unknown> {
  return {
    file: 'src/util.py',
    lines: 20,
    risk: 'low',
    confidence: 5,
    status: 'clean',
  };
}

function makeTriageManifest(): Record<string, unknown> {
  return {
    version: 1,
    stats: {
      files_reviewed: 2,
      high_risk: 1,
      medium_risk: 0,
      low_risk: 1,
      total_questions: 1,
    },
    cards: [makeTriageCard(), makeTriageCardClean()],
    question_index: [
      {
        id: 'q-001',
        from_file: 'src/main.py',
        target_files: ['src/db.py'],
        question_type: 'error_handling',
      },
    ],
  };
}

function makeCollapsedManifest(): Record<string, unknown> {
  return {
    version: 1,
    stats: {
      total_cards: 5,
      preserved: 2,
      collapsed: 3,
      compression_ratio: 0.6,
    },
    preserved_cards: [makeTriageCard()],
    collapsed_summaries: [
      {
        cluster_id: 1,
        file_count: 3,
        files: ['a.py', 'b.py', 'c.py'],
        max_risk: 'low',
        aggregate_signals: ['No significant issues'],
      },
    ],
    question_index: [
      {
        id: 'q-001',
        from_file: 'src/main.py',
        target_files: ['src/db.py'],
        question_type: 'error_handling',
      },
    ],
  };
}

function makeFindingsBatch(): Record<string, unknown> {
  return {
    batch_id: 1,
    files_reviewed: ['src/main.py'],
    findings: [
      {
        id: 'f-001',
        severity: 'critical',
        category: 'error_handling',
        file: 'src/main.py',
        line_range: [10, 15],
        title: 'Missing error handling',
        detail: 'The connect() call has no error handling.',
        fix_sketch: 'Wrap in try/except and handle ConnectionError.',
      },
    ],
    answers: [
      {
        question_id: 'q-001',
        status: 'answered',
        answer: 'connect() raises ConnectionError on failure.',
      },
    ],
    new_questions: [],
  };
}

function makeBatchDefinition(): Record<string, unknown> {
  return {
    batch_id: 1,
    files: ['src/main.py'],
    triage_cards: [makeTriageCard()],
    cluster_context: [
      {
        id: 0,
        name: 'core',
        files: ['src/main.py'],
        internal_edges: 1,
        external_edges: 0,
      },
    ],
    routed_questions: [
      {
        id: 'q-001',
        from_file: 'src/main.py',
        question: 'What happens when connect() fails?',
      },
    ],
    estimated_tokens: 5000,
  };
}

function makePipelineStatus(): Record<string, unknown> {
  return {
    version: 1,
    started_at: '2026-03-28T00:00:00Z',
    rounds: {
      structural_map: {
        status: 'complete',
        artifact: '.prove/pcd/structural-map.json',
        duration_s: 12.5,
      },
      triage: {
        status: 'in_progress',
        batches_complete: 2,
        batches_total: 5,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Happy-path validation
// ---------------------------------------------------------------------------

describe('validateArtifact — happy path', () => {
  test('structural_map (valid)', () => {
    expect(validateArtifact(makeStructuralMap(), 'structural_map')).toEqual({
      ok: true,
      errors: [],
    });
  });

  test('triage_card (valid)', () => {
    expect(validateArtifact(makeTriageCard(), 'triage_card')).toEqual({ ok: true, errors: [] });
  });

  test('triage_card_clean (valid)', () => {
    expect(validateArtifact(makeTriageCardClean(), 'triage_card_clean')).toEqual({
      ok: true,
      errors: [],
    });
  });

  test('triage_manifest (valid)', () => {
    expect(validateArtifact(makeTriageManifest(), 'triage_manifest')).toEqual({
      ok: true,
      errors: [],
    });
  });

  test('collapsed_manifest (valid)', () => {
    expect(validateArtifact(makeCollapsedManifest(), 'collapsed_manifest')).toEqual({
      ok: true,
      errors: [],
    });
  });

  test('findings_batch (valid)', () => {
    expect(validateArtifact(makeFindingsBatch(), 'findings_batch')).toEqual({
      ok: true,
      errors: [],
    });
  });

  test('batch_definition (valid)', () => {
    expect(validateArtifact(makeBatchDefinition(), 'batch_definition')).toEqual({
      ok: true,
      errors: [],
    });
  });

  test('pipeline_status (valid)', () => {
    expect(validateArtifact(makePipelineStatus(), 'pipeline_status')).toEqual({
      ok: true,
      errors: [],
    });
  });
});

// ---------------------------------------------------------------------------
// Missing required fields
// ---------------------------------------------------------------------------

describe('validateArtifact — missing required', () => {
  test('top-level field', () => {
    const data = makeStructuralMap();
    Reflect.deleteProperty(data, 'version');
    const r = validateArtifact(data, 'structural_map');
    expect(r.ok).toBe(false);
    expect(r.errors).toContain('version: required field is missing');
  });

  test('nested field uses dot path', () => {
    const data = makeStructuralMap();
    Reflect.deleteProperty(data.summary as Record<string, unknown>, 'total_files');
    const r = validateArtifact(data, 'structural_map');
    expect(r.errors).toContain('summary.total_files: required field is missing');
  });

  test('empty dict flags every required top-level field', () => {
    const r = validateArtifact({}, 'structural_map');
    const required = [
      'version',
      'timestamp',
      'generated_by',
      'summary',
      'modules',
      'clusters',
      'dependency_edges',
    ];
    for (const f of required) {
      expect(r.errors).toContain(`${f}: required field is missing`);
    }
  });

  test('empty triage_card flags all required', () => {
    const r = validateArtifact({}, 'triage_card');
    for (const f of ['file', 'lines', 'risk', 'confidence', 'findings', 'questions']) {
      expect(r.errors).toContain(`${f}: required field is missing`);
    }
  });
});

// ---------------------------------------------------------------------------
// Wrong-type errors
// ---------------------------------------------------------------------------

describe('validateArtifact — wrong type', () => {
  test('string where int expected', () => {
    const data = makeStructuralMap();
    (data as { version: unknown }).version = 'one';
    const r = validateArtifact(data, 'structural_map');
    expect(r.errors).toContain('version: expected int, got str');
  });

  test('int where string expected', () => {
    const data = makeTriageCard();
    (data as { file: unknown }).file = 123;
    const r = validateArtifact(data, 'triage_card');
    expect(r.errors).toContain('file: expected str, got int');
  });

  test('string where list expected', () => {
    const data = makeStructuralMap();
    (data as { modules: unknown }).modules = 'not a list';
    const r = validateArtifact(data, 'structural_map');
    expect(r.errors).toContain('modules: expected list, got str');
  });

  test('bool where int expected (Python bool-is-int guard)', () => {
    const data = makeTriageCard();
    (data as { confidence: unknown }).confidence = true;
    const r = validateArtifact(data, 'triage_card');
    expect(r.errors).toContain('confidence: expected int, got bool');
  });

  test('float type accepts integer and fractional numbers', () => {
    const data = makeCollapsedManifest();
    (
      (data as { stats: Record<string, unknown> }).stats as { compression_ratio: unknown }
    ).compression_ratio = 1;
    expect(validateArtifact(data, 'collapsed_manifest').ok).toBe(true);
    (
      (data as { stats: Record<string, unknown> }).stats as { compression_ratio: unknown }
    ).compression_ratio = 0.25;
    expect(validateArtifact(data, 'collapsed_manifest').ok).toBe(true);
  });

  test('float rejects strings', () => {
    const data = makeCollapsedManifest();
    (
      (data as { stats: Record<string, unknown> }).stats as { compression_ratio: unknown }
    ).compression_ratio = 'half';
    const r = validateArtifact(data, 'collapsed_manifest');
    expect(r.errors).toContain('stats.compression_ratio: expected float, got str');
  });

  test('type-mismatch short-circuits deeper checks', () => {
    // If modules is a string, we must not get nested-field errors beneath it.
    const data = makeStructuralMap();
    (data as { modules: unknown }).modules = 'not a list';
    const r = validateArtifact(data, 'structural_map');
    const nested = r.errors.filter((e) => e.startsWith('modules['));
    expect(nested).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Enum violations (Python-style formatting)
// ---------------------------------------------------------------------------

describe('validateArtifact — enum violations', () => {
  test('risk enum (triage_card)', () => {
    const data = makeTriageCard();
    (data as { risk: unknown }).risk = 'extreme';
    const r = validateArtifact(data, 'triage_card');
    expect(r.errors).toContain(
      "risk: expected one of ['critical', 'high', 'medium', 'low'], got 'extreme'",
    );
  });

  test('generated_by enum', () => {
    const data = makeStructuralMap();
    (data as { generated_by: unknown }).generated_by = 'manual';
    const r = validateArtifact(data, 'structural_map');
    expect(r.errors).toContain(
      "generated_by: expected one of ['deterministic', 'annotated'], got 'manual'",
    );
  });

  test('dependency edge type enum uses nested path', () => {
    const data = makeStructuralMap();
    (
      (data as { dependency_edges: unknown[] }).dependency_edges[0] as {
        type: unknown;
      }
    ).type = 'cross-module';
    const r = validateArtifact(data, 'structural_map');
    expect(r.errors).toContain(
      "dependency_edges[0].type: expected one of ['internal', 'external'], got 'cross-module'",
    );
  });

  test('finding severity inside findings_batch', () => {
    const data = makeFindingsBatch();
    ((data as { findings: unknown[] }).findings[0] as { severity: unknown }).severity = 'minor';
    const r = validateArtifact(data, 'findings_batch');
    expect(r.errors).toContain(
      "findings[0].severity: expected one of ['critical', 'important', 'improvement'], got 'minor'",
    );
  });

  test('finding category inside triage_card', () => {
    const data = makeTriageCard();
    ((data as { findings: unknown[] }).findings[0] as { category: unknown }).category = 'style';
    const r = validateArtifact(data, 'triage_card');
    expect(r.errors).toContain(
      "findings[0].category: expected one of ['error_handling', 'invariant', 'contract', 'side_effect', 'dependency', 'performance', 'naming', 'dead_code'], got 'style'",
    );
  });

  test('question_type inside triage_card.questions[]', () => {
    const data = makeTriageCard();
    ((data as { questions: unknown[] }).questions[0] as { question_type: unknown }).question_type =
      'unknown';
    const r = validateArtifact(data, 'triage_card');
    expect(r.errors).toContain(
      "questions[0].question_type: expected one of ['error_handling', 'invariant', 'contract', 'side_effect', 'dependency'], got 'unknown'",
    );
  });

  test('clean-bill enforces risk="low" and status="clean"', () => {
    const data = makeTriageCardClean();
    (data as { risk: unknown }).risk = 'medium';
    (data as { status: unknown }).status = 'dirty';
    const r = validateArtifact(data, 'triage_card_clean');
    expect(r.errors).toContain("risk: expected one of ['low'], got 'medium'");
    expect(r.errors).toContain("status: expected one of ['clean'], got 'dirty'");
  });
});

// ---------------------------------------------------------------------------
// Nested list/dict traversal
// ---------------------------------------------------------------------------

describe('validateArtifact — nested traversal', () => {
  test('list item field missing surfaces under [index].field', () => {
    const data = makeStructuralMap();
    const firstModule = (data.modules as Record<string, unknown>[])[0];
    if (firstModule !== undefined) Reflect.deleteProperty(firstModule, 'path');
    const r = validateArtifact(data, 'structural_map');
    expect(r.errors).toContain('modules[0].path: required field is missing');
  });

  test('list item wrong scalar type flagged at [index]', () => {
    const data = makeTriageCard();
    ((data as { findings: unknown[] }).findings[0] as { line_range: unknown }).line_range = [
      'a',
      'b',
    ];
    const r = validateArtifact(data, 'triage_card');
    expect(r.errors).toContain('findings[0].line_range[0]: expected int, got str');
    expect(r.errors).toContain('findings[0].line_range[1]: expected int, got str');
  });

  test('deeply nested: collapsed_summaries[0].files[0] type check', () => {
    const data = makeCollapsedManifest();
    (
      (data as { collapsed_summaries: unknown[] }).collapsed_summaries[0] as {
        files: unknown;
      }
    ).files = [1, 2];
    const r = validateArtifact(data, 'collapsed_manifest');
    expect(r.errors).toContain('collapsed_summaries[0].files[0]: expected str, got int');
  });
});

// ---------------------------------------------------------------------------
// Registry + input shape
// ---------------------------------------------------------------------------

describe('SCHEMA_REGISTRY', () => {
  test('registers all 8 keys', () => {
    expect(Object.keys(SCHEMA_REGISTRY).sort()).toEqual([
      'batch_definition',
      'collapsed_manifest',
      'findings_batch',
      'pipeline_status',
      'structural_map',
      'triage_card',
      'triage_card_clean',
      'triage_manifest',
    ]);
  });

  test('unknown schema key returns single-error envelope', () => {
    const r = validateArtifact({}, 'nonexistent');
    expect(r.ok).toBe(false);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain('unknown schema');
    expect(r.errors[0]).toContain("'nonexistent'");
  });

  test('list input rejected with "expected dict"', () => {
    const r = validateArtifact([], 'structural_map');
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual(['expected dict, got list']);
  });

  test('string input rejected with "expected dict"', () => {
    const r = validateArtifact('hello', 'triage_card');
    expect(r.errors).toEqual(['expected dict, got str']);
  });

  test('null input rejected with "expected dict"', () => {
    const r = validateArtifact(null, 'triage_card');
    expect(r.errors).toEqual(['expected dict, got NoneType']);
  });
});

// ---------------------------------------------------------------------------
// Enum literal parity
// ---------------------------------------------------------------------------

describe('enum constants match Python source', () => {
  test('QUESTION_TYPES', () => {
    expect(QUESTION_TYPES).toEqual([
      'error_handling',
      'invariant',
      'contract',
      'side_effect',
      'dependency',
    ]);
  });

  test('FINDING_CATEGORIES', () => {
    expect(FINDING_CATEGORIES).toEqual([
      'error_handling',
      'invariant',
      'contract',
      'side_effect',
      'dependency',
      'performance',
      'naming',
      'dead_code',
    ]);
  });

  test('RISK_LEVELS', () => {
    expect(RISK_LEVELS).toEqual(['critical', 'high', 'medium', 'low']);
  });

  test('COMPLEXITY_LEVELS', () => {
    expect(COMPLEXITY_LEVELS).toEqual(['high', 'medium', 'low']);
  });

  test('GENERATED_BY', () => {
    expect(GENERATED_BY).toEqual(['deterministic', 'annotated']);
  });

  test('EDGE_TYPES', () => {
    expect(EDGE_TYPES).toEqual(['internal', 'external']);
  });

  test('BATCH_FINDING_SEVERITIES', () => {
    expect(BATCH_FINDING_SEVERITIES).toEqual(['critical', 'important', 'improvement']);
  });

  test('BATCH_FINDING_CATEGORIES', () => {
    expect(BATCH_FINDING_CATEGORIES).toEqual([
      'structural',
      'abstraction',
      'naming',
      'error_handling',
      'performance',
      'hygiene',
    ]);
  });

  test('ANSWER_STATUSES', () => {
    expect(ANSWER_STATUSES).toEqual(['answered', 'deferred', 'not_applicable']);
  });
});

// ---------------------------------------------------------------------------
// Parity fixtures captured from Python reference
// ---------------------------------------------------------------------------

describe('python-captures fixtures', () => {
  const capturesDir = join(import.meta.dir, '__fixtures__/schemas/python-captures');

  if (!existsSync(capturesDir)) {
    test.skip('fixtures directory missing — run capture.sh', () => {});
    return;
  }

  const files = readdirSync(capturesDir).filter((f) => f.endsWith('.txt'));

  for (const file of files) {
    test(`parity: ${file}`, () => {
      const raw = readFileSync(join(capturesDir, file), 'utf8');
      const payload = JSON.parse(raw) as {
        schema_key: string;
        input: unknown;
        ok: boolean;
        errors: string[];
      };
      const r = validateArtifact(payload.input, payload.schema_key);
      expect(r.ok).toBe(payload.ok);
      expect(r.errors).toEqual(payload.errors);
    });
  }
});
