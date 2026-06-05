#!/usr/bin/env bun
/**
 * Regenerate `schemas/prove.schema.json` — the JSON Schema (draft-07) editors
 * consume for `.claude/.prove.json` autocomplete — from `PROVE_SCHEMA`.
 *
 * Run after any `PROVE_SCHEMA` change (the json-schema.test.ts drift guard
 * fails until the artifact is regenerated):
 *
 *   bun run scripts/generate-json-schema.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { proveJsonSchema } from '../packages/cli/src/topics/schema/json-schema';

const outPath = join(import.meta.dir, '..', 'schemas', 'prove.schema.json');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(proveJsonSchema(), null, 2)}\n`);
console.log(`wrote ${outPath}`);
