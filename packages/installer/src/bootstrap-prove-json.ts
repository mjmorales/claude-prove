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
 *
 * Schema version policy: bootstrap never migrates. If the on-disk version is
 * older than the CLI's current version, preserve it so `schema migrate` can
 * own the transform. If the on-disk version is newer, the running CLI is too
 * old to safely touch the file — throw to prevent a silent downgrade that
 * would cause `schema migrate` to start from the wrong hop.
 */
function mergeWithExisting(path: string, detected: StoredValidator[]): ProveConfig {
  const raw = readFileSync(path, 'utf8');
  let existing: Record<string, unknown>;
  try {
    existing = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse existing .prove.json — file may be corrupt: ${msg}`);
  }

  const existingVersion =
    typeof existing.schema_version === 'string' ? existing.schema_version : undefined;

  // Guard against downgrade: if the on-disk version is numerically newer than
  // what this CLI knows about, stamping CURRENT_SCHEMA_VERSION would label the
  // file with a lower version while the body still contains newer-shape fields,
  // causing `schema migrate` to start from the wrong hop.
  if (
    existingVersion !== undefined &&
    Number.parseInt(existingVersion, 10) > Number.parseInt(CURRENT_SCHEMA_VERSION, 10)
  ) {
    throw new Error(
      `Cannot bootstrap: existing .prove.json schema_version (${existingVersion}) is newer than ` +
        `this CLI's version (${CURRENT_SCHEMA_VERSION}). Upgrade the CLI before re-running init.`,
    );
  }

  const existingValidators = Array.isArray(existing.validators)
    ? (existing.validators as StoredValidator[])
    : [];
  const detectedNames = new Set(DETECTED_VALIDATOR_NAMES);
  const userCustom = existingValidators.filter(
    (v) => typeof v.name === 'string' && !detectedNames.has(v.name),
  );

  return {
    ...existing,
    // Preserve the existing version; let `schema migrate` own the upgrade path.
    schema_version: existingVersion ?? CURRENT_SCHEMA_VERSION,
    validators: [...detected, ...userCustom],
    reporters: Array.isArray(existing.reporters) ? existing.reporters : [],
  };
}

/**
 * Atomic write: marshal to a sibling pid-scoped tmp file, then rename.
 * Avoids leaving a half-written config behind if the process dies
 * mid-write; pid suffix prevents concurrent bootstraps from racing on
 * the same tmp path.
 */
function writeAtomic(path: string, config: ProveConfig): void {
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
  renameSync(tmp, path);
}
