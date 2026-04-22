import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, MissingConfigError, loadToolConfig } from './tool-config';

interface TestDefaults extends Record<string, unknown> {
  excludes: string[];
  max_file_size: number;
  concurrency: number;
  batch_size: number;
  triage: boolean;
}

const TEST_DEFAULTS: TestDefaults = {
  excludes: [],
  max_file_size: 102400,
  concurrency: 3,
  batch_size: 25,
  triage: true,
};

function makeProject(config: unknown | null): string {
  const root = mkdtempSync(join(tmpdir(), 'tool-config-'));
  mkdirSync(join(root, '.claude'));
  if (config !== null) {
    writeFileSync(
      join(root, '.claude', '.prove.json'),
      typeof config === 'string' ? config : JSON.stringify(config),
      'utf8',
    );
  }
  return root;
}

describe('loadToolConfig', () => {
  test('reads overrides from tools.<name>.config', () => {
    const root = makeProject({
      schema_version: '4',
      tools: {
        cafi: {
          enabled: true,
          config: {
            excludes: ['dist/', '*.log'],
            concurrency: 8,
          },
        },
      },
    });
    try {
      const cfg = loadToolConfig(root, 'cafi', TEST_DEFAULTS);
      expect(cfg.excludes).toEqual(['dist/', '*.log']);
      expect(cfg.concurrency).toBe(8);
      // Unspecified fields keep defaults.
      expect(cfg.max_file_size).toBe(102400);
      expect(cfg.triage).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('unknown tool name returns defaults unchanged', () => {
    const root = makeProject({
      schema_version: '4',
      tools: { other: { enabled: true, config: { concurrency: 99 } } },
    });
    try {
      const cfg = loadToolConfig(root, 'cafi', TEST_DEFAULTS);
      expect(cfg).toEqual(TEST_DEFAULTS);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('missing file throws when require is true', () => {
    const root = mkdtempSync(join(tmpdir(), 'tool-config-missing-'));
    try {
      expect(() => loadToolConfig(root, 'cafi', TEST_DEFAULTS)).toThrow(MissingConfigError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('missing file returns defaults when require is false', () => {
    const root = mkdtempSync(join(tmpdir(), 'tool-config-optional-'));
    try {
      const cfg = loadToolConfig(root, 'cafi', TEST_DEFAULTS, { require: false });
      expect(cfg).toEqual(TEST_DEFAULTS);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('malformed JSON falls back to defaults and logs a warning', () => {
    const root = makeProject('{ invalid json');
    const warnings: string[] = [];
    try {
      const cfg = loadToolConfig(
        root,
        'cafi',
        TEST_DEFAULTS,
        {},
        {
          warn: (m: string) => warnings.push(m),
        },
      );
      expect(cfg).toEqual(TEST_DEFAULTS);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('Could not read config');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('user overrides merge on top of defaults', () => {
    const root = makeProject({
      schema_version: '4',
      tools: {
        pcd: {
          enabled: true,
          config: {
            batch_size: 50,
            triage: false,
            custom_field: 'hello',
          },
        },
      },
    });
    try {
      const cfg = loadToolConfig(root, 'pcd', TEST_DEFAULTS);
      expect(cfg.batch_size).toBe(50);
      expect(cfg.triage).toBe(false);
      expect(cfg.concurrency).toBe(3); // default preserved
      expect(cfg.custom_field).toBe('hello'); // extra user key passes through
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('does NOT read legacy top-level index key (post-v4)', () => {
    const root = makeProject({
      schema_version: '4',
      index: { excludes: ['legacy/'], concurrency: 999 },
    });
    try {
      const cfg = loadToolConfig(root, 'cafi', TEST_DEFAULTS);
      // Legacy key must be ignored; defaults survive.
      expect(cfg.excludes).toEqual([]);
      expect(cfg.concurrency).toBe(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('tools entry without config key returns defaults', () => {
    const root = makeProject({
      schema_version: '4',
      tools: { cafi: { enabled: true } },
    });
    try {
      const cfg = loadToolConfig(root, 'cafi', TEST_DEFAULTS);
      expect(cfg).toEqual(TEST_DEFAULTS);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('DEFAULT_CONFIG shape matches the Python port', () => {
    expect(DEFAULT_CONFIG).toEqual({
      excludes: [],
      max_file_size: 102400,
      concurrency: 3,
      batch_size: 25,
      triage: true,
    });
  });
});
