/**
 * Time helpers for the ACB topic.
 */

/**
 * UTC ISO 8601 string truncated to seconds precision — matches Python's
 * `datetime.now(timezone.utc).isoformat(timespec="seconds")`, which yields
 * `2026-04-22T12:00:00+00:00` (not a `Z` suffix, not milliseconds).
 */
export function isoSeconds(): string {
  const d = new Date();
  const pad = (n: number): string => n.toString().padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+00:00`
  );
}
