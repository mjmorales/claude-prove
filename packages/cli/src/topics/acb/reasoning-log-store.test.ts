/**
 * Reasoning-log filesystem IO tests: append writes the canonical
 * `log/<agent>/<id>.json` path, list merges + sorts by ts, strict rejection
 * on read of malformed or schema-invalid entry files.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendEntry, entryPath, listEntries, logRoot } from './reasoning-log-store';

let runDir: string;

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'reasoning-log-'));
});

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
});

function decision(id: string, ts: string): Record<string, unknown> {
  return {
    id,
    ts,
    type: 'decision',
    agent: 'engineer',
    run_path: runDir,
    body: 'b',
    alternatives: ['A'],
    selected_rationale: 'A',
  };
}

describe('appendEntry', () => {
  test('writes to log/<agent>/<id>.json and round-trips via listEntries', () => {
    const path = appendEntry(runDir, decision('d1', '2026-05-31T10:00:00Z'));
    expect(path).toBe(entryPath(runDir, 'engineer', 'd1'));
    expect(existsSync(path)).toBe(true);

    const entries = listEntries(runDir);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe('d1');
  });

  test('throws on a schema-invalid entry (does not write)', () => {
    expect(() => appendEntry(runDir, { type: 'decision', id: 'x' })).toThrow(/invalid log entry/);
    expect(existsSync(logRoot(runDir))).toBe(false);
  });
});

describe('listEntries', () => {
  test('missing log dir => empty list', () => {
    expect(listEntries(runDir)).toEqual([]);
  });

  test('merges across agents and sorts by ts ascending', () => {
    appendEntry(runDir, { ...decision('late', '2026-05-31T12:00:00Z'), agent: 'reviewer' });
    appendEntry(runDir, decision('early', '2026-05-31T09:00:00Z'));
    const ids = listEntries(runDir).map((e) => e.id);
    expect(ids).toEqual(['early', 'late']);
  });

  test('rejects malformed JSON in an entry file', () => {
    const dir = join(logRoot(runDir), 'engineer');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'bad.json'), '{not json', 'utf8');
    expect(() => listEntries(runDir)).toThrow(/invalid JSON in log entry/);
  });

  test('rejects a schema-invalid entry file', () => {
    const dir = join(logRoot(runDir), 'engineer');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'bad.json'), JSON.stringify({ type: 'unknown', id: 'x' }), 'utf8');
    expect(() => listEntries(runDir)).toThrow(/Invalid type/);
  });
});
