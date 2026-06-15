/**
 * content-migrate.ts tests — on-demand run-content migration planner.
 *
 * Pins: version detection, content-hop selection across a lag, behind-version
 * artifact discovery, structural-only vs content-needing classification, and
 * the no-mutation / read-only invariant. The shipped registry is empty (every
 * schema bump so far is structural), so content-hop paths are exercised by
 * temporarily injecting a synthetic hop into the live registry.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONTENT_HOPS,
  type ContentHop,
  contentHopsFor,
  detectArtifactVersion,
  planContentMigration,
  planRunContentMigration,
} from './content-migrate';
import { MIGRATIONS as STRUCTURAL_MIGRATIONS, migrateRunArtifacts } from './schema-migrate';
import { CURRENT_SCHEMA_VERSION } from './schemas';

/** Read array element `i`, asserting it exists (noUncheckedIndexedAccess). */
function at<T>(arr: T[], i: number): T {
  const value = arr[i];
  if (value === undefined) throw new Error(`at: no element at index ${i}`);
  return value;
}

// --------------------------------------------------------------------------
// Fixtures — a disposable runs root with hand-written JSON artifacts.
// --------------------------------------------------------------------------

let scratch: string | null = null;

function makeScratch(): string {
  const dir = join(
    tmpdir(),
    `content-migrate-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  scratch = dir;
  return dir;
}

function writeArtifact(runDir: string, name: string, data: Record<string, unknown>): void {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, name), `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

/** Register a synthetic content hop for the duration of one test. */
function withHop(key: string, hop: ContentHop, body: () => void): void {
  CONTENT_HOPS[key] = hop;
  try {
    body();
  } finally {
    delete CONTENT_HOPS[key];
  }
}

afterEach(() => {
  if (scratch && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
  scratch = null;
});

// --------------------------------------------------------------------------
// detectArtifactVersion
// --------------------------------------------------------------------------

describe('detectArtifactVersion', () => {
  test('reads an explicit schema_version', () => {
    expect(detectArtifactVersion({ schema_version: '2' })).toBe('2');
  });

  test('treats a missing schema_version as v1', () => {
    expect(detectArtifactVersion({ kind: 'plan' })).toBe('1');
  });
});

// --------------------------------------------------------------------------
// contentHopsFor
// --------------------------------------------------------------------------

describe('contentHopsFor', () => {
  test('empty registry yields no hops (every bump is structural)', () => {
    expect(contentHopsFor('1', CURRENT_SCHEMA_VERSION, 'plan')).toEqual([]);
  });

  test('collects only hops that touch the artifact kind', () => {
    withHop('1_to_2', synthHop('1', '2', ['plan']), () => {
      expect(contentHopsFor('1', '2', 'plan')).toHaveLength(1);
      expect(contentHopsFor('1', '2', 'prd')).toEqual([]);
    });
  });

  test('walks multiple hops across a multi-version lag', () => {
    withHop('1_to_2', synthHop('1', '2', ['reasoning-log']), () => {
      withHop('2_to_3', synthHop('2', '3', ['reasoning-log']), () => {
        expect(contentHopsFor('1', '3', 'reasoning-log')).toHaveLength(2);
      });
    });
  });

  test('a lag with no matching hop returns empty', () => {
    withHop('1_to_2', synthHop('1', '2', ['state']), () => {
      expect(contentHopsFor('1', '2', 'plan')).toEqual([]);
    });
  });
});

// --------------------------------------------------------------------------
// planRunContentMigration
// --------------------------------------------------------------------------

describe('planRunContentMigration', () => {
  test('current artifacts produce no migration entries', () => {
    const runDir = join(makeScratch(), 'main', 'add-login');
    writeArtifact(runDir, 'plan.json', { schema_version: CURRENT_SCHEMA_VERSION, kind: 'plan' });
    const plan = planRunContentMigration(runDir);
    expect(plan.artifacts).toEqual([]);
  });

  test('a behind-version artifact is found and tagged with its lag', () => {
    const runDir = join(makeScratch(), 'main', 'add-login');
    writeArtifact(runDir, 'plan.json', { schema_version: '1', kind: 'plan' });
    const plan = planRunContentMigration(runDir);
    expect(plan.artifacts).toHaveLength(1);
    const a = at(plan.artifacts, 0);
    expect(a.kind).toBe('plan');
    expect(a.fromVersion).toBe('1');
    expect(a.toVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  test('a behind-version artifact with no content hop has empty hops (structural only)', () => {
    const runDir = join(makeScratch(), 'main', 'add-login');
    writeArtifact(runDir, 'plan.json', { schema_version: '1', kind: 'plan' });
    const plan = planRunContentMigration(runDir);
    expect(at(plan.artifacts, 0).hops).toEqual([]);
  });

  test('a content hop attaches to the matching behind-version artifact', () => {
    const runDir = join(makeScratch(), 'main', 'add-login');
    writeArtifact(runDir, 'plan.json', { schema_version: '1', kind: 'plan' });
    withHop('1_to_2', synthHop('1', '2', ['plan']), () => {
      withHop('2_to_3', synthHop('2', '3', ['plan']), () => {
        const plan = planRunContentMigration(runDir);
        expect(at(plan.artifacts, 0).hops).toHaveLength(2);
        expect(at(at(plan.artifacts, 0).hops, 0).instructions).toBe(
          'skills/run-migrate/assets/v1-to-v2.md',
        );
      });
    });
  });

  test('an unparseable artifact is skipped, not fatal', () => {
    const runDir = join(makeScratch(), 'main', 'add-login');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'plan.json'), '{ not json', 'utf8');
    const plan = planRunContentMigration(runDir);
    expect(plan.artifacts).toEqual([]);
  });

  test('reasoning-log dir is planned only when a hop reshapes it', () => {
    const runDir = join(makeScratch(), 'main', 'add-login');
    mkdirSync(join(runDir, 'log', 'worker'), { recursive: true });
    // No hop -> log dir is ignored.
    expect(planRunContentMigration(runDir).artifacts).toEqual([]);
    withHop('1_to_2', synthHop('1', '2', ['reasoning-log']), () => {
      const plan = planRunContentMigration(runDir);
      const log = plan.artifacts.find((a) => a.kind === 'reasoning-log');
      expect(log).toBeDefined();
      expect(log?.hops).toHaveLength(1);
    });
  });

  test('a behind-version artifact with NO structural path and NO content hop is NOT listed', () => {
    const runDir = join(makeScratch(), 'main', 'add-login');
    // v3 plan.json, but with the 3_to_4 structural hop removed AND no content
    // hop registered: the lag is unmigratable by either surface, so the
    // planner must not report it (otherwise it disagrees with `migrate`, which
    // would process zero such artifacts).
    writeArtifact(runDir, 'plan.json', { schema_version: '3', kind: 'plan' });
    withoutStructuralHop('3_to_4', () => {
      const plan = planRunContentMigration(runDir);
      expect(plan.artifacts).toEqual([]);
    });
  });
});

// --------------------------------------------------------------------------
// planContentMigration (multi-run sweep)
// --------------------------------------------------------------------------

describe('planContentMigration', () => {
  test('counts behind vs content-needing across runs', () => {
    const root = makeScratch();
    const runA = join(root, 'main', 'a');
    const runB = join(root, 'feat', 'b');
    writeArtifact(runA, 'plan.json', { schema_version: '1', kind: 'plan' });
    writeArtifact(runB, 'plan.json', { schema_version: CURRENT_SCHEMA_VERSION, kind: 'plan' });
    writeArtifact(runB, 'prd.json', { schema_version: '1', kind: 'prd' });

    withHop('1_to_2', synthHop('1', '2', ['plan']), () => {
      withHop('2_to_3', synthHop('2', '3', ['plan']), () => {
        const plan = planContentMigration([runA, runB]);
        // runA plan (behind+content) and runB prd (behind, structural only).
        expect(plan.artifactsBehind).toBe(2);
        expect(plan.artifactsNeedingContent).toBe(1);
        expect(plan.runs).toHaveLength(2);
      });
    });
  });

  test('all-current runs yield an empty plan', () => {
    const root = makeScratch();
    const runA = join(root, 'main', 'a');
    writeArtifact(runA, 'plan.json', { schema_version: CURRENT_SCHEMA_VERSION, kind: 'plan' });
    const plan = planContentMigration([runA]);
    expect(plan.runs).toEqual([]);
    expect(plan.artifactsBehind).toBe(0);
    expect(plan.artifactsNeedingContent).toBe(0);
  });

  test('does not mutate the artifact on disk (read-only planner)', () => {
    const root = makeScratch();
    const runA = join(root, 'main', 'a');
    const original = { schema_version: '1', kind: 'plan', tasks: [{ id: '1.1' }] };
    writeArtifact(runA, 'plan.json', original);
    planContentMigration([runA]);
    const after = JSON.parse(readFileSync(join(runA, 'plan.json'), 'utf8'));
    expect(after).toEqual(original);
  });
});

// --------------------------------------------------------------------------
// Cross-surface agreement — `migrate` and `migrate-runs` never disagree on the
// same artifact. A v3 plan.json is either migrated to v4 by the structural
// sweep, or it is not listed by the content planner.
// --------------------------------------------------------------------------

describe('migrate / migrate-runs agreement on a v3 plan.json', () => {
  test('a v3 plan.json IS migrated to v4 by the structural sweep AND listed by the planner', () => {
    const runDir = join(makeScratch(), 'main', 'add-login');
    writeArtifact(runDir, 'plan.json', { schema_version: '3', kind: 'plan', tasks: [] });

    // migrate-runs lists it (a structural hop applies, even with no content hop).
    const listed = planRunContentMigration(runDir);
    expect(listed.artifacts).toHaveLength(1);
    expect(at(listed.artifacts, 0).fromVersion).toBe('3');
    expect(at(listed.artifacts, 0).toVersion).toBe('4');
    expect(at(listed.artifacts, 0).hops).toEqual([]);

    // migrate (structural sweep) actually advances it to v4.
    const result = migrateRunArtifacts(runDir);
    expect(result.bumped).toEqual(['plan.json']);
    const after = JSON.parse(readFileSync(join(runDir, 'plan.json'), 'utf8'));
    expect(after.schema_version).toBe('4');

    // After the bump it is current — the planner no longer lists it.
    expect(planRunContentMigration(runDir).artifacts).toEqual([]);
  });

  test('an unmigratable v3 plan.json is processed by neither surface', () => {
    const runDir = join(makeScratch(), 'main', 'add-login');
    writeArtifact(runDir, 'plan.json', { schema_version: '3', kind: 'plan', tasks: [] });
    withoutStructuralHop('3_to_4', () => {
      // migrate-runs does not list it (no hop applies).
      expect(planRunContentMigration(runDir).artifacts).toEqual([]);
      // migrate does not bump it (planMigration finds no hop -> no change).
      expect(migrateRunArtifacts(runDir).bumped).toEqual([]);
      const after = JSON.parse(readFileSync(join(runDir, 'plan.json'), 'utf8'));
      expect(after.schema_version).toBe('3');
    });
  });
});

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/** Remove a structural hop for the duration of one test, then restore it. */
function withoutStructuralHop(key: string, body: () => void): void {
  const saved = STRUCTURAL_MIGRATIONS[key];
  delete STRUCTURAL_MIGRATIONS[key];
  try {
    body();
  } finally {
    if (saved) STRUCTURAL_MIGRATIONS[key] = saved;
  }
}

function synthHop(from: string, to: string, kinds: ContentHop['kinds']): ContentHop {
  return {
    from,
    to,
    kinds,
    instructions: `skills/run-migrate/assets/v${from}-to-v${to}.md`,
    summary: `reshape ${kinds.join('/')} content for v${from} -> v${to}`,
  };
}
