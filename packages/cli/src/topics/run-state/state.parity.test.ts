/**
 * Parity tests — assert the bytes written by state.ts are identical to
 * the frozen Python-reference captures for the same mutator sequence.
 *
 * The captures under `__fixtures__/state/` are a frozen snapshot of the
 * original Python implementation's output; this test reads both sides
 * and compares them byte-for-byte.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const STATE_FIXTURES = join(import.meta.dir, '__fixtures__/state');
const PY_CAP = join(STATE_FIXTURES, 'python-captures');
const TS_CAP = join(STATE_FIXTURES, 'ts-captures');

function walkFiles(root: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(root).sort()) {
    const abs = join(root, name);
    const stat = statSync(abs);
    if (stat.isDirectory()) {
      out.push(...walkFiles(abs));
    } else {
      out.push(abs);
    }
  }
  return out;
}

describe('state.ts byte-parity with Python state.py', () => {
  const pyFiles = walkFiles(PY_CAP).map((f) => relative(PY_CAP, f));
  const tsFiles = walkFiles(TS_CAP).map((f) => relative(TS_CAP, f));

  test('both sides produce the same set of capture files', () => {
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
