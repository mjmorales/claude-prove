/**
 * intake/v1 payload-validation tests. Checks the envelope (schema_version,
 * matching form), per-field required-ness and value types, choice membership,
 * and rejection of answer keys the form does not declare.
 */

import { describe, expect, test } from 'bun:test';
import type { IntakeForm } from './forms';
import { validatePayload } from './validate-payload';

const FORM: IntakeForm = {
  schema_version: '1',
  form: 'demo',
  title: 'Demo',
  fields: [
    { id: 'name', label: 'Name', type: 'text', required: true },
    { id: 'bio', label: 'Bio', type: 'textarea' },
    { id: 'role', label: 'Role', type: 'choice', required: true, choices: ['lead', 'eng'] },
    { id: 'tags', label: 'Tags', type: 'multichoice', choices: ['a', 'b', 'c'] },
    { id: 'active', label: 'Active', type: 'boolean' },
  ],
};

function payload(answers: Record<string, unknown>): unknown {
  return { schema_version: '1', form: 'demo', answers };
}

describe('validatePayload', () => {
  test('a complete, well-typed payload validates clean', () => {
    const errors = validatePayload(
      FORM,
      payload({ name: 'Ada', bio: 'engineer', role: 'lead', tags: ['a', 'c'], active: true }),
    );
    expect(errors).toEqual([]);
  });

  test('an optional-field omission is fine', () => {
    expect(validatePayload(FORM, payload({ name: 'Ada', role: 'eng' }))).toEqual([]);
  });

  test('rejects a missing required field', () => {
    const errors = validatePayload(FORM, payload({ role: 'lead' }));
    expect(errors.some((e) => e.includes('answers.name') && e.includes('required'))).toBe(true);
  });

  test('rejects an empty required text field', () => {
    const errors = validatePayload(FORM, payload({ name: '   ', role: 'lead' }));
    expect(errors.some((e) => e.includes('answers.name') && e.includes('empty'))).toBe(true);
  });

  test('rejects a choice value outside the choice set', () => {
    const errors = validatePayload(FORM, payload({ name: 'Ada', role: 'ceo' }));
    expect(errors.some((e) => e.includes('answers.role') && e.includes('not one of'))).toBe(true);
  });

  test('rejects a multichoice selection outside the set', () => {
    const errors = validatePayload(FORM, payload({ name: 'Ada', role: 'eng', tags: ['a', 'z'] }));
    expect(errors.some((e) => e.includes('answers.tags') && e.includes('z'))).toBe(true);
  });

  test('rejects a wrong-typed boolean', () => {
    const errors = validatePayload(FORM, payload({ name: 'Ada', role: 'eng', active: 'yes' }));
    expect(errors.some((e) => e.includes('answers.active') && e.includes('boolean'))).toBe(true);
  });

  test('rejects an answer key the form does not declare', () => {
    const errors = validatePayload(FORM, payload({ name: 'Ada', role: 'eng', bogus: 'x' }));
    expect(errors.some((e) => e.includes('answers.bogus') && e.includes('not a field'))).toBe(true);
  });

  test('rejects a mismatched form identity', () => {
    const errors = validatePayload(FORM, { schema_version: '1', form: 'other', answers: {} });
    expect(errors.some((e) => e.includes('form must be "demo"'))).toBe(true);
  });

  test('rejects a wrong schema_version', () => {
    const errors = validatePayload(FORM, { schema_version: '9', form: 'demo', answers: {} });
    expect(errors.some((e) => e.includes('schema_version'))).toBe(true);
  });

  test('a non-object payload is rejected', () => {
    expect(validatePayload(FORM, null)).toEqual(['payload must be a JSON object']);
    expect(validatePayload(FORM, [])).toEqual(['payload must be a JSON object']);
  });

  test('a non-object answers map is rejected', () => {
    const errors = validatePayload(FORM, { schema_version: '1', form: 'demo', answers: [] });
    expect(errors.some((e) => e.includes('answers must be'))).toBe(true);
  });
});
