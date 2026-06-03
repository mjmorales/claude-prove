/**
 * Schema-shape tests for `PROVE_SCHEMA`. These lock the field specs that
 * migrations seed and the validator enforces: every new field carries a
 * description + default, defaults validate clean, and enum-constrained
 * fields reject out-of-domain values.
 */

import { describe, expect, test } from 'bun:test';
import { CURRENT_SCHEMA_VERSION, type FieldSpec, PROVE_SCHEMA } from './schemas';
import { validateConfig } from './validate';

/** Resolve a nested `fields` spec by dotted path, or throw if absent. */
function specAt(path: string): FieldSpec {
  const parts = path.split('.');
  let spec: FieldSpec = { type: 'dict', fields: PROVE_SCHEMA.fields };
  for (const part of parts) {
    const child = spec.fields?.[part];
    if (!child) {
      throw new Error(`no field spec at ${path} (missing segment "${part}")`);
    }
    spec = child;
  }
  return spec;
}

describe('PROVE_SCHEMA version', () => {
  test('current version is "9"', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe('9');
    expect(PROVE_SCHEMA.version).toBe('9');
  });
});

describe('PROVE_SCHEMA brief group', () => {
  test('brief is an optional dict group', () => {
    const brief = specAt('brief');
    expect(brief.type).toBe('dict');
    expect(brief.required).toBeFalsy();
    expect(brief.description).toBeTruthy();
  });

  test('single_pass_token_threshold is int, default 8000', () => {
    const spec = specAt('brief.single_pass_token_threshold');
    expect(spec.type).toBe('int');
    expect(spec.default).toBe(8000);
    expect(spec.description).toBeTruthy();
  });

  test('max_synthesis_retries is int, default 2', () => {
    const spec = specAt('brief.max_synthesis_retries');
    expect(spec.type).toBe('int');
    expect(spec.default).toBe(2);
    expect(spec.description).toBeTruthy();
  });

  test('prose_judge_on is bool, default true', () => {
    const spec = specAt('brief.prose_judge_on');
    expect(spec.type).toBe('bool');
    expect(spec.default).toBe(true);
    expect(spec.description).toBeTruthy();
  });
});

describe('PROVE_SCHEMA memory group', () => {
  test('memory is an optional dict group', () => {
    const memory = specAt('memory');
    expect(memory.type).toBe('dict');
    expect(memory.required).toBeFalsy();
    expect(memory.description).toBeTruthy();
  });

  test('stale_threshold_days is int, default 90', () => {
    const spec = specAt('memory.stale_threshold_days');
    expect(spec.type).toBe('int');
    expect(spec.default).toBe(90);
    expect(spec.description).toBeTruthy();
  });
});

describe('PROVE_SCHEMA decomposition group', () => {
  test('decomposition is an optional dict group', () => {
    const decomposition = specAt('decomposition');
    expect(decomposition.type).toBe('dict');
    expect(decomposition.required).toBeFalsy();
    expect(decomposition.description).toBeTruthy();
  });

  test('auto_accept_through is a string enum, default "none"', () => {
    const spec = specAt('decomposition.auto_accept_through');
    expect(spec.type).toBe('str');
    expect(spec.default).toBe('none');
    expect(spec.enum).toEqual(['none', 'epic', 'story', 'task']);
    expect(spec.description).toBeTruthy();
  });
});

describe('PROVE_SCHEMA methodology-knob defaults validate clean', () => {
  test('a config built from the new-field defaults has no errors', () => {
    const config = {
      schema_version: CURRENT_SCHEMA_VERSION,
      brief: {
        single_pass_token_threshold: 8000,
        max_synthesis_retries: 2,
        prose_judge_on: true,
      },
      memory: { stale_threshold_days: 90 },
      decomposition: { auto_accept_through: 'none' },
    };
    const errors = validateConfig(config, PROVE_SCHEMA);
    const errorCount = errors.filter((e) => e.severity === 'error').length;
    expect(errorCount).toBe(0);
  });

  test('a wrong-typed brief threshold is a validation error', () => {
    const config = {
      schema_version: CURRENT_SCHEMA_VERSION,
      brief: { single_pass_token_threshold: 'lots' },
    };
    const errors = validateConfig(config, PROVE_SCHEMA);
    expect(
      errors.some((e) => e.path === 'brief.single_pass_token_threshold' && e.severity === 'error'),
    ).toBe(true);
  });

  test('an out-of-enum auto_accept_through is a validation error', () => {
    const config = {
      schema_version: CURRENT_SCHEMA_VERSION,
      decomposition: { auto_accept_through: 'milestone' },
    };
    const errors = validateConfig(config, PROVE_SCHEMA);
    expect(
      errors.some((e) => e.path === 'decomposition.auto_accept_through' && e.severity === 'error'),
    ).toBe(true);
  });

  test('every valid auto_accept_through layer passes', () => {
    for (const layer of ['none', 'epic', 'story', 'task']) {
      const config = {
        schema_version: CURRENT_SCHEMA_VERSION,
        decomposition: { auto_accept_through: layer },
      };
      const errors = validateConfig(config, PROVE_SCHEMA);
      const errorCount = errors.filter((e) => e.severity === 'error').length;
      expect(errorCount).toBe(0);
    }
  });
});
