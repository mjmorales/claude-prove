/**
 * Idempotent merge of a declared `models` block into
 * `.claude/settings.local.json`.
 *
 * The `models` block in `.claude/.prove.json` is the project's committed
 * recommendation for Claude Code model configuration; this writer is the
 * per-machine materialization step. Model choice is per-operator and
 * billing-dependent, so the target is always the auto-gitignored local
 * settings layer — never a tracked settings file.
 *
 * Key mapping:
 *   - models.main     -> `model`
 *   - models.advisor  -> `advisorModel`
 *   - models.fallback -> `fallbackModel`
 *   - models.effort   -> `env.CLAUDE_CODE_EFFORT_LEVEL`
 *
 * Materialization is add/update only: a field absent from the block never
 * touches its settings key, so an operator's own selections survive. All
 * keys outside the four mapped targets are preserved byte-for-byte at the
 * JSON level. Writes go through a temp file + rename for atomicity.
 */

import { renameSync, writeFileSync } from 'node:fs';
import { type LocalSettingsFile, readLocalSettings } from './write-local-env';

/** Env var Claude Code reads for a persistent effort-level selection. */
export const EFFORT_ENV_VAR = 'CLAUDE_CODE_EFFORT_LEVEL';

/** Declared `models` block shape from `.claude/.prove.json`. */
export interface ModelsBlock {
  main?: string;
  advisor?: string;
  fallback?: string[];
  effort?: string;
}

export interface WriteModelSettingsResult {
  /** Whether the file was written (false = already in sync). */
  wrote: boolean;
  /** Settings keys applied by this call, e.g. `model`, `advisorModel`. */
  applied: string[];
  /** Settings keys already carrying the declared value. */
  inSync: string[];
}

/**
 * Merge the declared `models` block into the local settings file at
 * `settingsPath`. Empty-string and empty-array fields are treated as
 * undeclared. Throws `LocalSettingsParseError` on malformed JSON without
 * writing anything.
 */
export function writeModelSettings(
  settingsPath: string,
  models: ModelsBlock,
): WriteModelSettingsResult {
  const settings = readLocalSettings(settingsPath);
  const applied: string[] = [];
  const inSync: string[] = [];

  const applyScalar = (settingsKey: 'model' | 'advisorModel', value: string | undefined) => {
    if (!value) return;
    if (settings[settingsKey] === value) {
      inSync.push(settingsKey);
      return;
    }
    settings[settingsKey] = value;
    applied.push(settingsKey);
  };

  applyScalar('model', models.main);
  applyScalar('advisorModel', models.advisor);

  if (models.fallback && models.fallback.length > 0) {
    const current = settings.fallbackModel;
    if (Array.isArray(current) && sameStringArray(current, models.fallback)) {
      inSync.push('fallbackModel');
    } else {
      settings.fallbackModel = [...models.fallback];
      applied.push('fallbackModel');
    }
  }

  if (models.effort) {
    const envKey = `env.${EFFORT_ENV_VAR}`;
    if (settings.env?.[EFFORT_ENV_VAR] === models.effort) {
      inSync.push(envKey);
    } else {
      settings.env = { ...settings.env, [EFFORT_ENV_VAR]: models.effort };
      applied.push(envKey);
    }
  }

  if (applied.length === 0) {
    return { wrote: false, applied, inSync };
  }

  writeAtomic(settingsPath, settings);
  return { wrote: true, applied, inSync };
}

/**
 * Diff a declared `models` block against the local settings file without
 * writing. Returns the settings keys whose materialized value is missing or
 * differs — the doctor drift check and `--dry-run` both read this.
 */
export function diffModelSettings(settingsPath: string, models: ModelsBlock): string[] {
  const settings = readLocalSettings(settingsPath);
  const drifted: string[] = [];

  if (models.main && settings.model !== models.main) drifted.push('model');
  if (models.advisor && settings.advisorModel !== models.advisor) drifted.push('advisorModel');
  if (models.fallback && models.fallback.length > 0) {
    const current = settings.fallbackModel;
    if (!Array.isArray(current) || !sameStringArray(current, models.fallback)) {
      drifted.push('fallbackModel');
    }
  }
  if (models.effort && settings.env?.[EFFORT_ENV_VAR] !== models.effort) {
    drifted.push(`env.${EFFORT_ENV_VAR}`);
  }

  return drifted;
}

/** True when the declared block carries at least one materializable field. */
export function hasModelDeclarations(models: ModelsBlock): boolean {
  return Boolean(
    models.main ||
      models.advisor ||
      (models.fallback && models.fallback.length > 0) ||
      models.effort,
  );
}

function sameStringArray(a: unknown[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function writeAtomic(settingsPath: string, settings: LocalSettingsFile): void {
  const serialized = `${JSON.stringify(settings, null, 2)}\n`;
  const tmp = `${settingsPath}.tmp.${process.pid}`;
  writeFileSync(tmp, serialized, 'utf8');
  renameSync(tmp, settingsPath);
}
