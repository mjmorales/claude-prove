/**
 * Schema validation for `.prove/runs/` artifact JSON files.
 *
 * Thin wrapper around `validator-engine.ts`, parameterized by the per-kind
 * schemas in `schemas.ts`. Ported from `tools/run_state/validate.py`.
 *
 * Return-shape divergence (deliberate): the Python source returns
 * `list[ValidationError]` / `tuple[dict, list[ValidationError]]`; the TS
 * port returns the envelope `{ ok, kind, version, errors }` so downstream
 * hooks can branch on `ok` without introspecting an error object. The error
 * *strings* inside `errors` match Python byte-for-byte — agents see the same
 * stderr wording.
 */

import { readFileSync } from 'node:fs';
import { CURRENT_SCHEMA_VERSION, SCHEMA_BY_KIND, inferKind } from './schemas';
import { type Schema, ValidationError, validateConfig } from './validator-engine';

export interface ValidateResult {
  ok: boolean;
  kind: string;
  version: string;
  /** Stringified findings in `"  ERROR: <path>: <message>"` format. */
  errors: string[];
}

/**
 * Validate a parsed JSON value against the schema for `kind`.
 *
 * `strict: true` promotes unknown-key warnings into errors (matches
 * Python behavior in `_validator.validate_config`).
 */
export function validateData(data: unknown, kind: string, strict = false): ValidateResult {
  if (!(kind in SCHEMA_BY_KIND)) {
    return {
      ok: false,
      kind,
      version: CURRENT_SCHEMA_VERSION,
      errors: [new ValidationError('', `unknown schema kind: '${kind}'`).toString()],
    };
  }
  if (!isPlainObject(data)) {
    return {
      ok: false,
      kind,
      version: CURRENT_SCHEMA_VERSION,
      errors: [new ValidationError('', 'top-level value must be a JSON object').toString()],
    };
  }
  const schema = SCHEMA_BY_KIND[kind] as Schema;
  const findings = validateConfig(data, schema, strict);
  const hardErrors = findings.filter((e) => e.severity === 'error');
  return {
    ok: hardErrors.length === 0,
    kind,
    version: schema.version,
    errors: findings.map((e) => e.toString()),
  };
}

/**
 * Read a JSON file from disk and validate it. When `kind` is omitted, the
 * schema is inferred from the filename (`prd.json`, `plan.json`,
 * `state.json`, `reports/*.json`).
 *
 * Returns the same `{ ok, kind, version, errors }` shape as `validateData`.
 * On file-not-found or invalid JSON, `kind` is echoed as the inferred value
 * (or an empty string if nothing could be inferred) and `errors` carries the
 * I/O diagnostic.
 */
export function validateFile(path: string, kind?: string, strict = false): ValidateResult {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return {
      ok: false,
      kind: kind ?? '',
      version: CURRENT_SCHEMA_VERSION,
      errors: [new ValidationError(path, 'file not found').toString()],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      kind: kind ?? '',
      version: CURRENT_SCHEMA_VERSION,
      errors: [new ValidationError(path, `invalid JSON: ${msg}`).toString()],
    };
  }

  const resolvedKind = kind ?? inferKind(path);
  if (!resolvedKind) {
    return {
      ok: false,
      kind: '',
      version: CURRENT_SCHEMA_VERSION,
      errors: [
        new ValidationError(
          path,
          'cannot infer schema kind from filename — pass --kind explicitly',
        ).toString(),
      ],
    };
  }

  return validateData(parsed, resolvedKind, strict);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
