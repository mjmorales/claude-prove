/**
 * Unit tests for the pure URL/tag helpers behind `install upgrade`. The
 * download + atomic-swap path is covered by the integration suite in
 * test/install-upgrade.test.ts; here we pin the URL shape and tag
 * normalization in isolation.
 */

import { describe, expect, test } from 'bun:test';
import { buildReleaseUrl, normalizeTag, resolveTarget } from './upgrade';

const ROOT = 'https://github.com/mjmorales/claude-prove/releases';

describe('buildReleaseUrl', () => {
  test('no tag → latest/download path', () => {
    expect(buildReleaseUrl(ROOT, 'darwin-arm64', undefined)).toBe(
      `${ROOT}/latest/download/claude-prove-darwin-arm64`,
    );
  });

  test('tag → download/<tag> path', () => {
    expect(buildReleaseUrl(ROOT, 'linux-x64', 'v4.0.1')).toBe(
      `${ROOT}/download/v4.0.1/claude-prove-linux-x64`,
    );
  });
});

describe('normalizeTag', () => {
  test('v-prefixed semver passes through unchanged', () => {
    expect(normalizeTag('v4.0.1')).toBe('v4.0.1');
  });

  test('bare semver gains the v prefix', () => {
    expect(normalizeTag('4.0.1')).toBe('v4.0.1');
  });

  test('prerelease suffix is accepted', () => {
    expect(normalizeTag('v4.0.0-pre.1')).toBe('v4.0.0-pre.1');
  });

  test('surrounding whitespace is trimmed', () => {
    expect(normalizeTag('  v4.0.1  ')).toBe('v4.0.1');
  });

  test.each(['latest', 'v4', '4.0', 'main', '../v4.0.1', 'v4.0.1/extra'])(
    'rejects non-semver value %p',
    (bad) => {
      expect(() => normalizeTag(bad)).toThrow(/invalid --tag/);
    },
  );
});

describe('resolveTarget', () => {
  test('returns a <platform>-<arch> string for the host', () => {
    // The host running the suite is one of the supported targets (Apple
    // Silicon or Linux); just assert the shape rather than the exact value.
    expect(resolveTarget()).toMatch(/^(darwin-arm64|linux-arm64|linux-x64)$/);
  });
});
