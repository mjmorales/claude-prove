/**
 * Monotonic ULID generator — the collision-free, lexicographically-sortable
 * TEXT id every contended insert path mints instead of relying on an
 * AUTOINCREMENT rowid.
 *
 * Why ULID, not an INTEGER rowid: under whole-transaction sync replay with a
 * single winner (the local engine's REBASE_LOCAL mode), two writers that both
 * allocate the next rowid collide on the same integer and one row is silently
 * lost on rebase. Two distinct ULIDs both survive — the id is decided by the
 * minting writer, not by a shared sequence the rebase has to reconcile.
 *
 * A ULID is 26 Crockford-base32 chars: a 48-bit millisecond timestamp (10
 * chars) followed by 80 bits of randomness (16 chars). The timestamp prefix
 * makes the lexicographic string order match chronological order, so an
 * `ORDER BY id ASC` over a ULID column reproduces the insert-order semantics
 * the old `ORDER BY id ASC` over an AUTOINCREMENT column gave.
 *
 * Monotonic within a process: when two ids are minted in the same millisecond,
 * the random component of the later one is the prior random component
 * incremented by one, so the later id always sorts strictly after the earlier
 * one. Without this, two ids in the same ms would order randomly and break the
 * insert-order read contract. The monotonic guarantee is per-process only —
 * exactly the ordering stability domain insert paths need.
 */

// Crockford's base32 alphabet — excludes I, L, O, U to avoid transcription
// ambiguity. The canonical ULID encoding alphabet.
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ENCODING_LEN = ENCODING.length; // 32
const TIME_LEN = 10;
const RANDOM_LEN = 16;

/**
 * Module-scoped monotonic state. `lastTime` is the millisecond the last id was
 * minted in; `lastRandom` is that id's 16-char random tail. A same-ms mint
 * increments `lastRandom` rather than drawing fresh randomness, so ids stay
 * strictly increasing within a millisecond.
 */
let lastTime = 0;
let lastRandom = '';

/**
 * Encode a non-negative integer time (ms) as a fixed-width Crockford-base32
 * string of `TIME_LEN` chars, most-significant char first.
 */
function encodeTime(now: number): string {
  let mod: number;
  let str = '';
  let value = now;
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    mod = value % ENCODING_LEN;
    str = ENCODING[mod] + str;
    value = (value - mod) / ENCODING_LEN;
  }
  return str;
}

/** Draw a fresh `RANDOM_LEN`-char Crockford-base32 random component. */
function randomChars(): string {
  let str = '';
  for (let i = 0; i < RANDOM_LEN; i++) {
    str += ENCODING[Math.floor(Math.random() * ENCODING_LEN)];
  }
  return str;
}

/**
 * Increment a Crockford-base32 string by one, carrying left. Returns `null`
 * when the whole string is at its max (`ZZ…Z`), the signal to fall back to a
 * fresh random draw rather than overflow. The carry-left walk mirrors how a
 * base-32 odometer rolls.
 */
function incrementRandom(random: string): string | null {
  const chars = random.split('');
  for (let i = chars.length - 1; i >= 0; i--) {
    const index = ENCODING.indexOf(chars[i]);
    if (index < ENCODING_LEN - 1) {
      chars[i] = ENCODING[index + 1];
      return chars.join('');
    }
    // This position overflowed — set it to the lowest char and carry left.
    chars[i] = ENCODING[0];
  }
  return null;
}

/**
 * Mint a monotonic ULID. Pass `seedTime` only in tests that need a fixed clock;
 * production callers omit it and the wall clock is read.
 */
export function ulid(seedTime?: number): string {
  const now = seedTime ?? Date.now();
  if (now <= lastTime) {
    // Same (or, defensively, an earlier) millisecond: increment the prior
    // random tail so this id sorts strictly after the last one. On overflow
    // (the astronomically rare all-Z tail) draw fresh randomness instead.
    const incremented = incrementRandom(lastRandom);
    lastRandom = incremented ?? randomChars();
    return encodeTime(lastTime) + lastRandom;
  }
  lastTime = now;
  lastRandom = randomChars();
  return encodeTime(now) + lastRandom;
}

/** A canonical ULID is 26 Crockford-base32 chars. Format-check only. */
export function isUlid(value: string): boolean {
  if (value.length !== TIME_LEN + RANDOM_LEN) return false;
  for (const ch of value) {
    if (ENCODING.indexOf(ch) === -1) return false;
  }
  return true;
}
