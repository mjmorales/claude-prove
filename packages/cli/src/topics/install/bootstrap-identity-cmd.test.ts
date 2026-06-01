import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BootstrapIdentityFlags, runBootstrapIdentity } from './bootstrap-identity-cmd';

function flags(overrides: Partial<BootstrapIdentityFlags>): BootstrapIdentityFlags {
  return {
    withCharter: false,
    withTeam: false,
    full: false,
    dryRun: false,
    json: false,
    ...overrides,
  };
}

describe('runBootstrapIdentity flag mapping', () => {
  test('no selection flags is a usage error (exit 1)', () => {
    expect(runBootstrapIdentity(flags({}))).toBe(1);
  });

  test('contributor selection without an id is a usage error (exit 1)', () => {
    // --full implies contributor; with no --contributor id it must fail fast.
    const root = mkdtempSync(join(tmpdir(), 'bootstrap-cmd-'));
    try {
      expect(runBootstrapIdentity(flags({ full: true, cwd: root }))).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a valid selection on a non-git dir surfaces pre-flight failure (exit 1)', () => {
    const root = mkdtempSync(join(tmpdir(), 'bootstrap-cmd-nogit-'));
    try {
      expect(runBootstrapIdentity(flags({ withCharter: true, cwd: root, dryRun: true }))).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
