/**
 * intake/v1 — the closed model for an HTML intake form. A form is a titled,
 * ordered list of typed fields the operator fills in a self-contained HTML page
 * (see `render-form.ts`), then copies the answers back as an `IntakePayload`
 * (see `validate-payload.ts`). The form and the conversational interview are two
 * front-ends to one writer: the form gathers the same answers the conversation
 * would, mechanically.
 *
 * This is a SIBLING of the read-only report/v1 model (`../report/blocks.ts`), not
 * an extension of it — report/v1 renders data outward (snapshot-stable, no JS),
 * while a form takes input back (interactive). Mixing the two would break
 * report/v1's byte-stability, so intake owns its own closed model.
 *
 * The INPUT field-type set is CLOSED. `secret` and `file` are deliberately
 * KNOWN-BUT-FORBIDDEN: a secret value or a local file path would leak through
 * the copy-to-clipboard roundtrip, so spec validation rejects them with a
 * security message rather than ever rendering an input for them.
 *
 * Alongside input fields a spec may interleave `html` DISPLAY entries and carry
 * top-level `css`/`js`, all injected into the page VERBATIM — evidence (tables,
 * diagrams, charts, links) the escaped prose surfaces cannot express. The spec
 * author already controls everything the operator sees, so raw injection widens
 * expressiveness, not the trust boundary; display entries gather no answer, so
 * the payload shape and `schema_version` are unchanged.
 */

/** Input types an intake form field can render (closed enum). */
export type FieldType = 'text' | 'textarea' | 'choice' | 'multichoice' | 'boolean';

/** Runtime-checkable list of the closed `FieldType` set. */
export const FIELD_TYPES: FieldType[] = ['text', 'textarea', 'choice', 'multichoice', 'boolean'];

/**
 * Field types that are recognized but FORBIDDEN in an intake form. A `secret`
 * (a token, password) or a `file` (a local path) would be carried in plaintext
 * through the clipboard roundtrip, so the model refuses to render them. Spec
 * validation names these explicitly; any other unknown type is a generic error.
 */
export const FORBIDDEN_FIELD_TYPES = ['secret', 'file'] as const;
export type ForbiddenFieldType = (typeof FORBIDDEN_FIELD_TYPES)[number];

/** Choice-style fields that carry a `choices` list and constrain the answer. */
const CHOICE_TYPES: FieldType[] = ['choice', 'multichoice'];

/**
 * One field (one question) in an intake form. `id` is the answer key in the
 * pasted-back payload and the DOM id the renderer wires to, so it is constrained
 * to a safe identifier. `choices` is required for `choice`/`multichoice` and
 * forbidden otherwise.
 */
export interface IntakeField {
  /** Answer key + DOM id; unique within a form, `^[a-z][a-z0-9_]*$`. */
  id: string;
  /** The question text shown above the input. */
  label: string;
  type: FieldType;
  /** Whether an answer is required (default false). */
  required?: boolean;
  /** Help text shown under the field. */
  help?: string;
  /** Placeholder for `text`/`textarea`. */
  placeholder?: string;
  /** Options for `choice`/`multichoice`; required for those, forbidden otherwise. */
  choices?: string[];
  /** Prefill value (`text`/`textarea`/`choice`); when set on a `choice`, must be one of `choices`. */
  default?: string;
}

/** Discriminant for display entries; not a member of the input `FieldType` set. */
export const HTML_BLOCK_TYPE = 'html';

/**
 * A display entry: author-supplied markup rendered into the page verbatim at
 * its position among the fields. Gathers no answer, so it never appears in the
 * payload. Trusted author content — the renderer does not escape it.
 */
export interface IntakeHtmlBlock {
  type: typeof HTML_BLOCK_TYPE;
  html: string;
}

/** One entry in a form's `fields` list: an input field or a display block. */
export type IntakeEntry = IntakeField | IntakeHtmlBlock;

/** Narrows an entry to an answer-bearing input field. */
export function isInputField(entry: IntakeEntry): entry is IntakeField {
  return entry.type !== HTML_BLOCK_TYPE;
}

/**
 * An intake form: a titled, ordered list of entries. `form` is the form's
 * identity (e.g. `charter`) — the renderer embeds it and the payload echoes it,
 * so `validate` can confirm a payload was produced for this form. `css` and
 * `js` are appended verbatim to the page's base stylesheet and script.
 */
export interface IntakeForm {
  schema_version: '1';
  form: string;
  title: string;
  description?: string;
  css?: string;
  js?: string;
  fields: IntakeEntry[];
}

/** Current intake-form model version. Bump on a closed-set change. */
export const INTAKE_SCHEMA_VERSION = '1';

/** A field id must be a safe identifier: lowercase, starts with a letter. */
const FIELD_ID_RE = /^[a-z][a-z0-9_]*$/;

/**
 * Validate a parsed value as an `IntakeForm`. Returns a list of human-readable
 * error strings (empty = valid) rather than throwing, so a CLI `validate` action
 * reports every problem at once. Mirrors `validateReportDocument`'s accumulating
 * style. Enforces the secret/file security guard and field-id safety.
 */
export function validateFormSpec(value: unknown): string[] {
  const errors: string[] = [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return ['form spec must be a JSON object'];
  }
  const spec = value as Record<string, unknown>;

  if (spec.schema_version !== INTAKE_SCHEMA_VERSION) {
    errors.push(
      `schema_version must be "${INTAKE_SCHEMA_VERSION}", got ${stringify(spec.schema_version)}`,
    );
  }
  if (typeof spec.form !== 'string' || spec.form.length === 0) {
    errors.push(`form must be a non-empty string, got ${stringify(spec.form)}`);
  }
  if (typeof spec.title !== 'string') {
    errors.push(`title must be a string, got ${stringify(spec.title)}`);
  }
  for (const k of ['description', 'css', 'js'] as const) {
    if (spec[k] !== undefined && typeof spec[k] !== 'string') {
      errors.push(`${k} must be a string, got ${stringify(spec[k])}`);
    }
  }
  if (!Array.isArray(spec.fields)) {
    errors.push(`fields must be an array, got ${stringify(spec.fields)}`);
    return errors;
  }
  if (spec.fields.length === 0) {
    errors.push('fields must contain at least one field');
  }

  const seen = new Set<string>();
  let inputFieldCount = 0;
  spec.fields.forEach((entry, i) => {
    const path = `fields[${i}]`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      errors.push(`${path}: field must be a JSON object`);
      return;
    }
    const record = entry as Record<string, unknown>;
    if (record.type === HTML_BLOCK_TYPE) {
      validateHtmlBlock(record, path, errors);
      return;
    }
    inputFieldCount += 1;
    validateField(record, path, seen, errors);
  });
  if (spec.fields.length > 0 && inputFieldCount === 0) {
    errors.push(
      'fields must contain at least one input field — a form of only html blocks gathers no answers',
    );
  }
  return errors;
}

/** Keys that mark a misauthored input field; an html block renders markup only. */
const HTML_BLOCK_FORBIDDEN_KEYS = [
  'id',
  'label',
  'required',
  'choices',
  'help',
  'placeholder',
  'default',
] as const;

function validateHtmlBlock(block: Record<string, unknown>, path: string, errors: string[]): void {
  if (typeof block.html !== 'string' || block.html.length === 0) {
    errors.push(
      `${path}.html: must be a non-empty string for an html block, got ${stringify(block.html)}`,
    );
  }
  for (const k of HTML_BLOCK_FORBIDDEN_KEYS) {
    if (block[k] !== undefined) {
      errors.push(
        `${path}.${k}: not allowed on an html block — it renders markup and gathers no answer`,
      );
    }
  }
}

function validateField(
  field: Record<string, unknown>,
  path: string,
  seen: Set<string>,
  errors: string[],
): void {
  // id — safe identifier, unique.
  if (typeof field.id !== 'string' || !FIELD_ID_RE.test(field.id)) {
    errors.push(
      `${path}.id: must match ${FIELD_ID_RE.source} (lowercase, starts with a letter), got ${stringify(field.id)}`,
    );
  } else if (seen.has(field.id)) {
    errors.push(`${path}.id: duplicate field id ${stringify(field.id)}`);
  } else {
    seen.add(field.id);
  }

  if (typeof field.label !== 'string' || field.label.length === 0) {
    errors.push(`${path}.label: must be a non-empty string, got ${stringify(field.label)}`);
  }

  validateFieldType(field.type, path, errors);
  validateFieldChoices(field, path, errors);

  if (field.required !== undefined && typeof field.required !== 'boolean') {
    errors.push(`${path}.required: must be a boolean, got ${stringify(field.required)}`);
  }
  for (const k of ['help', 'placeholder', 'default'] as const) {
    if (field[k] !== undefined && typeof field[k] !== 'string') {
      errors.push(`${path}.${k}: must be a string, got ${stringify(field[k])}`);
    }
  }
}

/** Reject secret/file with a security message; reject other unknown types generically. */
function validateFieldType(type: unknown, path: string, errors: string[]): void {
  if ((FORBIDDEN_FIELD_TYPES as readonly string[]).includes(type as string)) {
    errors.push(
      `${path}.type: '${type as string}' is not permitted in an intake form — a secret or a local file path would leak through the clipboard roundtrip`,
    );
    return;
  }
  if (typeof type !== 'string' || !(FIELD_TYPES as string[]).includes(type)) {
    errors.push(`${path}.type: must be one of ${FIELD_TYPES.join(', ')}, got ${stringify(type)}`);
  }
}

/** `choices` is required (non-empty string array) for choice types, forbidden otherwise. */
function validateFieldChoices(
  field: Record<string, unknown>,
  path: string,
  errors: string[],
): void {
  const isChoice = CHOICE_TYPES.includes(field.type as FieldType);
  if (!isChoice) {
    if (field.choices !== undefined) {
      errors.push(`${path}.choices: only allowed on choice/multichoice fields`);
    }
    return;
  }
  const choices = field.choices;
  if (
    !Array.isArray(choices) ||
    choices.length === 0 ||
    choices.some((c) => typeof c !== 'string')
  ) {
    errors.push(
      `${path}.choices: must be a non-empty array of strings for a ${String(field.type)} field`,
    );
    return;
  }
  if (
    field.type === 'choice' &&
    typeof field.default === 'string' &&
    !(choices as string[]).includes(field.default)
  ) {
    errors.push(`${path}.default: ${stringify(field.default)} is not one of choices`);
  }
}

function stringify(value: unknown): string {
  if (value === undefined) return 'undefined';
  return JSON.stringify(value);
}
