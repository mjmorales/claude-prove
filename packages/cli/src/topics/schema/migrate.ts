/**
 * Migration engine for `.claude/.prove.json` schema evolution.
 *
 * Ported 1:1 from `tools/schema/migrate.py`. Detects the current schema
 * version, plans sequential hops to `CURRENT_SCHEMA_VERSION`, and applies
 * them with a timestamped backup. Behavior parity points (the test suite
 * locks these):
 *   - `MigrationChange.toString()` is byte-identical to Python `__str__`.
 *   - Backup filename mirrors Python `Path.with_suffix(f".{ts}.bak")`
 *     semantics — the final `.ext` is replaced, so `.prove.json` becomes
 *     `.prove.<ts>.bak`, not `.prove.json.<ts>.bak`.
 *   - Unknown / missing hop emits a `change` on `schema_version` describing
 *     the gap and breaks the loop.
 *
 * Exports: `MigrationChange`, `detectVersion`, `planMigration`,
 * `applyMigration`, `backupConfig`, plus the `MIGRATIONS` registry
 * (re-exported for tests).
 */

import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { CURRENT_SCHEMA_VERSION } from './schemas';

export type MigrationAction = 'add' | 'remove' | 'change' | 'rename';

const ACTION_SYMBOL: Record<MigrationAction, string> = {
  add: '+',
  remove: '-',
  change: '~',
  rename: '~',
};

/** A single change in a migration plan. Rendered by the CLI runner. */
export class MigrationChange {
  constructor(
    public action: MigrationAction,
    public path: string,
    public description: string,
    public value?: unknown,
  ) {}

  toString(): string {
    return `  ${ACTION_SYMBOL[this.action]} ${this.path}: ${this.description}`;
  }
}

/** Parsed config document; migrations mutate a shallow clone. */
export type ProveConfig = Record<string, unknown>;

/** Signature for every entry in the `MIGRATIONS` registry. */
export type MigrationFn = (config: ProveConfig) => [ProveConfig, MigrationChange[]];

/**
 * Detect the schema version of a config. Returns `"0"` for pre-schema
 * configs (no `schema_version` field).
 */
export function detectVersion(config: ProveConfig): string {
  const v = config['schema_version'];
  return typeof v === 'string' ? v : '0';
}

// --- Migration hops ---

/**
 * v0 -> v1: add `schema_version: "1"` as the FIRST key, preserve everything
 * else. Key ordering matters (matches Python's dict rebuild).
 */
function migrateV0ToV1(config: ProveConfig): [ProveConfig, MigrationChange[]] {
  const changes: MigrationChange[] = [];
  if ('schema_version' in config) {
    return [{ ...config }, changes];
  }
  const result: ProveConfig = { schema_version: '1', ...config };
  changes.push(new MigrationChange('add', 'schema_version', 'set to "1"', '1'));
  return [result, changes];
}

/**
 * v1 -> v2: bump schema_version, rename validator `stage` -> `phase` (only
 * when `phase` is absent), and add an empty `claude_md.references` block if
 * missing.
 */
function migrateV1ToV2(config: ProveConfig): [ProveConfig, MigrationChange[]] {
  const changes: MigrationChange[] = [];
  const result: ProveConfig = { ...config };

  result['schema_version'] = '2';
  changes.push(new MigrationChange('change', 'schema_version', '"1" -> "2"'));

  const validators = result['validators'];
  if (Array.isArray(validators)) {
    const next = validators.map((raw) => {
      if (!isPlainObject(raw)) return raw;
      const v: Record<string, unknown> = { ...raw };
      if ('stage' in v && !('phase' in v)) {
        v['phase'] = v['stage'];
        delete v['stage'];
        const name = typeof v['name'] === 'string' ? v['name'] : '?';
        changes.push(
          new MigrationChange(
            'rename',
            `validators[${name}].stage`,
            'renamed "stage" -> "phase"',
          ),
        );
      }
      return v;
    });
    result['validators'] = next;
  }

  if (!('claude_md' in result)) {
    result['claude_md'] = { references: [] };
    changes.push(
      new MigrationChange(
        'add',
        'claude_md',
        'added with empty references (configure via /prove:init or /prove:update)',
        { references: [] },
      ),
    );
  }

  return [result, changes];
}

/**
 * v2 -> v3: bump schema_version, move top-level `index` into
 * `tools.cafi.config` (marking `tools.cafi.enabled = true`), or add a
 * disabled `tools.cafi` stub when no index config existed. All other
 * `tools` entries pass through untouched.
 */
function migrateV2ToV3(config: ProveConfig): [ProveConfig, MigrationChange[]] {
  const changes: MigrationChange[] = [];
  const result: ProveConfig = { ...config };

  result['schema_version'] = '3';
  changes.push(new MigrationChange('change', 'schema_version', '"2" -> "3"'));

  const existingTools = result['tools'];
  const tools: Record<string, unknown> = isPlainObject(existingTools)
    ? { ...existingTools }
    : {};

  const indexConfig = result['index'];
  const hadIndex = 'index' in result;
  delete result['index'];

  if (hadIndex) {
    const cafiExisting = tools['cafi'];
    const cafi: Record<string, unknown> = isPlainObject(cafiExisting)
      ? { ...cafiExisting }
      : {};
    cafi['enabled'] = true;
    cafi['config'] = indexConfig;
    tools['cafi'] = cafi;
    changes.push(new MigrationChange('rename', 'index', 'moved to tools.cafi.config'));
  } else if (!('cafi' in tools)) {
    tools['cafi'] = { enabled: false };
    changes.push(
      new MigrationChange(
        'add',
        'tools.cafi',
        'added (disabled — no prior index config)',
        { enabled: false },
      ),
    );
  }

  result['tools'] = tools;

  return [result, changes];
}

/**
 * Migration registry. Keys are `"<from>_to_<to>"` strings; `planMigration`
 * walks them sequentially from the detected version to CURRENT_SCHEMA_VERSION.
 */
export const MIGRATIONS: Record<string, MigrationFn> = {
  '0_to_1': migrateV0ToV1,
  '1_to_2': migrateV1ToV2,
  '2_to_3': migrateV2ToV3,
};

/**
 * Plan all migrations needed to bring `config` to the current version.
 * Returns `(target_config, changes)`. When no hop exists for the next
 * version, emits a `change` describing the gap and breaks the loop.
 */
export function planMigration(config: ProveConfig): [ProveConfig, MigrationChange[]] {
  const currentVersion = detectVersion(config);
  let result: ProveConfig = { ...config };
  const allChanges: MigrationChange[] = [];

  if (currentVersion === CURRENT_SCHEMA_VERSION) {
    return [result, []];
  }

  let version = currentVersion;
  while (version !== CURRENT_SCHEMA_VERSION) {
    const nextVersion = String(parseInt(version, 10) + 1);
    const key = `${version}_to_${nextVersion}`;
    const fn = MIGRATIONS[key];
    if (!fn) {
      allChanges.push(
        new MigrationChange(
          'change',
          'schema_version',
          `no migration path from v${version} to v${nextVersion}`,
        ),
      );
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
 * Create a timestamped backup next to the original file. Filename format
 * matches Python's `Path.with_suffix(f".{ts}.bak")` — `<stem>.<ts>.bak`,
 * UTC timestamp `YYYYMMDDTHHMMSS`. Returns the backup path.
 */
export function backupConfig(path: string): string {
  const ts = utcTimestamp();
  const backupPath = withSuffix(path, `.${ts}.bak`);
  copyFileSync(path, backupPath);
  return backupPath;
}

export interface ApplyMigrationResult {
  backupPath: string | null;
  changes: MigrationChange[];
}

export interface ApplyMigrationOptions {
  dryRun?: boolean;
}

/**
 * Run migration on a config file. Returns `{ backupPath, changes }`. When
 * no migration is needed, both fields are empty. With `dryRun: true`, the
 * plan is returned without touching the filesystem.
 */
export function applyMigration(
  path: string,
  options: ApplyMigrationOptions = {},
): ApplyMigrationResult {
  const raw = readFileSync(path, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (!isPlainObject(parsed)) {
    throw new Error(`top-level value must be an object: ${path}`);
  }

  const [target, changes] = planMigration(parsed);

  if (changes.length === 0) {
    return { backupPath: null, changes: [] };
  }

  if (options.dryRun) {
    return { backupPath: null, changes };
  }

  const backupPath = backupConfig(path);
  writeFileSync(path, `${JSON.stringify(target, null, 2)}\n`);
  return { backupPath, changes };
}

// --- internals ---

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * UTC timestamp in `YYYYMMDDTHHMMSS` form. Mirrors Python's
 * `datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")`.
 */
function utcTimestamp(): string {
  const iso = new Date().toISOString(); // 2026-04-22T12:27:40.123Z
  return iso.replace(/[-:]/g, '').replace(/\.\d+Z$/, '');
}

/**
 * Mirror Python's `Path.with_suffix(newSuffix)`: replace the final `.ext`
 * on the basename with `newSuffix`. If the basename has no suffix (no `.`
 * after the first char), the new suffix is appended. Leading dot is part
 * of the stem (`.prove.json` has stem `.prove`, suffix `.json`).
 */
function withSuffix(path: string, newSuffix: string): string {
  const dir = dirname(path);
  const base = basename(path);
  const dotIndex = base.lastIndexOf('.');
  // Python treats a leading dot as part of the stem, not a suffix.
  const hasSuffix = dotIndex > 0;
  const stem = hasSuffix ? base.slice(0, dotIndex) : base;
  const newBase = `${stem}${newSuffix}`;
  return dir === '.' && !path.startsWith('./') ? newBase : join(dir, newBase);
}
