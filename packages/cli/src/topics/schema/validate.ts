/**
 * Lightweight JSON config validator. Pure stdlib — `node:fs` + `node:path`.
 *
 * Ported 1:1 from `tools/schema/validate.py`. Behavior parity:
 *   - Type mismatches produce an error and abort further checks on that node.
 *   - Enum violations produce an error (only when type check passes).
 *   - Required fields absent from the data produce an error.
 *   - Unknown keys on a dict-with-`fields` produce a WARNING (unchanged by
 *     normal runs; `strict: true` promotes warnings to errors in place).
 *   - Unknown-field warnings are emitted AFTER required-field errors for
 *     stable ordering in test output.
 *
 * Path construction mirrors the Python version: `prefix.field` for dicts,
 * `prefix[index]` for list items. `ValidationError.toString()` is byte-
 * identical to the Python `__str__`.
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { type FieldSpec, PROVE_SCHEMA, SETTINGS_SCHEMA, type Schema } from './schemas';

export type Severity = 'error' | 'warning';

/** A single validation finding. */
export class ValidationError {
  constructor(
    public path: string,
    public message: string,
    public severity: Severity = 'error',
  ) {}

  toString(): string {
    const prefix = this.severity === 'error' ? 'ERROR' : 'WARN';
    return `  ${prefix}: ${this.path}: ${this.message}`;
  }
}

/**
 * Validate a config object against a schema.
 *
 * @param config Parsed JSON object (must already be a plain object).
 * @param schema `PROVE_SCHEMA` or `SETTINGS_SCHEMA`.
 * @param strict When true, every warning is promoted to an error in place.
 */
export function validateConfig(
  config: Record<string, unknown>,
  schema: Schema,
  strict = false,
): ValidationError[] {
  const errors = validateFields(config, schema.fields, '');
  if (strict) {
    for (const e of errors) {
      if (e.severity === 'warning') {
        e.severity = 'error';
      }
    }
  }
  return errors;
}

export interface ValidateFileResult {
  config: Record<string, unknown> | null;
  errors: ValidationError[];
}

/**
 * Read and validate a JSON config file on disk.
 *
 * Auto-detects the schema from the path when `schema` is omitted:
 *   - basename `.prove.json` OR path ending `.claude/.prove.json` -> PROVE_SCHEMA
 *   - basename `settings.json` with `.claude` in the path        -> SETTINGS_SCHEMA
 *   - anything else -> a single warning, config returned unvalidated.
 *
 * Emits an error (with `config: null`) for missing file, invalid JSON, or a
 * non-object top-level value.
 */
export function validateFile(path: string, schema?: Schema, strict = false): ValidateFileResult {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return { config: null, errors: [new ValidationError(path, 'file not found')] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      config: null,
      errors: [new ValidationError(path, `invalid JSON: ${msg}`)],
    };
  }

  if (!isPlainObject(parsed)) {
    return {
      config: null,
      errors: [new ValidationError(path, 'top-level value must be an object')],
    };
  }

  const config = parsed;
  const resolved = schema ?? autoDetectSchema(path);
  if (resolved === null) {
    return {
      config,
      errors: [
        new ValidationError(path, 'cannot auto-detect schema — pass schema explicitly', 'warning'),
      ],
    };
  }

  return { config, errors: validateConfig(config, resolved, strict) };
}

// --- internals ---

function autoDetectSchema(path: string): Schema | null {
  const name = basename(path);
  if (name === '.prove.json' || path.endsWith('.claude/.prove.json')) {
    return PROVE_SCHEMA;
  }
  if (name === 'settings.json' && path.includes('.claude')) {
    return SETTINGS_SCHEMA;
  }
  return null;
}

function validateFields(
  data: Record<string, unknown>,
  fields: Record<string, FieldSpec>,
  prefix: string,
): ValidationError[] {
  const errors: ValidationError[] = [];
  const known = new Set(Object.keys(fields));

  for (const [fieldName, spec] of Object.entries(fields)) {
    const path = prefix ? `${prefix}.${fieldName}` : fieldName;
    if (!(fieldName in data)) {
      if (spec.required) {
        errors.push(new ValidationError(path, 'required field is missing'));
      }
      continue;
    }
    errors.push(...validateValue(data[fieldName], spec, path));
  }

  // Unknown-field warnings are emitted AFTER required-field errors so the
  // ordering of test output stays stable (matches Python source).
  for (const key of Object.keys(data)) {
    if (known.has(key)) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    errors.push(
      new ValidationError(
        path,
        'unknown field (not in schema — may be from a tool or future version)',
        'warning',
      ),
    );
  }

  return errors;
}

function validateValue(value: unknown, spec: FieldSpec, path: string): ValidationError[] {
  const errors: ValidationError[] = [];
  const expected = spec.type;

  if (expected === 'any') return errors;

  if (!matchesType(value, expected)) {
    errors.push(new ValidationError(path, `expected ${expected}, got ${typeName(value)}`));
    return errors; // Skip further checks if type is wrong.
  }

  if (spec.enum && !spec.enum.includes(value as string | number | boolean)) {
    errors.push(
      new ValidationError(
        path,
        `must be one of ${formatEnum(spec.enum)}, got ${formatValue(value)}`,
      ),
    );
  }

  if (expected === 'list' && spec.items) {
    const arr = value as unknown[];
    for (let i = 0; i < arr.length; i++) {
      errors.push(...validateValue(arr[i], spec.items, `${path}[${i}]`));
    }
  }

  if (expected === 'dict' && spec.fields) {
    errors.push(...validateFields(value as Record<string, unknown>, spec.fields, path));
  }

  if (expected === 'dict' && spec.values && !spec.fields) {
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      errors.push(...validateValue(val, spec.values, `${path}.${key}`));
    }
  }

  return errors;
}

/**
 * Type predicate mirroring Python's TYPE_MAP semantics. Notable quirks kept
 * intentional:
 *   - `int` accepts any JS number that is an integer (includes integer-valued
 *     floats, matching Python's `int(value) == value` check).
 *   - `bool` and `int` are disjoint here: a boolean NEVER satisfies `int`.
 *     (Python conflates the two because `bool` subclasses `int`, but the
 *     test_validate.py suite relies on the separation — e.g. `enabled: "yes"`
 *     is rejected against `type: bool` without ambiguity.)
 *   - `list` = plain array; `dict` = plain object (not array, not null).
 */
function matchesType(value: unknown, expected: Exclude<FieldType, 'any'>): boolean {
  switch (expected) {
    case 'str':
      return typeof value === 'string';
    case 'bool':
      return typeof value === 'boolean';
    case 'int':
      return typeof value === 'number' && Number.isInteger(value);
    case 'list':
      return Array.isArray(value);
    case 'dict':
      return isPlainObject(value);
  }
}

type FieldType = FieldSpec['type'];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Render a value the way Python's `repr()` would for the message-building
 * sites in validate.py: strings get single quotes, everything else falls
 * back to JSON.
 */
function formatValue(value: unknown): string {
  if (typeof value === 'string') return `'${value}'`;
  return JSON.stringify(value);
}

/**
 * Render a list literal the way Python's `str(list)` would — single-quoted
 * strings inside brackets — so error messages match the Python source
 * byte-for-byte: `["build", "lint"]` -> `['build', 'lint']`.
 */
function formatEnum(values: readonly (string | number | boolean)[]): string {
  const parts = values.map((v) => formatValue(v));
  return `[${parts.join(', ')}]`;
}

/**
 * Mirror Python's `type(value).__name__` for the common JSON types. Used
 * only in type-mismatch messages.
 */
function typeName(value: unknown): string {
  if (value === null) return 'NoneType';
  if (Array.isArray(value)) return 'list';
  const t = typeof value;
  switch (t) {
    case 'string':
      return 'str';
    case 'boolean':
      return 'bool';
    case 'number':
      return Number.isInteger(value) ? 'int' : 'float';
    case 'object':
      return 'dict';
    default:
      return t;
  }
}
