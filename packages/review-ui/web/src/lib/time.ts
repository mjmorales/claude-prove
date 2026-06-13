/**
 * Shared time formatting for the review UI. Promoted here from the three
 * surfaces that each had their own copy so every "Ns/m/h/d ago" label is
 * computed identically — including the NaN guard that one copy lacked.
 */

/**
 * Render an ISO timestamp as a coarse "Ns/m/h/d ago" relative string. Returns
 * the input unchanged when it does not parse, so a malformed timestamp surfaces
 * verbatim rather than as `NaN ago`.
 */
export function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diff = Date.now() - t;
  const s = Math.round(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}
