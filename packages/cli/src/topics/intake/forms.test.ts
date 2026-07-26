/**
 * intake/v1 form-spec validation tests. Walks the closed field model, enforces
 * the secret/file security guard, field-id safety, and choice constraints.
 */

import { describe, expect, test } from 'bun:test';
import { type IntakeForm, validateFormSpec } from './forms';

function form(overrides: Partial<IntakeForm> = {}): IntakeForm {
  return {
    schema_version: '1',
    form: 'demo',
    title: 'Demo',
    fields: [{ id: 'name', label: 'Name', type: 'text' }],
    ...overrides,
  };
}

describe('validateFormSpec', () => {
  test('a well-formed form with every field type validates clean', () => {
    const f = form({
      fields: [
        { id: 'a', label: 'A', type: 'text', required: true, placeholder: 'x', default: 'd' },
        { id: 'b', label: 'B', type: 'textarea', help: 'h' },
        { id: 'c', label: 'C', type: 'choice', choices: ['x', 'y'], default: 'x' },
        { id: 'd', label: 'D', type: 'multichoice', choices: ['p', 'q'] },
        { id: 'e', label: 'E', type: 'boolean' },
      ],
    });
    expect(validateFormSpec(f)).toEqual([]);
  });

  test('rejects a wrong schema_version', () => {
    expect(
      validateFormSpec(form({ schema_version: '2' as never })).some((e) =>
        e.includes('schema_version'),
      ),
    ).toBe(true);
  });

  test('rejects an empty form identity', () => {
    expect(validateFormSpec(form({ form: '' })).some((e) => e.includes('form must be'))).toBe(true);
  });

  test('rejects a form with no fields', () => {
    expect(
      validateFormSpec(form({ fields: [] })).some((e) => e.includes('at least one field')),
    ).toBe(true);
  });

  test('rejects a secret field with a security message', () => {
    const errors = validateFormSpec(
      form({ fields: [{ id: 'tok', label: 'Token', type: 'secret' as never }] }),
    );
    expect(errors.some((e) => e.includes('not permitted') && e.includes('leak'))).toBe(true);
  });

  test('rejects a file field with a security message', () => {
    const errors = validateFormSpec(
      form({ fields: [{ id: 'p', label: 'Path', type: 'file' as never }] }),
    );
    expect(errors.some((e) => e.includes('not permitted') && e.includes('leak'))).toBe(true);
  });

  test('rejects an unknown field type generically', () => {
    const errors = validateFormSpec(
      form({ fields: [{ id: 'x', label: 'X', type: 'date' as never }] }),
    );
    expect(errors.some((e) => e.includes('fields[0].type') && e.includes('must be one of'))).toBe(
      true,
    );
  });

  test('rejects an unsafe field id', () => {
    const errors = validateFormSpec(form({ fields: [{ id: 'Bad-Id', label: 'X', type: 'text' }] }));
    expect(errors.some((e) => e.includes('fields[0].id'))).toBe(true);
  });

  test('rejects duplicate field ids', () => {
    const errors = validateFormSpec(
      form({
        fields: [
          { id: 'dup', label: 'A', type: 'text' },
          { id: 'dup', label: 'B', type: 'text' },
        ],
      }),
    );
    expect(errors.some((e) => e.includes('duplicate field id'))).toBe(true);
  });

  test('requires choices on a choice field', () => {
    const errors = validateFormSpec(form({ fields: [{ id: 'c', label: 'C', type: 'choice' }] }));
    expect(errors.some((e) => e.includes('fields[0].choices'))).toBe(true);
  });

  test('forbids choices on a non-choice field', () => {
    const errors = validateFormSpec(
      form({ fields: [{ id: 't', label: 'T', type: 'text', choices: ['x'] }] }),
    );
    expect(errors.some((e) => e.includes('only allowed on choice'))).toBe(true);
  });

  test('rejects a choice default not among choices', () => {
    const errors = validateFormSpec(
      form({ fields: [{ id: 'c', label: 'C', type: 'choice', choices: ['x'], default: 'z' }] }),
    );
    expect(errors.some((e) => e.includes('fields[0].default'))).toBe(true);
  });

  test('accepts html display blocks interleaved with input fields, plus author css/js', () => {
    const f = form({
      css: '.evidence{color:#333}',
      js: "console.log('evidence')",
      fields: [
        { type: 'html', html: '<table><tr><td>A vs B</td></tr></table>' },
        { id: 'name', label: 'Name', type: 'text' },
        { type: 'html', html: '<svg><circle r="4"/></svg>' },
      ],
    });
    expect(validateFormSpec(f)).toEqual([]);
  });

  test('rejects an html block without a non-empty html string', () => {
    const errors = validateFormSpec(
      form({ fields: [{ type: 'html' } as never, { id: 'n', label: 'N', type: 'text' }] }),
    );
    expect(errors.some((e) => e.includes('fields[0].html'))).toBe(true);
  });

  test('rejects input-field keys on an html block', () => {
    const errors = validateFormSpec(
      form({
        fields: [
          { type: 'html', html: '<p>x</p>', id: 'x', required: true } as never,
          { id: 'n', label: 'N', type: 'text' },
        ],
      }),
    );
    expect(errors.some((e) => e.includes('fields[0].id') && e.includes('not allowed'))).toBe(true);
    expect(errors.some((e) => e.includes('fields[0].required'))).toBe(true);
  });

  test('rejects a form whose fields are all html blocks', () => {
    const errors = validateFormSpec(form({ fields: [{ type: 'html', html: '<p>x</p>' }] }));
    expect(errors.some((e) => e.includes('at least one input field'))).toBe(true);
  });

  test('rejects non-string css/js', () => {
    const errors = validateFormSpec(form({ css: 5 as never, js: {} as never }));
    expect(errors.some((e) => e.includes('css must be a string'))).toBe(true);
    expect(errors.some((e) => e.includes('js must be a string'))).toBe(true);
  });

  test('a non-object spec is rejected', () => {
    expect(validateFormSpec(null)).toEqual(['form spec must be a JSON object']);
    expect(validateFormSpec([])).toEqual(['form spec must be a JSON object']);
  });
});
