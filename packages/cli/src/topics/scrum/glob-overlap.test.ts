/**
 * Unit tests for `globsOverlap` — the conservative path-glob overlap predicate
 * backing the single-writer-per-path rule. The predicate must never miss a real
 * overlap (no false negatives); it may over-report (false positives), and a few
 * cases below pin that conservative direction.
 */

import { describe, expect, test } from 'bun:test';
import { globsOverlap } from './glob-overlap';

describe('globsOverlap', () => {
  test('exact equality overlaps', () => {
    expect(globsOverlap('src/**', 'src/**')).toBe(true);
    expect(globsOverlap('src/auth/login.ts', 'src/auth/login.ts')).toBe(true);
  });

  test('a prefix-directory glob overlaps its subtree', () => {
    expect(globsOverlap('src/**', 'src/auth/**')).toBe(true);
    expect(globsOverlap('src/auth/**', 'src/**')).toBe(true);
  });

  test('a literal path under a glob overlaps the glob', () => {
    expect(globsOverlap('src/auth/login.ts', 'src/**')).toBe(true);
    expect(globsOverlap('src/**', 'src/auth/login.ts')).toBe(true);
  });

  test('disjoint sibling subtrees do not overlap', () => {
    expect(globsOverlap('src/auth/**', 'src/billing/**')).toBe(false);
    expect(globsOverlap('src/a/x.ts', 'src/b/x.ts')).toBe(false);
  });

  test('different-length literal paths do not overlap', () => {
    expect(globsOverlap('src/auth', 'src/auth/login.ts')).toBe(false);
    expect(globsOverlap('a/b/c', 'a/b')).toBe(false);
  });

  test('a single-segment wildcard matches any one segment', () => {
    expect(globsOverlap('src/*/index.ts', 'src/auth/index.ts')).toBe(true);
    // `*` spans exactly one segment, so it cannot match across a directory.
    expect(globsOverlap('src/*', 'src/auth/index.ts')).toBe(false);
  });

  test('`**` absorbs zero or more segments on either side', () => {
    expect(globsOverlap('**', 'anything/at/all.ts')).toBe(true);
    expect(globsOverlap('src/**/test.ts', 'src/a/b/test.ts')).toBe(true);
    expect(globsOverlap('src/**', 'src')).toBe(true); // `**` matches zero segments
  });

  test('conservative within-segment wildcards over-report (no false negatives)', () => {
    // `src/a*` and `src/ab` are treated as a wildcard-vs-literal single-segment
    // match — flagged as overlap even though strict char-matching would agree
    // here; the point is the predicate never UNDER-reports a segment wildcard.
    expect(globsOverlap('src/a*', 'src/ab')).toBe(true);
    expect(globsOverlap('src/*.ts', 'src/login.ts')).toBe(true);
  });

  test('empty / root-ish globs', () => {
    // Two empty globs both reduce to the empty segment list — they "match" the
    // degenerate root. A non-empty glob never overlaps the empty one.
    expect(globsOverlap('', '')).toBe(true);
    expect(globsOverlap('', 'src/**')).toBe(false);
    // A bare `**` does overlap the empty glob (it absorbs zero segments).
    expect(globsOverlap('**', '')).toBe(true);
  });
});
