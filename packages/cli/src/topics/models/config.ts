/**
 * Shared plumbing for the `models` topic: read the declared `models` block
 * out of `.claude/.prove.json`, resolve the local-settings target path, and
 * compute the advisory pairing diagnostics.
 *
 * The diagnostics are mechanical string checks against Claude Code's stable
 * pairing rules — no capability ranking is re-derived here, because the
 * accepted-pairing matrix is version-dependent and Claude Code enforces it
 * authoritatively at session start. Only the rules that hold across versions
 * are encoded.
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ModelsBlock } from '@claude-prove/installer';

export const PROVE_JSON_REL = join('.claude', '.prove.json');
export const LOCAL_SETTINGS_REL = join('.claude', 'settings.local.json');

export interface ModelsContext {
  cwd: string;
  proveJsonPath: string;
  settingsPath: string;
}

export function resolveModelsContext(opts: { cwd?: string; settings?: string }): ModelsContext {
  const cwd = resolve(opts.cwd ?? process.cwd());
  return {
    cwd,
    proveJsonPath: join(cwd, PROVE_JSON_REL),
    settingsPath: opts.settings ? resolve(opts.settings) : join(cwd, LOCAL_SETTINGS_REL),
  };
}

/** Thrown when `.claude/.prove.json` is missing or unparseable. */
export class ProveJsonReadError extends Error {
  constructor(path: string, cause: string) {
    super(`cannot read ${path}: ${cause}`);
    this.name = 'ProveJsonReadError';
  }
}

/** Full parsed `.claude/.prove.json` document plus its `models` block. */
export interface ProveJsonDocument {
  raw: Record<string, unknown>;
  models: ModelsBlock;
}

export function readProveJson(proveJsonPath: string): ProveJsonDocument {
  let text: string;
  try {
    text = readFileSync(proveJsonPath, 'utf8');
  } catch (err) {
    throw new ProveJsonReadError(
      proveJsonPath,
      (err as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'file not found (run `claude-prove install init-config` first)'
        : (err as Error).message,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ProveJsonReadError(proveJsonPath, `invalid JSON — ${(err as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ProveJsonReadError(proveJsonPath, 'top-level value must be an object');
  }

  const raw = parsed as Record<string, unknown>;
  const models = isPlainObject(raw.models) ? (raw.models as ModelsBlock) : {};
  return { raw, models };
}

/**
 * Advisory pairing diagnostics for a declared block. Warn-only: every rule
 * here is enforced (or silently degraded) by Claude Code itself; surfacing
 * it early saves the operator a dead setting.
 */
export function advisoryWarnings(models: ModelsBlock): string[] {
  const warnings: string[] = [];

  if (models.advisor && /haiku/i.test(models.advisor)) {
    warnings.push(
      'advisor is a Haiku model — Haiku can call the advisor but cannot act as one; Claude Code will not attach it',
    );
  }
  if (models.advisor && models.main && /fable/i.test(models.main)) {
    warnings.push(
      'main model is Fable — a Fable main accepts only a Fable advisor and Fable is not offered as one, so the session runs without an advisor',
    );
  }
  if (models.fallback && models.fallback.length > 3) {
    warnings.push(
      `fallback chain has ${models.fallback.length} entries — Claude Code caps chains at three models after duplicate removal`,
    );
  }

  return warnings;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
