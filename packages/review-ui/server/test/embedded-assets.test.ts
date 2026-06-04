/**
 * Tests for the embedded-web-bundle accessor.
 *
 * `materializeEmbeddedWebRoot` returns null when NOT running from a compiled
 * binary — the only branch unit-testable without an actual compiled artifact
 * (`Bun.embeddedFiles` is empty under `bun test`, and the provenance gate short-
 * circuits before any filesystem work). The full extract-and-serve path is
 * covered by the compiled-binary end-to-end acceptance check at the validation
 * gate, not here.
 */

import { describe, expect, test } from 'bun:test';
import { materializeEmbeddedWebRoot } from '../src/embedded-assets';

describe('materializeEmbeddedWebRoot', () => {
  test('returns null when not running from a compiled binary', () => {
    // Under `bun test` the process is not a compiled binary, so the provenance
    // gate returns null before touching the registry base dir.
    expect(materializeEmbeddedWebRoot()).toBeNull();
  });

  test('returns null even with a base override when not compiled', () => {
    // The base override is the cache-dir test seam, but the provenance gate is
    // checked first — a non-compiled process never reaches cache materialization.
    expect(materializeEmbeddedWebRoot('/tmp/prove-embed-test-base')).toBeNull();
  });
});
