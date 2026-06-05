/**
 * Schema-version migration chain for run-state JSON artifacts (plan.json
 * etc.). Distinct from `migrate.ts`, which converts the legacy markdown
 * layout (PRD.md/TASK_PLAN.md) into the JSON-first shape. This module hops a
 * single already-JSON artifact forward across `schema_version` bumps.
 *
 * Mirrors the registry pattern in `topics/schema/migrate.ts`:
 *   - one `_migrate_vN_to_vM(data)` per hop, target version HARDCODED
 *   - `MIGRATIONS` map keyed `"<from>_to_<to>"`
 *   - `planMigration` walks sequentially to CURRENT_SCHEMA_VERSION
 *
 * Migration functions are frozen-in-time: NEVER reference
 * CURRENT_SCHEMA_VERSION inside a hop — a later version bump must not
 * retroactively change what an earlier migration does.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CURRENT_SCHEMA_VERSION } from './schemas';
import { writeJsonAtomic } from './state';

/** Parsed run-state artifact; migrations mutate a shallow clone. */
export type ArtifactData = Record<string, unknown>;

/** A single change in a migration plan, rendered by the CLI runner. */
export interface MigrationChange {
  path: string;
  description: string;
}

/** Signature for every entry in the `MIGRATIONS` registry. */
export type MigrationFn = (data: ArtifactData) => [ArtifactData, MigrationChange[]];

/**
 * Detect the schema version of an artifact. Returns `"1"` for artifacts with
 * no `schema_version` — the first versioned run-state schema was v1, so a
 * pre-version artifact is treated as v1 rather than v0.
 */
export function detectVersion(data: ArtifactData): string {
  const v = data.schema_version;
  return typeof v === 'string' ? v : '1';
}

/**
 * v1 -> v2: bump schema_version. The v2 plan.json schema added an OPTIONAL
 * `tasks[].bounds` field; absent bounds means unbounded (the v1 behavior), so
 * no field is injected — the migration is a pure version bump. Every other
 * field passes through byte-for-byte.
 *
 * Hardcodes target version '2'. Do NOT reference CURRENT_SCHEMA_VERSION.
 */
function migrateV1ToV2(data: ArtifactData): [ArtifactData, MigrationChange[]] {
  const result: ArtifactData = { ...data, schema_version: '2' };
  const changes: MigrationChange[] = [
    {
      path: 'schema_version',
      description:
        '"1" -> "2" (tasks[].bounds added as optional — absent bounds preserves current behavior)',
    },
  ];
  return [result, changes];
}

/**
 * v2 -> v3: bump schema_version and convert every plan-task/step
 * `acceptance_criteria` STRING into the v3 structured criterion `{ text }`.
 * The v3 plan.json schema changed the list items from bare strings to a
 * criterion dict (text required; verifies_by/check/idempotent/status/...
 * optional). A legacy string carries only the statement, so it becomes the
 * structured `text` — no data loss, no injected fields. Already-structured
 * items (objects) pass through untouched, so re-running is a no-op on v3 data.
 *
 * Non-plan kinds (prd/state/report) have no plan-task acceptance_criteria, so
 * for them this hop is a pure version bump (the shared-version cascade).
 *
 * Hardcodes target version '3'. Do NOT reference CURRENT_SCHEMA_VERSION.
 */
function migrateV2ToV3(data: ArtifactData): [ArtifactData, MigrationChange[]] {
  const result: ArtifactData = { ...data, schema_version: '3' };
  const changes: MigrationChange[] = [
    {
      path: 'schema_version',
      description:
        '"2" -> "3" (tasks[]/steps[].acceptance_criteria items: string -> { text } structured criterion)',
    },
  ];

  const tasks = result.tasks;
  if (Array.isArray(tasks)) {
    let converted = 0;
    result.tasks = tasks.map((task) => {
      if (task === null || typeof task !== 'object') return task;
      const t = { ...(task as Record<string, unknown>) };
      converted += structureCriteria(t);
      const steps = t.steps;
      if (Array.isArray(steps)) {
        t.steps = steps.map((step) => {
          if (step === null || typeof step !== 'object') return step;
          const s = { ...(step as Record<string, unknown>) };
          converted += structureCriteria(s);
          return s;
        });
      }
      return t;
    });
    if (converted > 0) {
      changes.push({
        path: 'tasks[].acceptance_criteria',
        description: `${converted} string criterion(s) wrapped as { text }`,
      });
    }
  }

  return [result, changes];
}

/**
 * In-place rewrite of `node.acceptance_criteria`: every string item becomes
 * `{ text: <string> }`; objects pass through. Returns the count of strings
 * converted so the caller can describe the migration.
 */
function structureCriteria(node: Record<string, unknown>): number {
  const list = node.acceptance_criteria;
  if (!Array.isArray(list)) return 0;
  let converted = 0;
  node.acceptance_criteria = list.map((item) => {
    if (typeof item === 'string') {
      converted += 1;
      return { text: item };
    }
    return item;
  });
  return converted;
}

/**
 * v3 -> v4: bump schema_version. The v4 plan.json schema added an OPTIONAL
 * `tasks[].execution` block (retry/loop/fanout/on_fail/concurrency directives);
 * absent execution means run-once/no-retry/halt-on-fail/parallel (the v3
 * behavior), so no field is injected — the migration is a pure version bump.
 * Every other field passes through byte-for-byte.
 *
 * Hardcodes target version '4'. Do NOT reference CURRENT_SCHEMA_VERSION.
 */
function migrateV3ToV4(data: ArtifactData): [ArtifactData, MigrationChange[]] {
  const result: ArtifactData = { ...data, schema_version: '4' };
  const changes: MigrationChange[] = [
    {
      path: 'schema_version',
      description:
        '"3" -> "4" (tasks[].execution added as optional — absent execution preserves run-once/no-retry/halt-on-fail/parallel behavior)',
    },
  ];
  return [result, changes];
}

/**
 * Migration registry. Keys are `"<from>_to_<to>"`; `planMigration` walks them
 * sequentially. Keep the ladder dense and ordered.
 */
export const MIGRATIONS: Record<string, MigrationFn> = {
  '1_to_2': migrateV1ToV2,
  '2_to_3': migrateV2ToV3,
  '3_to_4': migrateV3ToV4,
};

/**
 * Plan all hops needed to bring `data` to CURRENT_SCHEMA_VERSION. Returns
 * `[target, changes]`. When no hop exists for the next version, emits a change
 * describing the gap and stops.
 */
export function planMigration(data: ArtifactData): [ArtifactData, MigrationChange[]] {
  const currentVersion = detectVersion(data);
  let result: ArtifactData = { ...data };
  const allChanges: MigrationChange[] = [];

  if (currentVersion === CURRENT_SCHEMA_VERSION) {
    return [result, []];
  }

  let version = currentVersion;
  while (version !== CURRENT_SCHEMA_VERSION) {
    const nextVersion = String(Number.parseInt(version, 10) + 1);
    const key = `${version}_to_${nextVersion}`;
    const fn = MIGRATIONS[key];
    if (!fn) {
      allChanges.push({
        path: 'schema_version',
        description: `no migration path from v${version} to v${nextVersion}`,
      });
      break;
    }
    const [next, changes] = fn(result);
    result = next;
    allChanges.push(...changes);
    version = nextVersion;
  }

  return [result, allChanges];
}

/**
 * Whether the deterministic structural chain can advance an artifact AT ALL
 * from `from` — i.e. the first hop `<from>_to_<from+1>` is registered. This is
 * exactly when `run-state migrate` would change the artifact (it advances as
 * far as the dense prefix of the chain reaches, stopping at the first gap).
 *
 * Shared with the content planner so `migrate-runs` reports an artifact as
 * behind only when SOME migration would actually run — structural here, or a
 * content hop. Same-version (already current) is never behind, so the caller
 * gates on `from === CURRENT_SCHEMA_VERSION` before asking.
 */
export function canAdvanceStructurally(from: string): boolean {
  const next = String(Number.parseInt(from, 10) + 1);
  if (Number.isNaN(Number.parseInt(next, 10)) || next === from) return false;
  return MIGRATIONS[`${from}_to_${next}`] !== undefined;
}

// --------------------------------------------------------------------------
// JSON-first run-artifact version sweep
//
// `planMigration` above hops a single parsed artifact. The sweep below applies
// it across every JSON-first run artifact (prd.json/plan.json/state.json) under
// a runs root — the deterministic structural half of `run-state migrate`,
// distinct from the markdown->JSON converter in `migrate.ts`. A v3 plan.json
// is brought to v4 here (the `schema_version` bump), so this surface and the
// `migrate-runs` content planner agree on whether an artifact is behind.
// --------------------------------------------------------------------------

/** The JSON-first run artifacts the structural sweep version-bumps in place. */
const VERSIONED_ARTIFACTS = ['prd.json', 'plan.json', 'state.json'] as const;

/** Outcome of structurally version-bumping one run directory's artifacts. */
export interface ArtifactVersionResult {
  /** Absolute run directory path. */
  runDir: string;
  /** Artifact filenames actually bumped (a hop changed `schema_version`). */
  bumped: string[];
  /** Present when an artifact in this run could not be processed. */
  error?: string;
}

export interface MigrateArtifactsOptions {
  dryRun?: boolean;
}

/**
 * Apply the structural version chain to every JSON-first artifact in one run
 * directory. An artifact already at `CURRENT_SCHEMA_VERSION` is a no-op (no
 * write); a behind-version artifact is rewritten in place via `writeJsonAtomic`
 * unless `dryRun`. Absent artifacts are skipped — not every run holds all three.
 */
export function migrateRunArtifacts(
  runDir: string,
  opts: MigrateArtifactsOptions = {},
): ArtifactVersionResult {
  const { dryRun = false } = opts;
  const bumped: string[] = [];

  for (const name of VERSIONED_ARTIFACTS) {
    const file = join(runDir, name);
    if (!existsSync(file)) continue;
    let data: ArtifactData;
    try {
      data = JSON.parse(readFileSync(file, 'utf8')) as ArtifactData;
    } catch (e) {
      return {
        runDir,
        bumped,
        error: `${name} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    const from = detectVersion(data);
    if (from === CURRENT_SCHEMA_VERSION) continue;
    const [migrated] = planMigration(data);
    // Bump only on a real advance: `planMigration` returns a gap-describing
    // "change" without advancing the version when a hop is missing, so gate on
    // the version actually moving — not on `changes` being non-empty.
    if (detectVersion(migrated) === from) continue;
    if (!dryRun) writeJsonAtomic(file, migrated);
    bumped.push(name);
  }

  return { runDir, bumped };
}

/**
 * Walk a runs root and structurally version-bump every JSON-first run
 * directory found. A run dir is any directory holding a versioned artifact.
 * Mirrors the per-run isolation in `migrate.ts::migrateAll`: a corrupt
 * artifact in one run records an `error` marker without aborting the sweep.
 */
export function migrateAllArtifacts(
  runsRoot: string,
  opts: MigrateArtifactsOptions = {},
): ArtifactVersionResult[] {
  const results: ArtifactVersionResult[] = [];
  if (!existsSync(runsRoot)) return results;
  for (const runDir of iterArtifactRunDirs(runsRoot).sort()) {
    results.push(migrateRunArtifacts(runDir, opts));
  }
  return results;
}

/** Recursively collect directories that hold any versioned JSON artifact. */
function iterArtifactRunDirs(root: string): string[] {
  const out: string[] = [];
  walkArtifactDirs(root, out);
  return out;
}

function walkArtifactDirs(dir: string, acc: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  if (VERSIONED_ARTIFACTS.some((name) => existsSync(join(dir, name)))) acc.push(dir);
  for (const name of entries) {
    const child = join(dir, name);
    try {
      if (statSync(child).isDirectory()) walkArtifactDirs(child, acc);
    } catch {
      // unreadable child — skip, mirrors migrate.ts::walk
    }
  }
}
