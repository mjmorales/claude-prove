import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { disabledToolsFromConfig } from './disabled-tools';

function tmpProject(config?: unknown): string {
  const root = mkdtempSync(join(tmpdir(), 'disabled-tools-'));
  if (config !== undefined) {
    mkdirSync(join(root, '.claude'), { recursive: true });
    const raw = typeof config === 'string' ? config : JSON.stringify(config);
    writeFileSync(join(root, '.claude', '.prove.json'), raw, 'utf8');
  }
  return root;
}

describe('disabledToolsFromConfig', () => {
  test('collects tools with enabled:false, ignores enabled/absent', () => {
    const root = tmpProject({
      tools: {
        acb: { enabled: false },
        cafi: { enabled: true },
        scrum: {},
        run_state: { enabled: false },
      },
    });
    try {
      const disabled = disabledToolsFromConfig(root);
      expect([...disabled].sort()).toEqual(['acb', 'run_state']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('missing config -> empty set (all enabled)', () => {
    const root = tmpProject();
    try {
      expect(disabledToolsFromConfig(root).size).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('malformed JSON -> empty set (never strips hooks on a broken config)', () => {
    const root = tmpProject('{ not json');
    try {
      expect(disabledToolsFromConfig(root).size).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('no tools key -> empty set', () => {
    const root = tmpProject({ schema_version: '6' });
    try {
      expect(disabledToolsFromConfig(root).size).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
