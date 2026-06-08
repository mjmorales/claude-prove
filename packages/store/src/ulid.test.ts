import { describe, expect, test } from 'bun:test';
import { isUlid, ulid } from './ulid';

describe('ulid', () => {
  test('mints a 26-char Crockford-base32 id', () => {
    const id = ulid();
    expect(id).toHaveLength(26);
    expect(isUlid(id)).toBe(true);
    // Crockford alphabet excludes I, L, O, U.
    expect(id).not.toMatch(/[ILOU]/);
  });

  test('two ids minted back-to-back are distinct', () => {
    const a = ulid();
    const b = ulid();
    expect(a).not.toBe(b);
  });

  test('is monotonic within a single millisecond (later id sorts strictly after earlier)', () => {
    // Pin the clock to one millisecond so every id shares the time prefix; the
    // monotonic random increment must still order them strictly ascending.
    const fixed = 1_700_000_000_000;
    const ids: string[] = [];
    for (let i = 0; i < 50; i++) ids.push(ulid(fixed));

    for (let i = 1; i < ids.length; i++) {
      expect(ids[i] > ids[i - 1]).toBe(true);
    }
    // No collisions within the same millisecond.
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('lexicographic order tracks time order across milliseconds', () => {
    const earlier = ulid(1_700_000_000_000);
    const later = ulid(1_700_000_000_001);
    expect(later > earlier).toBe(true);
  });

  test('isUlid rejects wrong length and out-of-alphabet chars', () => {
    expect(isUlid('TOOSHORT')).toBe(false);
    expect(isUlid('0123456789ABCDEFGHJKMNPQRS')).toBe(true);
    // Same length but contains an excluded letter (I).
    expect(isUlid('0123456789ABCDEFGHJKMNPQRI')).toBe(false);
  });
});
