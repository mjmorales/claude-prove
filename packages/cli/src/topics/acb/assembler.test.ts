/**
 * Tests for `acb/assembler.ts` — merge logic, dedup rules, and hash parity.
 *
 * Ports every case in `tools/acb/test_assembler.py` plus adds byte-parity
 * fixtures against the Python reference (`__fixtures__/assembler/python-
 * captures/`). Each test opens a fresh `:memory:` AcbStore via
 * `openAcbStore` so registry migrations run end-to-end.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  AGENT_ID,
  type AcbDocument,
  type IntentGroup,
  assemble,
  collectNegativeSpace,
  collectOpenQuestions,
  computeAcbHash,
  detectUncoveredFiles,
  loadManifestsFromStore,
  mergeIntentGroups,
} from './assembler';
import { type AcbStore, ensureAcbSchemaRegistered, openAcbStore } from './store';

// ---------------------------------------------------------------------------
// Fixture builders — mirror `tools/acb/test_assembler.py` helpers
// ---------------------------------------------------------------------------

type Manifest = Record<string, unknown>;
type Group = Record<string, unknown>;

interface ManifestOverrides {
  negative_space?: unknown;
  open_questions?: unknown;
}

function makeManifest(sha: string, groups: Group[], overrides: ManifestOverrides = {}): Manifest {
  return {
    acb_manifest_version: '0.2',
    commit_sha: sha,
    timestamp: `2026-03-29T12:0${sha}:00Z`,
    intent_groups: groups,
    ...overrides,
  };
}

interface GroupOverrides {
  classification?: string;
  annotations?: Array<Record<string, unknown>>;
  ambiguity_tags?: string[];
  ranges?: Record<string, string[]>;
  task_grounding?: string;
}

function makeGroup(gid: string, files: string[], overrides: GroupOverrides = {}): Group {
  const ranges = overrides.ranges ?? {};
  const fileRefs = files.map((f) => {
    const ref: Record<string, unknown> = { path: f };
    if (ranges[f]) ref.ranges = [...ranges[f]];
    return ref;
  });
  const group: Group = {
    id: gid,
    title: gid.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    classification: overrides.classification ?? 'explicit',
    file_refs: fileRefs,
    annotations: overrides.annotations ?? [],
    ambiguity_tags: overrides.ambiguity_tags ?? [],
  };
  if (overrides.task_grounding !== undefined) group.task_grounding = overrides.task_grounding;
  return group;
}

// ---------------------------------------------------------------------------
// loadManifestsFromStore
// ---------------------------------------------------------------------------

describe('loadManifestsFromStore', () => {
  let store: AcbStore;

  beforeEach(() => {
    ensureAcbSchemaRegistered();
    store = openAcbStore({ path: ':memory:' });
  });

  afterEach(() => {
    store.close();
  });

  test('loads valid manifests', () => {
    const m = makeManifest('0', [makeGroup('g1', ['a.py'])]);
    store.saveManifest('feat/x', 'abc', m);
    const result = loadManifestsFromStore(store, 'feat/x');
    expect(result.length).toBe(1);
  });

  test('skips invalid manifest (empty intent_groups)', () => {
    store.saveManifest('feat/x', 'abc', {
      acb_manifest_version: '0.2',
      commit_sha: 'abc',
      timestamp: '2026-01-01T00:00:00Z',
      intent_groups: [],
    });
    const result = loadManifestsFromStore(store, 'feat/x');
    expect(result).toEqual([]);
  });

  test('sorts manifests by timestamp (store-level ORDER BY)', () => {
    const m1 = makeManifest('2', [makeGroup('g1', ['a.py'])]);
    const m2 = makeManifest('1', [makeGroup('g2', ['b.py'])]);
    store.saveManifest('feat/x', 'sha2', m1);
    store.saveManifest('feat/x', 'sha1', m2);
    const result = loadManifestsFromStore(store, 'feat/x');
    expect(result[0]?.commit_sha).toBe('1');
    expect(result[1]?.commit_sha).toBe('2');
  });

  test('branch isolation — only requested branch is returned', () => {
    store.saveManifest('feat/x', 'abc', makeManifest('0', [makeGroup('g1', ['a.py'])]));
    store.saveManifest('feat/y', 'def', makeManifest('1', [makeGroup('g2', ['b.py'])]));
    const result = loadManifestsFromStore(store, 'feat/x');
    expect(result.length).toBe(1);
    expect(result[0]?.commit_sha).toBe('0');
  });
});

// ---------------------------------------------------------------------------
// mergeIntentGroups
// ---------------------------------------------------------------------------

describe('mergeIntentGroups', () => {
  test('distinct ids produce distinct groups', () => {
    const manifests = [
      makeManifest('0', [makeGroup('g1', ['a.py'])]),
      makeManifest('1', [makeGroup('g2', ['b.py'])]),
    ];
    const merged = mergeIntentGroups(manifests);
    expect(merged.length).toBe(2);
    expect(merged.map((g) => g.id)).toEqual(['g1', 'g2']);
  });

  test('same id merges file_refs by path', () => {
    const manifests = [
      makeManifest('0', [makeGroup('g1', ['a.py'])]),
      makeManifest('1', [makeGroup('g1', ['b.py'])]),
    ];
    const merged = mergeIntentGroups(manifests);
    expect(merged.length).toBe(1);
    const paths = new Set(merged[0]?.file_refs.map((r) => r.path));
    expect(paths).toEqual(new Set(['a.py', 'b.py']));
  });

  test('same id + same path merges ranges, preserving order and dedup', () => {
    const manifests = [
      makeManifest('0', [makeGroup('g1', ['a.py'], { ranges: { 'a.py': ['1-10'] } })]),
      makeManifest('1', [makeGroup('g1', ['a.py'], { ranges: { 'a.py': ['1-10', '20-30'] } })]),
    ];
    const merged = mergeIntentGroups(manifests);
    expect(merged.length).toBe(1);
    expect(merged[0]?.file_refs.length).toBe(1);
    expect(merged[0]?.file_refs[0]?.ranges).toEqual(['1-10', '20-30']);
  });

  test('deduplicates annotations by id (first wins)', () => {
    const ann = { id: 'ann-1', type: 'note', body: 'test' };
    const manifests = [
      makeManifest('0', [makeGroup('g1', ['a.py'], { annotations: [ann] })]),
      makeManifest('1', [makeGroup('g1', ['a.py'], { annotations: [ann] })]),
    ];
    const merged = mergeIntentGroups(manifests);
    expect(merged[0]?.annotations.length).toBe(1);
  });

  test('unions ambiguity_tags preserving insertion order', () => {
    const manifests = [
      makeManifest('0', [makeGroup('g1', ['a.py'], { ambiguity_tags: ['assumption'] })]),
      makeManifest('1', [
        makeGroup('g1', ['a.py'], { ambiguity_tags: ['scope_creep', 'assumption'] }),
      ]),
    ];
    const merged = mergeIntentGroups(manifests);
    const tags = merged[0]?.ambiguity_tags ?? [];
    expect(new Set(tags)).toEqual(new Set(['assumption', 'scope_creep']));
    expect(tags.length).toBe(2);
    // Insertion order: first-seen wins.
    expect(tags[0]).toBe('assumption');
    expect(tags[1]).toBe('scope_creep');
  });

  test('first-seen metadata (title, classification, task_grounding) wins', () => {
    const manifests = [
      makeManifest('0', [
        makeGroup('g1', ['a.py'], { classification: 'explicit', task_grounding: 'first' }),
      ]),
      makeManifest('1', [
        makeGroup('g1', ['b.py'], { classification: 'inferred', task_grounding: 'second' }),
      ]),
    ];
    const merged = mergeIntentGroups(manifests);
    expect(merged[0]?.classification).toBe('explicit');
    expect(merged[0]?.task_grounding).toBe('first');
  });
});

// ---------------------------------------------------------------------------
// collectNegativeSpace
// ---------------------------------------------------------------------------

describe('collectNegativeSpace', () => {
  test('deduplicates by path — first wins', () => {
    const manifests = [
      makeManifest('0', [makeGroup('g1', ['a.py'])], {
        negative_space: [{ path: 'x.py', reason: 'out_of_scope' }],
      }),
      makeManifest('1', [makeGroup('g2', ['b.py'])], {
        negative_space: [
          { path: 'x.py', reason: 'out_of_scope' },
          { path: 'y.py', reason: 'intentionally_preserved' },
        ],
      }),
    ];
    const result = collectNegativeSpace(manifests);
    expect(result.length).toBe(2);
    expect(result.map((e) => e.path)).toEqual(['x.py', 'y.py']);
  });
});

// ---------------------------------------------------------------------------
// collectOpenQuestions
// ---------------------------------------------------------------------------

describe('collectOpenQuestions', () => {
  test('deduplicates by id — first wins', () => {
    const manifests = [
      makeManifest('0', [makeGroup('g1', ['a.py'])], {
        open_questions: [{ id: 'q1', body: 'What about X?' }],
      }),
      makeManifest('1', [makeGroup('g2', ['b.py'])], {
        open_questions: [
          { id: 'q1', body: 'What about X?' },
          { id: 'q2', body: 'And Y?' },
        ],
      }),
    ];
    const result = collectOpenQuestions(manifests);
    expect(result.length).toBe(2);
    expect(result.map((q) => q.id)).toEqual(['q1', 'q2']);
  });
});

// ---------------------------------------------------------------------------
// detectUncoveredFiles
// ---------------------------------------------------------------------------

describe('detectUncoveredFiles', () => {
  test('all covered → []', () => {
    const groups = [mergeIntentGroups([makeManifest('0', [makeGroup('g1', ['a.py', 'b.py'])])])[0]];
    const result = detectUncoveredFiles(groups as IntentGroup[], ['a.py', 'b.py']);
    expect(result).toEqual([]);
  });

  test('partial coverage → missing files returned in diff order', () => {
    const groups = [mergeIntentGroups([makeManifest('0', [makeGroup('g1', ['a.py'])])])[0]];
    const result = detectUncoveredFiles(groups as IntentGroup[], ['a.py', 'b.py', 'c.py']);
    expect(result).toEqual(['b.py', 'c.py']);
  });

  test('empty diff → []', () => {
    expect(detectUncoveredFiles([], [])).toEqual([]);
  });

  test('no groups + non-empty diff → every diff file is uncovered', () => {
    expect(detectUncoveredFiles([], ['a.py', 'b.py'])).toEqual(['a.py', 'b.py']);
  });
});

// ---------------------------------------------------------------------------
// computeAcbHash
// ---------------------------------------------------------------------------

describe('computeAcbHash', () => {
  test('is deterministic for equal inputs', () => {
    const acb = { id: 'test', intent_groups: [] };
    expect(computeAcbHash(acb)).toBe(computeAcbHash(acb));
  });

  test('different content → different hash', () => {
    expect(computeAcbHash({ id: 'a' })).not.toBe(computeAcbHash({ id: 'b' }));
  });

  test('stable across key insertion order (sort-keys serializer)', () => {
    // Build two objects with the same fields inserted in different orders.
    // JS objects preserve insertion order; a naive JSON.stringify would
    // yield different bytes, but computeAcbHash must sort keys.
    const a: Record<string, unknown> = {};
    a.b = 1;
    a.a = 2;
    a.c = [{ y: 1, x: 2 }];

    const b: Record<string, unknown> = {};
    b.c = [{ x: 2, y: 1 }];
    b.a = 2;
    b.b = 1;

    expect(computeAcbHash(a)).toBe(computeAcbHash(b));
  });

  test('array order is NOT sorted — positional semantics preserved', () => {
    const forward = { items: [1, 2, 3] };
    const reverse = { items: [3, 2, 1] };
    expect(computeAcbHash(forward)).not.toBe(computeAcbHash(reverse));
  });
});

// ---------------------------------------------------------------------------
// assemble — end-to-end composition
// ---------------------------------------------------------------------------

describe('assemble', () => {
  let store: AcbStore;

  beforeEach(() => {
    ensureAcbSchemaRegistered();
    store = openAcbStore({ path: ':memory:' });
  });

  afterEach(() => {
    store.close();
  });

  test('produces a full ACB document with every expected field', () => {
    store.saveManifest(
      'feat/x',
      'sha1',
      makeManifest('0', [makeGroup('g1', ['a.py'], { ranges: { 'a.py': ['1-10'] } })]),
    );
    store.saveManifest(
      'feat/x',
      'sha2',
      makeManifest('1', [makeGroup('g1', ['a.py'], { ranges: { 'a.py': ['20-30'] } })]),
    );

    const doc: AcbDocument = assemble({ store, branch: 'feat/x', baseRef: 'main' });

    expect(doc.acb_version).toBe('0.2');
    expect(typeof doc.id).toBe('string');
    expect(doc.id.length).toBeGreaterThan(0);
    expect(doc.change_set_ref).toEqual({ base_ref: 'main', head_ref: 'HEAD' });
    expect(doc.task_statement).toEqual({ turns: [] });
    expect(doc.intent_groups.length).toBe(1);
    expect(doc.intent_groups[0]?.file_refs[0]?.ranges).toEqual(['1-10', '20-30']);
    expect(Array.isArray(doc.negative_space)).toBe(true);
    expect(Array.isArray(doc.open_questions)).toBe(true);
    expect(Array.isArray(doc.uncovered_files)).toBe(true);
    expect(typeof doc.generated_at).toBe('string');
    expect(doc.agent_id).toBe(AGENT_ID);
    expect(doc.manifest_count).toBe(2);
  });

  test('manifest_count excludes invalid manifests', () => {
    // One valid, one invalid (empty intent_groups).
    store.saveManifest('feat/x', 'sha1', makeManifest('0', [makeGroup('g1', ['a.py'])]));
    store.saveManifest('feat/x', 'sha2', {
      acb_manifest_version: '0.2',
      commit_sha: 'sha2',
      timestamp: '2026-03-29T12:01:00Z',
      intent_groups: [],
    });

    const doc = assemble({ store, branch: 'feat/x', baseRef: 'main' });
    expect(doc.manifest_count).toBe(1);
  });

  test('passes through taskStatement and headRef overrides', () => {
    store.saveManifest('feat/x', 'sha1', makeManifest('0', [makeGroup('g1', ['a.py'])]));
    const doc = assemble({
      store,
      branch: 'feat/x',
      baseRef: 'main',
      headRef: 'deadbeef',
      taskStatement: { turns: [{ role: 'user', content: 'hi' }] },
    });
    expect(doc.change_set_ref).toEqual({ base_ref: 'main', head_ref: 'deadbeef' });
    expect(doc.task_statement).toEqual({ turns: [{ role: 'user', content: 'hi' }] });
  });

  test('zero manifests → empty doc with manifest_count=0', () => {
    const doc = assemble({ store, branch: 'empty', baseRef: 'main' });
    expect(doc.manifest_count).toBe(0);
    expect(doc.intent_groups).toEqual([]);
    expect(doc.negative_space).toEqual([]);
    expect(doc.open_questions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Parity fixtures captured from Python
// ---------------------------------------------------------------------------

interface HashFixture {
  kind: 'hash';
  name: string;
  input: unknown;
  hash: string;
}

interface MergeFixture {
  kind: 'merge';
  name: string;
  manifests: Record<string, unknown>[];
  expected: unknown;
}

interface NegativeSpaceFixture {
  kind: 'negative_space';
  name: string;
  manifests: Record<string, unknown>[];
  expected: unknown;
}

type Fixture = HashFixture | MergeFixture | NegativeSpaceFixture;

describe('python-captures fixtures', () => {
  const capturesDir = join(import.meta.dir, '__fixtures__/assembler/python-captures');

  if (!existsSync(capturesDir)) {
    test.skip('fixtures directory missing — run capture.sh', () => {});
    return;
  }

  const files = readdirSync(capturesDir).filter((f) => f.endsWith('.json'));

  for (const file of files) {
    test(`parity: ${file}`, () => {
      const raw = readFileSync(join(capturesDir, file), 'utf8');
      const payload = JSON.parse(raw) as Fixture;

      if (payload.kind === 'hash') {
        expect(computeAcbHash(payload.input as Record<string, unknown>)).toBe(payload.hash);
      } else if (payload.kind === 'merge') {
        expect(mergeIntentGroups(payload.manifests)).toEqual(payload.expected as IntentGroup[]);
      } else if (payload.kind === 'negative_space') {
        expect(collectNegativeSpace(payload.manifests)).toEqual(
          payload.expected as Array<Record<string, unknown>>,
        );
      }
    });
  }
});
