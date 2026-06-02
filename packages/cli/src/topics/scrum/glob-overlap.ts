/**
 * Glob-overlap predicate — decides whether two path globs COULD ever match the
 * same path. The core of the single-writer-per-path rule: two teams' write
 * scopes conflict when any of their write globs overlap.
 *
 * Soundness bound (read this before trusting a FALSE):
 *   The predicate is CONSERVATIVE — it is designed to never miss a real
 *   overlap (no false negatives that would let two writers silently share a
 *   path), at the cost of occasionally flagging a pair that does not actually
 *   intersect (false positives). The right failure mode for a write-wall is to
 *   over-report a conflict (forcing the operator to disambiguate two scopes)
 *   rather than to under-report one (letting two teams write the same file).
 *
 *   Concretely it decides overlap by segment-by-segment unification on the
 *   `/`-split path, treating `**` as "matches zero or more whole segments" and
 *   `*`/literal as "matches exactly one segment" (a `*` segment matches any one
 *   segment; two literal segments unify only when equal). Within-segment
 *   wildcards (`src/a*` vs `src/ab`) are not character-matched — a segment
 *   containing `*` (other than the standalone `**`) is treated as matching ANY
 *   one segment, which is the conservative direction. This handles the cases the
 *   write-wall cares about exactly:
 *     - exact equality:            `src/**`        vs `src/**`        → overlap
 *     - prefix-directory nesting:  `src/**`        vs `src/auth/**`   → overlap
 *     - a literal under a glob:    `src/auth/x.ts` vs `src/**`        → overlap
 *     - disjoint subtrees:         `src/auth/**`   vs `src/billing/**`→ no overlap
 *
 *   It is a pure, allocation-light function over the split segments — no
 *   filesystem access, so it reasons about the glob LANGUAGES, not about which
 *   paths happen to exist.
 */

/** A path glob split into `/`-delimited segments, empty segments dropped. */
function segments(glob: string): string[] {
  return glob.split('/').filter((seg) => seg.length > 0);
}

/** Whether a single segment is the recursive `**` wildcard (whole-path-spanning). */
function isDoubleStar(seg: string): boolean {
  return seg === '**';
}

/**
 * Whether two NON-`**` segments could match the same single path segment. A
 * segment containing `*` is treated as matching any one segment (the
 * conservative direction — we do not character-match within a segment); two
 * literal segments match only when equal.
 */
function segmentsUnify(a: string, b: string): boolean {
  if (a.includes('*') || b.includes('*')) return true;
  return a === b;
}

/**
 * Whether two globs (given as segment arrays) could match a common path.
 * Recursive segment unification with `**` absorbing zero or more segments on
 * either side. Conservative by construction (see module-level soundness bound).
 */
function segmentsOverlap(a: string[], b: string[]): boolean {
  // Both exhausted — the two patterns matched all the way down.
  if (a.length === 0 && b.length === 0) return true;

  // A leading `**` on either side can absorb zero or more leading segments of
  // the other, so try both "absorb nothing" and "absorb one segment" branches.
  if (a.length > 0 && isDoubleStar(a[0] as string)) {
    return segmentsOverlap(a.slice(1), b) || (b.length > 0 && segmentsOverlap(a, b.slice(1)));
  }
  if (b.length > 0 && isDoubleStar(b[0] as string)) {
    return segmentsOverlap(a, b.slice(1)) || (a.length > 0 && segmentsOverlap(a.slice(1), b));
  }

  // No `**` head on either side — both must still have a segment to match, and
  // those two segments must unify, then recurse on the tails.
  if (a.length === 0 || b.length === 0) return false;
  if (!segmentsUnify(a[0] as string, b[0] as string)) return false;
  return segmentsOverlap(a.slice(1), b.slice(1));
}

/**
 * Whether two path globs could ever match the same path. TRUE means the two
 * scopes are NOT disjoint (a single-writer-per-path violation when both are
 * write globs); FALSE means provably disjoint under the conservative model.
 *
 * Examples:
 *   globsOverlap('src/**', 'src/**')               → true  (exact equality)
 *   globsOverlap('src/**', 'src/auth/**')          → true  (prefix nesting)
 *   globsOverlap('src/auth/x.ts', 'src/**')        → true  (literal under glob)
 *   globsOverlap('src/auth/**', 'src/billing/**')  → false (disjoint subtrees)
 */
export function globsOverlap(a: string, b: string): boolean {
  return segmentsOverlap(segments(a), segments(b));
}
