/**
 * JSON Schema (draft-07) emitter for the FieldSpec schema model.
 *
 * Converts `PROVE_SCHEMA` into a standard JSON Schema document that editors
 * (VS Code, Cursor, JetBrains) consume for `.claude/.prove.json` autocomplete,
 * hover docs, and inline validation. The conversion is purely mechanical —
 * `PROVE_SCHEMA` in `schemas.ts` stays the single source of truth and the
 * checked-in artifact (`schemas/prove.schema.json`) is regenerated via
 * `scripts/generate-json-schema.ts` (a drift-guard test enforces sync).
 *
 * Mapping (FieldSpec -> JSON Schema):
 *   - str/int/bool        -> string/integer/boolean (+ enum when present)
 *   - list + items        -> array + items
 *   - dict + fields       -> object + properties + required +
 *                            additionalProperties: false (the CLI validator
 *                            only WARNS on unknown keys; the editor schema
 *                            surfaces the same finding as a squiggle)
 *   - dict + values       -> object + additionalProperties: <value schema>
 *   - dict (bare) / any   -> object / unconstrained ({})
 *   - description/default -> carried through verbatim
 *
 * The root document additionally allows a `$schema` key so configs can embed
 * the editor reference; `validate.ts` skips that key for the same reason.
 */

import { CURRENT_SCHEMA_VERSION, type FieldSpec, PROVE_SCHEMA, type Schema } from './schemas';

/** Canonical URL of the published artifact (raw main-branch path). */
export const PROVE_JSON_SCHEMA_ID =
  'https://raw.githubusercontent.com/mjmorales/claude-prove/main/schemas/prove.schema.json';

/** Loosely-typed JSON Schema node — consumers serialize, never introspect. */
export type JsonSchemaNode = Record<string, unknown>;

/** Convert a single FieldSpec subtree to its JSON Schema equivalent. */
export function fieldSpecToJsonSchema(spec: FieldSpec): JsonSchemaNode {
  const node: JsonSchemaNode = {};

  switch (spec.type) {
    case 'str':
      node.type = 'string';
      break;
    case 'int':
      node.type = 'integer';
      break;
    case 'bool':
      node.type = 'boolean';
      break;
    case 'list':
      node.type = 'array';
      if (spec.items) {
        node.items = fieldSpecToJsonSchema(spec.items);
      }
      break;
    case 'dict':
      node.type = 'object';
      if (spec.fields) {
        node.properties = mapFields(spec.fields);
        const required = requiredKeys(spec.fields);
        if (required.length > 0) {
          node.required = required;
        }
        node.additionalProperties = false;
      } else if (spec.values) {
        node.additionalProperties = fieldSpecToJsonSchema(spec.values);
      }
      break;
    case 'any':
      // Unconstrained — an empty schema accepts every JSON value.
      break;
  }

  if (spec.enum) {
    node.enum = [...spec.enum];
  }
  if (spec.description !== undefined) {
    node.description = spec.description;
  }
  if (spec.default !== undefined) {
    node.default = spec.default;
  }

  return node;
}

/** Convert a full FieldSpec Schema envelope to a root JSON Schema document. */
export function schemaToJsonSchema(
  schema: Schema,
  meta: { $id: string; title: string; description: string },
): JsonSchemaNode {
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: meta.$id,
    $comment:
      'Generated from PROVE_SCHEMA (packages/cli/src/topics/schema/schemas.ts) ' +
      'by scripts/generate-json-schema.ts — do not edit by hand.',
    title: meta.title,
    description: meta.description,
    type: 'object',
    properties: {
      $schema: {
        type: 'string',
        description: 'JSON Schema reference for editor autocomplete (ignored by claude-prove)',
      },
      ...mapFields(schema.fields),
    },
    required: requiredKeys(schema.fields),
    additionalProperties: false,
  };
}

/** The published `.claude/.prove.json` editor schema at the current version. */
export function proveJsonSchema(): JsonSchemaNode {
  return schemaToJsonSchema(PROVE_SCHEMA, {
    $id: PROVE_JSON_SCHEMA_ID,
    title: '.claude/.prove.json',
    description: `claude-prove project configuration (schema v${CURRENT_SCHEMA_VERSION})`,
  });
}

function mapFields(fields: Record<string, FieldSpec>): Record<string, JsonSchemaNode> {
  const properties: Record<string, JsonSchemaNode> = {};
  for (const [name, spec] of Object.entries(fields)) {
    properties[name] = fieldSpecToJsonSchema(spec);
  }
  return properties;
}

function requiredKeys(fields: Record<string, FieldSpec>): string[] {
  return Object.entries(fields)
    .filter(([, spec]) => spec.required)
    .map(([name]) => name);
}
