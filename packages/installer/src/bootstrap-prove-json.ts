/**
 * Bootstrap `.claude/.prove.json` for a project.
 *
 * Emits a schema-versioned config populated with validators detected by
 * `@claude-prove/cli/schema/detect`. Pure stdlib — no runtime deps beyond
 * the CLI package.
 *
 * Usage:
 *   bootstrapProveJson(process.cwd());          // no-op if file exists
 *   bootstrapProveJson(process.cwd(), { force: true });  // reemit
 *
 * `force` reemits atomically and preserves user-custom validators (any
 * entry whose `name` is not in `DETECTED_VALIDATOR_NAMES`) plus every
 * other top-level key in the existing file.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DETECTED_VALIDATOR_NAMES,
  type DetectedValidator,
  detectValidators,
} from '@claude-prove/cli/schema/detect';
import { CURRENT_SCHEMA_VERSION } from '@claude-prove/cli/schema/schemas';

export interface BootstrapOptions {
  /** Reemit even if `.claude/.prove.json` already exists. */
  force?: boolean;
}

/**
 * Stored validator shape. Installer consumes whatever shape already lives
 * in `.claude/.prove.json` — we only enforce a `name` for dedup purposes.
 * `unknown`-valued extras survive reemit untouched.
 */
type StoredValidator = Record<string, unknown> & { name?: string };

/**
 * Result of a bootstrap. `[key: string]: unknown` carries forward every
 * top-level key from an existing file (scopes, claude_md, tools, ...).
 */
type ProveConfig = Record<string, unknown> & {
  schema_version: string;
  validators: StoredValidator[];
  reporters: unknown[];
};

/**
 * Write `.claude/.prove.json` at `cwd` with auto-detected validators.
 * No-op when the file already exists unless `opts.force` is true.
 */
export function bootstrapProveJson(cwd: string, opts: BootstrapOptions = {}): void {
  const claudeDir = join(cwd, '.claude');
  const target = join(claudeDir, '.prove.json');
  const exists = existsSync(target);

  if (exists && !opts.force) return;

  const detected = detectValidators(cwd).map(toStored);
  const config = exists ? mergeWithExisting(target, detected) : freshConfig(detected);

  mkdirSync(claudeDir, { recursive: true });
  writeAtomic(target, config);
}

function toStored(v: DetectedValidator): StoredValidator {
  return { name: v.name, command: v.command, phase: v.phase };
}

function freshConfig(detected: StoredValidator[]): ProveConfig {
  return {
    schema_version: CURRENT_SCHEMA_VERSION,
    validators: detected,
    reporters: [],
  };
}

/**
 * Preserve user-custom validators and all non-validators top-level keys
 * while replacing the auto-detected entries.
 */
function mergeWithExisting(path: string, detected: StoredValidator[]): ProveConfig {
  const raw = readFileSync(path, 'utf8');
  const existing = JSON.parse(raw) as Record<string, unknown>;

  const existingValidators = Array.isArray(existing.validators)
    ? (existing.validators as StoredValidator[])
    : [];
  const detectedNames = new Set(DETECTED_VALIDATOR_NAMES);
  const userCustom = existingValidators.filter(
    (v) => typeof v.name === 'string' && !detectedNames.has(v.name),
  );

  return {
    ...existing,
    schema_version: CURRENT_SCHEMA_VERSION,
    validators: [...detected, ...userCustom],
    reporters: Array.isArray(existing.reporters) ? existing.reporters : [],
  };
}

/**
 * Atomic write: marshal to a sibling `.tmp`, then rename. Avoids leaving
 * a half-written config behind if the process dies mid-write.
 */
function writeAtomic(path: string, config: ProveConfig): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
  renameSync(tmp, path);
}
