/**
 * Hook parity — asserts the TS port matches `tools/run_state/hook_*.py`
 * byte-for-byte on every captured case.
 *
 * Captures are regenerated via `__fixtures__/hooks/capture.sh`; this test
 * is the cutover guard rail. Any drift in stdout/stderr/exit for an
 * identical payload + setup fails here, pointing straight at the
 * offending case.
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

describe('hook byte-parity with tools/run_state/hook_*.py', () => {
  if (!existsSync(PY_CAP) || !existsSync(TS_CAP)) {
    test.skip('captures missing — run __fixtures__/hooks/capture.sh', () => {});
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
