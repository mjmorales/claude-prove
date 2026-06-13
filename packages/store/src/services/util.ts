/**
 * Shared helpers for the store write services.
 */

/** Current instant as a millisecond-precision UTC ISO-8601 string (the `created_at`/timestamp stamp). */
export function isoNow(): string {
  return new Date().toISOString();
}
