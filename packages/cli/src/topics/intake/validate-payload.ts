/**
 * intake/v1 payload validation — checks a pasted-back `IntakePayload` against the
 * `IntakeForm` it was produced from. This is the server side of the clipboard
 * roundtrip: the operator copies the form's answers as JSON and pastes them
 * back, and the intake skill runs this check before driving the writer, so a
 * malformed or mistyped answer set is caught instead of silently writing garbage.
 *
 * The renderer's in-page JS does a soft client-side required check, but THIS is
 * the authoritative gate — it does not trust the page. Callers should validate
 * the form spec (`validateFormSpec`) first; this function assumes a valid spec
 * and checks the payload against it.
 */

import { INTAKE_SCHEMA_VERSION, type IntakeForm } from './forms';

/** An answer value: free text, a multichoice selection, or a boolean. */
export type AnswerValue = string | string[] | boolean;

/** The pasted-back result: the form identity plus an answer per field id. */
export interface IntakePayload {
  schema_version: '1';
  form: string;
  answers: Record<string, AnswerValue>;
}

/**
 * Validate a parsed payload against the form it claims to answer. Returns a list
 * of human-readable error strings (empty = valid). Checks the envelope
 * (schema_version, matching `form`), each field's required-ness and value type,
 * and rejects answer keys the form does not declare.
 */
export function validatePayload(form: IntakeForm, payload: unknown): string[] {
  const errors: string[] = [];
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return ['payload must be a JSON object'];
  }
  const p = payload as Record<string, unknown>;

  if (p.schema_version !== INTAKE_SCHEMA_VERSION) {
    errors.push(
      `schema_version must be "${INTAKE_SCHEMA_VERSION}", got ${stringify(p.schema_version)}`,
    );
  }
  if (p.form !== form.form) {
    errors.push(
      `form must be "${form.form}" (the form this payload answers), got ${stringify(p.form)}`,
    );
  }
  if (typeof p.answers !== 'object' || p.answers === null || Array.isArray(p.answers)) {
    errors.push(`answers must be a JSON object, got ${stringify(p.answers)}`);
    return errors;
  }
  const answers = p.answers as Record<string, unknown>;

  const known = new Set(form.fields.map((f) => f.id));
  for (const key of Object.keys(answers)) {
    if (!known.has(key)) errors.push(`answers.${key}: not a field of form "${form.form}"`);
  }

  for (const field of form.fields) {
    const has = Object.prototype.hasOwnProperty.call(answers, field.id);
    if (!has) {
      if (field.required) errors.push(`answers.${field.id}: required field is missing`);
      continue;
    }
    validateAnswer(field, answers[field.id], errors);
  }

  return errors;
}

function validateAnswer(
  field: IntakeForm['fields'][number],
  value: unknown,
  errors: string[],
): void {
  const at = `answers.${field.id}`;
  switch (field.type) {
    case 'text':
    case 'textarea':
      if (typeof value !== 'string') {
        errors.push(`${at}: must be a string, got ${stringify(value)}`);
      } else if (field.required && value.trim().length === 0) {
        errors.push(`${at}: required field is empty`);
      }
      break;
    case 'choice':
      if (typeof value !== 'string') {
        errors.push(`${at}: must be a string, got ${stringify(value)}`);
      } else if (field.required && value.length === 0) {
        errors.push(`${at}: required field is empty`);
      } else if (value.length > 0 && !(field.choices ?? []).includes(value)) {
        errors.push(
          `${at}: ${stringify(value)} is not one of [${(field.choices ?? []).join(', ')}]`,
        );
      }
      break;
    case 'multichoice':
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
        errors.push(`${at}: must be an array of strings, got ${stringify(value)}`);
      } else {
        const bad = value.filter((v) => !(field.choices ?? []).includes(v as string));
        if (bad.length > 0) {
          errors.push(`${at}: [${bad.join(', ')}] not in [${(field.choices ?? []).join(', ')}]`);
        }
        if (field.required && value.length === 0) {
          errors.push(`${at}: required field has no selection`);
        }
      }
      break;
    case 'boolean':
      if (typeof value !== 'boolean')
        errors.push(`${at}: must be a boolean, got ${stringify(value)}`);
      break;
  }
}

function stringify(value: unknown): string {
  if (value === undefined) return 'undefined';
  return JSON.stringify(value);
}
