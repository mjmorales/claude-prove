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

import { CURRENT_SCHEMA_VERSION } from './schemas';

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
 * Migration registry. Keys are `"<from>_to_<to>"`; `planMigration` walks them
 * sequentially. A sibling task will append `'2_to_3'` here — keep the ladder
 * dense and ordered.
 */
export const MIGRATIONS: Record<string, MigrationFn> = {
  '1_to_2': migrateV1ToV2,
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
