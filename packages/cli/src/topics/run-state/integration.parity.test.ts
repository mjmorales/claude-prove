/**
 * Integration parity — assert the bytes the TS CLI writes match the
 * frozen Python-reference captures byte-for-byte for every canned
 * scenario under `__fixtures__/integration/`.
 *
 * `python-captures/` is a frozen snapshot of the original Python CLI's
 * output; it cannot be regenerated. A failure here means the CLI has
 * drifted from the reference in a way that changes on-disk bytes.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const FIXTURES = join(import.meta.dir, '__fixtures__/integration');
const PY_CAP = join(FIXTURES, 'python-captures');
const TS_CAP = join(FIXTURES, 'ts-captures');

function walk(root: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(root).sort()) {
    const abs = join(root, name);
    if (statSync(abs).isDirectory()) {
      out.push(...walk(abs));
    } else {
      out.push(abs);
    }
  }
  return out;
}

describe('run-state CLI byte-parity with frozen Python-reference captures', () => {
  const pyFiles = walk(PY_CAP).map((f) => relative(PY_CAP, f));
  const tsFiles = walk(TS_CAP).map((f) => relative(TS_CAP, f));

  test('both CLIs produce the same set of capture files', () => {
    expect(tsFiles.sort()).toEqual(pyFiles.sort());
  });

  for (const rel of pyFiles) {
    test(`byte-equal: ${rel}`, () => {
      const pyBytes = readFileSync(join(PY_CAP, rel));
      const tsBytes = readFileSync(join(TS_CAP, rel));
      expect(tsBytes.equals(pyBytes)).toBe(true);
    });
  }
});
