/**
 * Cross-package conformance gate for the reasoning-log entry taxonomy.
 *
 * The story-close synthesis floor lives in `@claude-prove/store`
 * (`scrum-writes.ts`) and carries a scope-narrowed COPY of the reasoning-log
 * validator — `SCAN_ENTRY_TYPES` / `SCAN_TYPE_SPECS` — because the dependency
 * graph runs store ← cli, so the store cannot import the CLI's canonical
 * `ENTRY_TYPES` / `TYPE_SPECS` from `reasoning-log.ts`.
 *
 * A copy can silently drift: if the CLI adds an entry type (or a per-type
 * required/optional field) and the store copy isn't synced, the floor's
 * fail-closed strict scan rejects a now-valid entry and blocks story-close.
 * This test imports BOTH copies and asserts their closed sets are identical, so
 * CI fails the moment either side changes without the other. It lives in the
 * CLI package because only the CLI can import `@claude-prove/store` AND its own
 * `reasoning-log.ts` without a cycle.
 */

import { describe, expect, test } from 'bun:test';
import { SCAN_ENTRY_TYPES, SCAN_TYPE_SPECS } from '@claude-prove/store';
import { ENTRY_TYPES, TYPE_SPECS } from './reasoning-log';

describe('reasoning-log store/cli conformance', () => {
  test('entry-type taxonomy is identical on both sides', () => {
    expect([...SCAN_ENTRY_TYPES]).toEqual([...ENTRY_TYPES]);
  });

  test('per-type required + optional field keys are identical on both sides', () => {
    // Validator functions are anonymous closures and cannot be compared, but a
    // drift that matters always changes the field KEY SET (a new required or
    // optional field), so key-parity per type is the load-bearing assertion.
    const scanKeys = fieldKeyMap(SCAN_TYPE_SPECS);
    const canonicalKeys = fieldKeyMap(TYPE_SPECS);
    expect(scanKeys).toEqual(canonicalKeys);
  });
});

/** Map each entry type to its sorted required + optional field keys. */
function fieldKeyMap(
  specs: Record<string, { fields: Record<string, unknown>; optional?: Record<string, unknown> }>,
): Record<string, { required: string[]; optional: string[] }> {
  const out: Record<string, { required: string[]; optional: string[] }> = {};
  for (const [type, spec] of Object.entries(specs)) {
    out[type] = {
      required: Object.keys(spec.fields).sort(),
      optional: Object.keys(spec.optional ?? {}).sort(),
    };
  }
  return out;
}
