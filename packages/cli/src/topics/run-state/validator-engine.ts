/**
 * Field-spec DSL validator for `.prove/runs/<branch>/<slug>/` JSON artifacts.
 *
 * Ported 1:1 from `tools/run_state/_validator.py`. Error-string parity is
 * part of the contract — the run-state hooks (guard, validate, session-start,
 * stop, subagent-stop) pipe findings to stderr where agents read them. Any
 * drift from the Python wording breaks observability.
 *
 * Field-spec DSL (mirrors schemas.py):
 *   - `type`:        "str" | "int" | "bool" | "list" | "dict" | "any"
 *   - `required`:    must-be-present on the parent dict (default false)
 *   - `items`:       child spec for list elements (descent on lists)
 *   - `fields`:      known dict keys (strict match, unknowns warn)
 *   - `values`:      spec for arbitrary dict values (used when `fields` absent)
 *   - `enum`:        allowed literal values (scalars only)
 *   - `description`: human-readable, ignored by the validator
 *   - `default`:     supplied to migrators/initializers, ignored here
 *
 * Emits one `ValidationError` per finding. Type mismatches short-circuit
 * further checks on that node (so enum + items + fields are only evaluated
 * once the type is right). Unknown-key warnings land AFTER required-field
 * errors so test output is stable.
 */

export type FieldType = 'str' | 'int' | 'bool' | 'list' | 'dict' | 'any';

/** Discriminated spec for a single schema field. Shared with schemas.ts. */
export interface FieldSpec {
  type: FieldType;
  required?: boolean;
  items?: FieldSpec;
  fields?: Record<string, FieldSpec>;
  values?: FieldSpec;
  description?: string;
  default?: unknown;
  enum?: readonly (string | number | boolean)[];
}

/** Top-level schema envelope: a kind tag, version, and root fields map. */
export interface Schema {
  kind: string;
  version: string;
  fields: Record<string, FieldSpec>;
}

export type Severity = 'error' | 'warning';

/** A single validation finding. `toString()` is byte-identical to Python. */
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
 * Validate a config dict against a schema.
 *
 * `strict: true` promotes every warning to an error in place (mutates the
 * severity on the returned objects — mirrors the Python behavior).
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

/**
 * Public single-value entry point. Takes the `validateValue(value, spec, path)`
 * shape described in the task deliverables and returns a simple
 * `{ ok, errors }` envelope with stringified errors for callers that don't
 * need the `ValidationError` class.
 */
export function validateValue(
  value: unknown,
  spec: FieldSpec,
  path = '',
): { ok: boolean; errors: string[] } {
  const errs = validateValueInternal(value, spec, path);
  return {
    ok: errs.every((e) => e.severity !== 'error'),
    errors: errs.map((e) => `${e.path}: ${e.message}`),
  };
}

// --- internals ---

/**
 * Validate a dict's fields against a known-key map. Unknown keys produce
 * warnings (extensibility escape valve — matches Python semantics).
 */
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
    errors.push(...validateValueInternal(data[fieldName], spec, path));
  }

  // Unknown-field warnings emit AFTER required errors so the ordering of
  // test output stays stable (matches Python source).
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

/**
 * Validate a single value against a field spec. Used recursively for list
 * items and nested dicts.
 */
function validateValueInternal(value: unknown, spec: FieldSpec, path: string): ValidationError[] {
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
      errors.push(...validateValueInternal(arr[i], spec.items, `${path}[${i}]`));
    }
  }

  if (expected === 'dict' && spec.fields) {
    errors.push(...validateFields(value as Record<string, unknown>, spec.fields, path));
  }

  if (expected === 'dict' && spec.values && !spec.fields) {
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      errors.push(...validateValueInternal(val, spec.values, `${path}.${key}`));
    }
  }

  return errors;
}

/**
 * Type predicate mirroring Python's TYPE_MAP semantics. Two intentional
 * divergences documented for future maintainers:
 *   - `int` accepts any JS number that is an integer (covers integer-valued
 *     floats, matching Python's `int(v) == v` branch). Fractional floats are
 *     rejected here, whereas the Python source accepts them due to a latent
 *     `isinstance(v, (int, float))` quirk — TS is strictly correct.
 *   - `bool` and `int` are disjoint: a boolean never satisfies `int`. Python
 *     conflates them because `bool` subclasses `int`, but JSON payloads never
 *     need that conflation in run-state artifacts.
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Render a value the way Python's `repr()` would for the message-building
 * sites in _validator.py: strings get single quotes, everything else falls
 * back to JSON.
 */
function formatValue(value: unknown): string {
  if (typeof value === 'string') return `'${value}'`;
  return JSON.stringify(value);
}

/**
 * Render a list literal the way Python's `str(list)` would — single-quoted
 * strings inside brackets — so error messages match the Python source
 * byte-for-byte: `["pending", "running"]` -> `['pending', 'running']`.
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
