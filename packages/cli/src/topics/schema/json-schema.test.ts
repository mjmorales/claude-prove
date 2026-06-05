import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fieldSpecToJsonSchema, proveJsonSchema } from './json-schema';
import { CURRENT_SCHEMA_VERSION } from './schemas';

describe('fieldSpecToJsonSchema', () => {
  test('scalar types map with enum, description, and default', () => {
    expect(
      fieldSpecToJsonSchema({
        type: 'str',
        enum: ['a', 'b'],
        description: 'pick one',
        default: 'a',
      }),
    ).toEqual({ type: 'string', enum: ['a', 'b'], description: 'pick one', default: 'a' });
    expect(fieldSpecToJsonSchema({ type: 'int', default: 7 })).toEqual({
      type: 'integer',
      default: 7,
    });
    expect(fieldSpecToJsonSchema({ type: 'bool' })).toEqual({ type: 'boolean' });
  });

  test('list maps to array with items', () => {
    expect(fieldSpecToJsonSchema({ type: 'list', items: { type: 'str' } })).toEqual({
      type: 'array',
      items: { type: 'string' },
    });
    expect(fieldSpecToJsonSchema({ type: 'list' })).toEqual({ type: 'array' });
  });

  test('dict with fields maps to closed object with required keys', () => {
    const node = fieldSpecToJsonSchema({
      type: 'dict',
      fields: {
        name: { type: 'str', required: true },
        phase: { type: 'str', enum: ['build', 'test'] },
      },
    });
    expect(node).toEqual({
      type: 'object',
      properties: {
        name: { type: 'string' },
        phase: { type: 'string', enum: ['build', 'test'] },
      },
      required: ['name'],
      additionalProperties: false,
    });
  });

  test('dict with no required fields omits the required array', () => {
    const node = fieldSpecToJsonSchema({
      type: 'dict',
      fields: { label: { type: 'str' } },
    });
    expect(node).not.toHaveProperty('required');
  });

  test('dict with values maps to open object with value schema', () => {
    expect(fieldSpecToJsonSchema({ type: 'dict', values: { type: 'str' } })).toEqual({
      type: 'object',
      additionalProperties: { type: 'string' },
    });
  });

  test('bare dict and any are unconstrained beyond type', () => {
    expect(fieldSpecToJsonSchema({ type: 'dict' })).toEqual({ type: 'object' });
    expect(fieldSpecToJsonSchema({ type: 'any' })).toEqual({});
  });
});

describe('proveJsonSchema', () => {
  const doc = proveJsonSchema();
  const properties = doc.properties as Record<string, Record<string, unknown>>;

  test('root envelope is a draft-07 closed object requiring schema_version', () => {
    expect(doc.$schema).toBe('http://json-schema.org/draft-07/schema#');
    expect(doc.type).toBe('object');
    expect(doc.required).toEqual(['schema_version']);
    expect(doc.additionalProperties).toBe(false);
    expect(doc.description).toContain(`v${CURRENT_SCHEMA_VERSION}`);
  });

  test('root allows the $schema editor-reference key', () => {
    expect(properties.$schema).toMatchObject({ type: 'string' });
  });

  test('validator phase enum survives the conversion', () => {
    const items = properties.validators.items as Record<string, unknown>;
    const itemProps = items.properties as Record<string, Record<string, unknown>>;
    expect(itemProps.phase.enum).toEqual(['build', 'lint', 'test', 'custom', 'llm']);
    expect(items.required).toEqual(['name', 'phase']);
  });

  test('trigger status enum survives the conversion', () => {
    const items = properties.triggers.items as Record<string, unknown>;
    const itemProps = items.properties as Record<string, Record<string, unknown>>;
    expect(itemProps.on.enum).toEqual([
      'backlog',
      'proposed',
      'accepted',
      'ready',
      'in_progress',
      'review',
      'blocked',
      'done',
      'cancelled',
    ]);
  });

  test('tools maps to per-tool value schema via additionalProperties', () => {
    const tools = properties.tools;
    const valueSchema = tools.additionalProperties as Record<string, unknown>;
    expect(valueSchema.type).toBe('object');
    expect(valueSchema.required).toEqual(['enabled']);
  });
});

describe('published artifact', () => {
  test('schemas/prove.schema.json matches the generator output (run scripts/generate-json-schema.ts on drift)', () => {
    const artifactPath = join(import.meta.dir, '../../../../../schemas/prove.schema.json');
    const onDisk = readFileSync(artifactPath, 'utf8');
    expect(onDisk).toBe(`${JSON.stringify(proveJsonSchema(), null, 2)}\n`);
  });
});
