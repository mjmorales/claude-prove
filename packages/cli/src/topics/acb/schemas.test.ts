/**
 * Schema + validator tests for ACB manifests and review state.
 *
 * Ports `tools/acb/test_schemas.py` plus parity fixtures under
 * `__fixtures__/schemas/python-captures/` that pin error strings to the
 * Python source byte-for-byte.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  AMBIGUITY_TAGS,
  ANNOTATION_TYPES,
  CLASSIFICATIONS,
  CURRENT_ACB_VERSION,
  CURRENT_MANIFEST_VERSION,
  NEGATIVE_SPACE_REASONS,
  OVERALL_VERDICTS,
  VERDICT_VALUES,
  validateManifest,
  validateReviewState,
} from './schemas';

// ---------------------------------------------------------------------------
// Fixture builders — mirror `tools/acb/test_schemas.py` helpers
// ---------------------------------------------------------------------------

function makeMinimalManifest(): Record<string, unknown> {
  return {
    acb_manifest_version: '0.2',
    commit_sha: 'abc1234',
    timestamp: '2026-03-29T12:00:00Z',
    intent_groups: [
      {
        id: 'feat-auth',
        title: 'Add authentication',
        classification: 'explicit',
        file_refs: [{ path: 'src/auth.py', ranges: ['1-50'] }],
        annotations: [],
      },
    ],
  };
}

function makeMinimalReview(): Record<string, unknown> {
  return {
    acb_version: '0.2',
    acb_hash: 'deadbeef',
    acb_id: 'test-id',
    group_verdicts: [{ group_id: 'feat-auth', verdict: 'pending' }],
    overall_verdict: 'pending',
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('version constants', () => {
  test('CURRENT_MANIFEST_VERSION matches tools/acb/schemas.py', () => {
    expect(CURRENT_MANIFEST_VERSION).toBe('0.2');
  });

  test('CURRENT_ACB_VERSION matches tools/acb/schemas.py', () => {
    expect(CURRENT_ACB_VERSION).toBe('0.2');
  });
});

describe('enum tuples', () => {
  test('CLASSIFICATIONS', () => {
    expect(CLASSIFICATIONS).toEqual(['explicit', 'inferred', 'speculative']);
  });

  test('AMBIGUITY_TAGS', () => {
    expect(AMBIGUITY_TAGS).toEqual([
      'underspecified',
      'conflicting_signals',
      'assumption',
      'scope_creep',
      'convention',
    ]);
  });

  test('ANNOTATION_TYPES', () => {
    expect(ANNOTATION_TYPES).toEqual(['judgment_call', 'note', 'flag']);
  });

  test('NEGATIVE_SPACE_REASONS', () => {
    expect(NEGATIVE_SPACE_REASONS).toEqual([
      'out_of_scope',
      'possible_other_callers',
      'intentionally_preserved',
      'would_require_escalation',
    ]);
  });

  test('VERDICT_VALUES', () => {
    expect(VERDICT_VALUES).toEqual([
      'accepted',
      'rejected',
      'needs_discussion',
      'pending',
      'rework',
    ]);
  });

  test('OVERALL_VERDICTS', () => {
    expect(OVERALL_VERDICTS).toEqual(['approved', 'changes_requested', 'pending']);
  });
});

// ---------------------------------------------------------------------------
// validateManifest
// ---------------------------------------------------------------------------

describe('validateManifest', () => {
  test('valid manifest returns no errors', () => {
    expect(validateManifest(makeMinimalManifest())).toEqual([]);
  });

  test('non-object input: null', () => {
    expect(validateManifest(null)).toEqual(['Manifest must be a JSON object']);
  });

  test('non-object input: string', () => {
    expect(validateManifest('string')).toEqual(['Manifest must be a JSON object']);
  });

  test('non-object input: number', () => {
    expect(validateManifest(123)).toEqual(['Manifest must be a JSON object']);
  });

  test('non-object input: array', () => {
    expect(validateManifest([])).toEqual(['Manifest must be a JSON object']);
  });

  test('missing all required fields yields one error per field', () => {
    const errors = validateManifest({});
    expect(errors).toEqual([
      'Missing required field: acb_manifest_version',
      'Missing required field: commit_sha',
      'Missing required field: timestamp',
      'Missing required field: intent_groups',
    ]);
  });

  test('intent_groups not an array', () => {
    const m = makeMinimalManifest();
    m.intent_groups = { not: 'array' };
    expect(validateManifest(m)).toEqual(['intent_groups must be an array']);
  });

  test('empty intent_groups', () => {
    const m = makeMinimalManifest();
    m.intent_groups = [];
    expect(validateManifest(m)).toEqual(['intent_groups must not be empty']);
  });

  test('group not an object', () => {
    const m = makeMinimalManifest();
    m.intent_groups = ['nope'];
    const errors = validateManifest(m);
    expect(errors).toEqual(['intent_groups[0]: must be an object']);
  });

  test('group missing all required fields', () => {
    const m = makeMinimalManifest();
    m.intent_groups = [{}];
    const errors = validateManifest(m);
    expect(errors).toEqual([
      "intent_groups[0]: missing required field 'id'",
      "intent_groups[0]: missing required field 'title'",
      "intent_groups[0]: missing required field 'classification'",
      "intent_groups[0]: missing required field 'file_refs'",
    ]);
  });

  test('duplicate group ids', () => {
    const m = makeMinimalManifest();
    (m.intent_groups as unknown[]).push({
      id: 'feat-auth',
      title: 'Duplicate',
      classification: 'inferred',
      file_refs: [{ path: 'src/b.py' }],
    });
    const errors = validateManifest(m);
    expect(errors).toContain("intent_groups[1]: duplicate id 'feat-auth'");
  });

  test('invalid classification', () => {
    const m = makeMinimalManifest();
    const groups = m.intent_groups as Array<Record<string, unknown>>;
    groups[0] = { ...groups[0], classification: 'maybe' };
    const errors = validateManifest(m);
    expect(errors).toContain("intent_groups[0]: invalid classification 'maybe'");
  });

  test('empty file_refs', () => {
    const m = makeMinimalManifest();
    const groups = m.intent_groups as Array<Record<string, unknown>>;
    groups[0] = { ...groups[0], file_refs: [] };
    const errors = validateManifest(m);
    expect(errors).toContain('intent_groups[0]: file_refs must be a non-empty array');
  });

  test('file_refs not an array', () => {
    const m = makeMinimalManifest();
    const groups = m.intent_groups as Array<Record<string, unknown>>;
    groups[0] = { ...groups[0], file_refs: 'nope' };
    const errors = validateManifest(m);
    expect(errors).toContain('intent_groups[0]: file_refs must be a non-empty array');
  });

  test('accumulates errors — does not short-circuit', () => {
    const errors = validateManifest({
      intent_groups: [
        {
          id: 'x',
          title: 't',
          classification: 'bogus',
          file_refs: [],
        },
      ],
    });
    // 3 missing top-level + invalid classification + empty file_refs = 5 errors
    expect(errors.length).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// validateReviewState
// ---------------------------------------------------------------------------

describe('validateReviewState', () => {
  test('valid review state returns no errors', () => {
    expect(validateReviewState(makeMinimalReview())).toEqual([]);
  });

  test('non-object input: null', () => {
    expect(validateReviewState(null)).toEqual(['Review state must be a JSON object']);
  });

  test('non-object input: array', () => {
    expect(validateReviewState([])).toEqual(['Review state must be a JSON object']);
  });

  test('missing all required fields yields one error per field', () => {
    const errors = validateReviewState({});
    expect(errors).toEqual([
      'Missing required field: acb_version',
      'Missing required field: acb_hash',
      'Missing required field: acb_id',
      'Missing required field: group_verdicts',
      'Missing required field: overall_verdict',
    ]);
  });

  test('invalid verdict', () => {
    const r = makeMinimalReview();
    const verdicts = r.group_verdicts as Array<Record<string, unknown>>;
    verdicts[0] = { ...verdicts[0], verdict: 'maybe' };
    const errors = validateReviewState(r);
    expect(errors).toContain("group_verdicts[0]: invalid verdict 'maybe'");
  });

  test('invalid overall_verdict', () => {
    const r = makeMinimalReview();
    r.overall_verdict = 'dunno';
    const errors = validateReviewState(r);
    expect(errors).toContain("Invalid overall_verdict: 'dunno'");
  });

  test('missing group_id', () => {
    const r = makeMinimalReview();
    r.group_verdicts = [{ verdict: 'accepted' }];
    const errors = validateReviewState(r);
    expect(errors).toContain('group_verdicts[0]: missing group_id');
  });

  test('missing verdict', () => {
    const r = makeMinimalReview();
    r.group_verdicts = [{ group_id: 'g' }];
    const errors = validateReviewState(r);
    expect(errors).toContain('group_verdicts[0]: missing verdict');
  });

  test('group_verdicts not an array', () => {
    const r = makeMinimalReview();
    r.group_verdicts = { not: 'array' };
    const errors = validateReviewState(r);
    expect(errors).toContain('group_verdicts must be an array');
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
        validator: 'manifest' | 'review_state';
        input: unknown;
        errors: string[];
      };
      const actual =
        payload.validator === 'manifest'
          ? validateManifest(payload.input)
          : validateReviewState(payload.input);
      expect(actual).toEqual(payload.errors);
    });
  }
});
