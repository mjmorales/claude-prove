/**
 * Hook parity — asserts the TS hooks match the frozen Python-reference
 * captures byte-for-byte on every case.
 *
 * `python-captures/` is a frozen snapshot of the original Python hooks'
 * stdout/stderr/exit; the originals are deleted, so the captures cannot
 * be regenerated — they are the reference. Any drift for an identical
 * payload + setup fails here, pointing straight at the offending case.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const FIXTURES = join(import.meta.dir, '../__fixtures__/hooks');
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

describe('hook byte-parity with frozen Python-reference captures', () => {
  if (!existsSync(PY_CAP) || !existsSync(TS_CAP)) {
    test.skip('captures missing under __fixtures__/hooks/', () => {});
    return;
  }

  const pyFiles = walk(PY_CAP).map((f) => relative(PY_CAP, f));
  const tsFiles = walk(TS_CAP).map((f) => relative(TS_CAP, f));

  test('capture layouts match', () => {
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
