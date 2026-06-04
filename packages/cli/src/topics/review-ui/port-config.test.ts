/**
 * Tests for machine-global review-ui port resolution.
 *
 * The port lives under `~/.claude-prove/config.json::review_ui_port`. A tmp dir
 * stands in for that home root (the base-override seam), so these never read the
 * developer's real machine config.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_REVIEW_UI_PORT, resolveReviewUiPort } from './port-config';

/** Fresh tmp dir standing in for `~/.claude-prove` (the base-override seam). */
function makeBase(): string {
  return mkdtempSync(join(tmpdir(), 'rui-port-config-'));
}

/** Write a machine config carrying the given top-level keys. */
function writeMachineConfig(base: string, body: Record<string, unknown>): void {
  writeFileSync(join(base, 'config.json'), JSON.stringify(body), 'utf8');
}

describe('resolveReviewUiPort', () => {
  test('falls back to the default when the config file is absent', () => {
    const base = makeBase();
    try {
      expect(resolveReviewUiPort({ baseOverride: base })).toBe(DEFAULT_REVIEW_UI_PORT);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('reads a numeric review_ui_port from the machine config', () => {
    const base = makeBase();
    try {
      writeMachineConfig(base, { default_contributors: {}, review_ui_port: 6000 });
      expect(resolveReviewUiPort({ baseOverride: base })).toBe(6000);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('coerces a numeric-string review_ui_port', () => {
    const base = makeBase();
    try {
      writeMachineConfig(base, { default_contributors: {}, review_ui_port: '6100' });
      expect(resolveReviewUiPort({ baseOverride: base })).toBe(6100);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('falls back to the default when review_ui_port is absent or invalid', () => {
    const base = makeBase();
    try {
      writeMachineConfig(base, { default_contributors: {}, review_ui_port: 'not-a-port' });
      expect(resolveReviewUiPort({ baseOverride: base })).toBe(DEFAULT_REVIEW_UI_PORT);

      writeMachineConfig(base, { default_contributors: {} });
      expect(resolveReviewUiPort({ baseOverride: base })).toBe(DEFAULT_REVIEW_UI_PORT);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('falls back to the default on a malformed config file', () => {
    const base = makeBase();
    try {
      writeFileSync(join(base, 'config.json'), '{ not json', 'utf8');
      expect(resolveReviewUiPort({ baseOverride: base })).toBe(DEFAULT_REVIEW_UI_PORT);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
