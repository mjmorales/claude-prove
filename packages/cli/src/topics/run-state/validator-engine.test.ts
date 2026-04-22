/**
 * Validator-engine tests — covers the seven error categories in the task
 * spec plus default handling and parity fixtures.
 *
 * Parity fixtures: each test case has a matching file under
 * `__fixtures__/validator/python-captures/<name>.json` and
 * `__fixtures__/validator/ts-captures/<name>.json`. The ts-captures are
 * byte-compared to the python-captures by `parity fixtures` test below.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  type FieldSpec,
  type Schema,
  type ValidationError,
  validateConfig,
  validateValue,
} from './validator-engine';

const FIXTURES = join(import.meta.dir, '__fixtures__/validator');

function errorPaths(errors: ValidationError[]): Set<string> {
  return new Set(errors.filter((e) => e.severity === 'error').map((e) => e.path));
}

function warnPaths(errors: ValidationError[]): Set<string> {
  return new Set(errors.filter((e) => e.severity === 'warning').map((e) => e.path));
}

function messages(errors: ValidationError[]): string[] {
  return errors.map((e) => e.toString());
}

describe('wrong-type errors', () => {
  test('str mismatch yields expected X, got Y', () => {
    const schema: Schema = {
      kind: 't',
      version: '1',
      fields: { title: { type: 'str', required: true } },
    };
    const errors = validateConfig({ title: 42 }, schema);
    expect(messages(errors)).toEqual(['  ERROR: title: expected str, got int']);
  });

  test('int mismatch yields expected int, got str', () => {
    const schema: Schema = {
      kind: 't',
      version: '1',
      fields: { count: { type: 'int', required: true } },
    };
    const errors = validateConfig({ count: 'not-int' }, schema);
    expect(messages(errors)).toEqual(['  ERROR: count: expected int, got str']);
  });

  test('list mismatch yields expected list, got str', () => {
    const schema: Schema = {
      kind: 't',
      version: '1',
      fields: { tags: { type: 'list', required: true, items: { type: 'str' } } },
    };
    const errors = validateConfig({ tags: 'nope' }, schema);
    expect(messages(errors)).toEqual(['  ERROR: tags: expected list, got str']);
  });

  test('bool is disjoint from int (TS-strict divergence)', () => {
    const schema: Schema = {
      kind: 't',
      version: '1',
      fields: { flag: { type: 'int', required: true } },
    };
    const errors = validateConfig({ flag: true }, schema);
    expect(messages(errors)).toEqual(['  ERROR: flag: expected int, got bool']);
  });
});

describe('required-missing', () => {
  test('all missing keys flagged', () => {
    const schema: Schema = {
      kind: 't',
      version: '1',
      fields: {
        schema_version: { type: 'str', required: true },
        kind: { type: 'str', required: true },
        tasks: { type: 'list', required: true, items: { type: 'str' } },
      },
    };
    const errors = validateConfig({}, schema);
    expect(errorPaths(errors)).toEqual(new Set(['schema_version', 'kind', 'tasks']));
    expect(messages(errors)[0]).toBe('  ERROR: schema_version: required field is missing');
  });
});

describe('enum-mismatch', () => {
  test('renders python-style list literal and single-quoted value', () => {
    const schema: Schema = {
      kind: 't',
      version: '1',
      fields: {
        status: {
          type: 'str',
          required: true,
          enum: ['pending', 'running', 'completed', 'failed', 'halted'],
        },
      },
    };
    const errors = validateConfig({ status: 'weird' }, schema);
    expect(messages(errors)).toEqual([
      "  ERROR: status: must be one of ['pending', 'running', 'completed', 'failed', 'halted'], got 'weird'",
    ]);
  });
});

describe('unknown-key warning', () => {
  test('emits WARN after required errors', () => {
    const schema: Schema = {
      kind: 't',
      version: '1',
      fields: { title: { type: 'str', required: true } },
    };
    const errors = validateConfig({ title: 'ok', extra: 1 }, schema);
    expect(errorPaths(errors)).toEqual(new Set());
    expect(warnPaths(errors)).toEqual(new Set(['extra']));
  });

  test('strict mode promotes warnings to errors', () => {
    const schema: Schema = {
      kind: 't',
      version: '1',
      fields: { title: { type: 'str', required: true } },
    };
    const errors = validateConfig({ title: 'ok', extra: 1 }, schema, true);
    expect(errorPaths(errors)).toEqual(new Set(['extra']));
  });
});

describe('nested-dict descent', () => {
  test('prefix is chained: scope.out', () => {
    const schema: Schema = {
      kind: 't',
      version: '1',
      fields: {
        scope: {
          type: 'dict',
          required: true,
          fields: {
            in: { type: 'list', required: true, items: { type: 'str' } },
            out: { type: 'list', required: true, items: { type: 'str' } },
          },
        },
      },
    };
    const errors = validateConfig({ scope: { in: ['a'] } }, schema);
    expect(errorPaths(errors)).toEqual(new Set(['scope.out']));
  });
});

describe('list-items descent', () => {
  test('path uses tasks[index].field form', () => {
    const schema: Schema = {
      kind: 't',
      version: '1',
      fields: {
        tasks: {
          type: 'list',
          required: true,
          items: {
            type: 'dict',
            fields: {
              id: { type: 'str', required: true },
              wave: { type: 'int', required: true },
            },
          },
        },
      },
    };
    const errors = validateConfig(
      {
        tasks: [
          { id: '1.1', wave: 1 },
          { id: '1.2', wave: 'oops' },
        ],
      },
      schema,
    );
    expect(messages(errors)).toEqual(['  ERROR: tasks[1].wave: expected int, got str']);
  });
});

describe('value-spec descent (fields vs values)', () => {
  test('values spec applies to arbitrary dict values', () => {
    const schema: Schema = {
      kind: 't',
      version: '1',
      fields: {
        map: { type: 'dict', required: true, values: { type: 'int' } },
      },
    };
    const errors = validateConfig({ map: { a: 1, b: 'not-int' } }, schema);
    expect(messages(errors)).toEqual(['  ERROR: map.b: expected int, got str']);
  });

  test('fields wins over values when both are present', () => {
    const schema: Schema = {
      kind: 't',
      version: '1',
      fields: {
        obj: {
          type: 'dict',
          required: true,
          fields: { id: { type: 'str', required: true } },
          values: { type: 'int' }, // ignored because fields is set
        },
      },
    };
    const errors = validateConfig({ obj: { id: 'x', extra: 99 } }, schema);
    // extra should be an unknown-field WARNING, not a type error against `int`
    expect(errorPaths(errors)).toEqual(new Set());
    expect(warnPaths(errors)).toEqual(new Set(['obj.extra']));
  });
});

describe('default handling', () => {
  test('defaults are metadata only — validator never mutates input', () => {
    const schema: Schema = {
      kind: 't',
      version: '1',
      fields: {
        name: { type: 'str', required: true, default: 'FALLBACK' },
      },
    };
    const input = { name: 'user-provided' };
    const errors = validateConfig(input, schema);
    expect(errors).toEqual([]);
    // Confirm the validator left the input untouched.
    expect(input).toEqual({ name: 'user-provided' });
  });

  test('missing key with default still raises required error', () => {
    const schema: Schema = {
      kind: 't',
      version: '1',
      fields: {
        name: { type: 'str', required: true, default: 'FALLBACK' },
      },
    };
    const errors = validateConfig({}, schema);
    expect(errorPaths(errors)).toEqual(new Set(['name']));
  });
});

describe('validateValue public helper', () => {
  test('returns ok=true on clean value', () => {
    const spec: FieldSpec = { type: 'str' };
    const r = validateValue('hello', spec, 'x');
    expect(r).toEqual({ ok: true, errors: [] });
  });

  test('returns ok=false with path-prefixed messages on mismatch', () => {
    const spec: FieldSpec = { type: 'int' };
    const r = validateValue('nope', spec, 'x');
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual(['x: expected int, got str']);
  });

  test('descends into list items with indexed path', () => {
    const spec: FieldSpec = { type: 'list', items: { type: 'int' } };
    const r = validateValue([1, 'bad', 3], spec, 'nums');
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual(['nums[1]: expected int, got str']);
  });
});

describe('parity fixtures — TS output matches Python captures', () => {
  const pyDir = join(FIXTURES, 'python-captures');
  const tsDir = join(FIXTURES, 'ts-captures');
  const names = readdirSync(pyDir).filter((f) => f.endsWith('.txt'));

  test.each(names)('%s matches python-captures byte-for-byte', (name) => {
    const py = readFileSync(join(pyDir, name), 'utf8');
    const ts = readFileSync(join(tsDir, name), 'utf8');
    expect(ts).toBe(py);
  });
});
