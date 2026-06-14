/**
 * Unit tests for `materializeNativeAddon`. The cross-process concurrency
 * guarantee (no "Cannot find native binding" under simultaneous launches) is
 * proven empirically by compiling the binary and firing concurrent bursts;
 * here we pin the on-disk contract in isolation: content-keyed path, byte
 * fidelity, idempotent reuse, and no rewrite once cached.
 *
 * The function reads its source via `readFileSync`, so a plain temp file stands
 * in for the embedded `/$bunfs` addon.
 */

import { describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { materializeNativeAddon } from './native-addon';

function tmpDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `prove-native-${label}-`));
}

function fakeAddon(bytes: Uint8Array): string {
  const dir = tmpDir('src');
  const path = join(dir, 'turso.fake.node');
  writeFileSync(path, bytes);
  return path;
}

describe('materializeNativeAddon', () => {
  test('copies the addon to a content-keyed file under <base>/native and returns it', () => {
    const base = tmpDir('base');
    const bytes = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3, 4]);
    const out = materializeNativeAddon(fakeAddon(bytes), 'turso', base);

    expect(out.startsWith(join(base, 'native', 'turso-'))).toBe(true);
    expect(out.endsWith('.node')).toBe(true);
    expect(existsSync(out)).toBe(true);
    expect(readFileSync(out)).toEqual(Buffer.from(bytes));
  });

  test('is idempotent — same source returns the same path and does not rewrite', () => {
    const base = tmpDir('base');
    const src = fakeAddon(new Uint8Array([1, 2, 3, 4, 5]));

    const first = materializeNativeAddon(src, 'turso', base);
    const mtimeAfterFirst = statSync(first).mtimeMs;
    const second = materializeNativeAddon(src, 'turso', base);

    expect(second).toBe(first);
    // The fast path is a pure stat — the cached file is untouched on reuse.
    expect(statSync(second).mtimeMs).toBe(mtimeAfterFirst);
    // No leftover tmp files in the cache dir — only the final addon.
    expect(readdirSync(join(base, 'native'))).toEqual([first.split('/').pop() as string]);
  });

  test('different content hashes to a different cache file', () => {
    const base = tmpDir('base');
    const a = materializeNativeAddon(fakeAddon(new Uint8Array([0xaa])), 'turso', base);
    const b = materializeNativeAddon(fakeAddon(new Uint8Array([0xbb])), 'turso', base);

    expect(a).not.toBe(b);
    expect(readdirSync(join(base, 'native')).length).toBe(2);
  });

  test('distinct addon names share a cache dir without colliding', () => {
    const base = tmpDir('base');
    // Same bytes, different addon name → distinct, name-prefixed cache files.
    const bytes = new Uint8Array([0x10, 0x20, 0x30]);
    const db = materializeNativeAddon(fakeAddon(bytes), 'turso', base);
    const sync = materializeNativeAddon(fakeAddon(bytes), 'sync', base);

    expect(db.startsWith(join(base, 'native', 'turso-'))).toBe(true);
    expect(sync.startsWith(join(base, 'native', 'sync-'))).toBe(true);
    expect(db).not.toBe(sync);
    expect(readdirSync(join(base, 'native')).length).toBe(2);
  });

  test('repeated materialization yields a complete, correct file (no partial writes)', () => {
    const base = tmpDir('base');
    const bytes = new Uint8Array(Array.from({ length: 4096 }, (_, i) => i % 256));
    const src = fakeAddon(bytes);

    let out = '';
    for (let i = 0; i < 25; i++) out = materializeNativeAddon(src, 'turso', base);

    expect(statSync(out).size).toBe(bytes.byteLength);
    expect(readFileSync(out)).toEqual(Buffer.from(bytes));
  });

  test('honors CLAUDE_PROVE_HOME when no override is given', () => {
    const home = tmpDir('home');
    const prev = process.env.CLAUDE_PROVE_HOME;
    process.env.CLAUDE_PROVE_HOME = home;
    try {
      const out = materializeNativeAddon(fakeAddon(new Uint8Array([9, 9, 9])), 'turso');
      expect(out.startsWith(join(home, 'native', 'turso-'))).toBe(true);
    } finally {
      // Restore precisely: unset via Reflect (assigning undefined would store
      // the literal string "undefined" and leak into sibling tests).
      if (prev === undefined) Reflect.deleteProperty(process.env, 'CLAUDE_PROVE_HOME');
      else process.env.CLAUDE_PROVE_HOME = prev;
    }
  });
});
