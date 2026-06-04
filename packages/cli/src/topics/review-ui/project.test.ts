/**
 * Tests for the `review-ui project` sub-action dispatch.
 *
 * Each test drives `runProject` directly against a tmp registry base dir (the
 * `baseOverride` seam), so the developer's real `~/.claude-prove/projects.json`
 * is never touched. stdout/stderr are captured to assert the JSON list contract
 * and the human summaries; the registry module's own functions are exercised
 * end-to-end (no mocking) to prove verb routing and prune-on-read.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { add, list, read } from '@claude-prove/store';
import { runProject } from './project';

let baseDir: string;
let projectsDir: string;
let stdoutBuf: string;
let stderrBuf: string;

/** A live project root: an existing dir containing `.prove/prove.db`. */
function makeAliveRoot(name: string): string {
  const root = join(projectsDir, name);
  mkdirSync(join(root, '.prove'), { recursive: true });
  writeFileSync(join(root, '.prove', 'prove.db'), '');
  return root;
}

function run(
  action: string,
  path?: string,
): {
  exit: number;
  stdout: string;
  stderr: string;
} {
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  stdoutBuf = '';
  stderrBuf = '';
  process.stdout.write = ((c: string | Uint8Array) => {
    stdoutBuf += typeof c === 'string' ? c : Buffer.from(c).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => {
    stderrBuf += typeof c === 'string' ? c : Buffer.from(c).toString('utf8');
    return true;
  }) as typeof process.stderr.write;
  try {
    const exit = runProject({ action, path, baseOverride: baseDir });
    return { exit, stdout: stdoutBuf, stderr: stderrBuf };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'rui-proj-base-'));
  projectsDir = mkdtempSync(join(tmpdir(), 'rui-proj-roots-'));
});

afterEach(() => {
  for (const d of [baseDir, projectsDir]) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

describe('review-ui project — verb routing', () => {
  test('unknown sub-action exits 1 with usage naming hide/remove/add', () => {
    const r = run('bogus', '/some/path');
    expect(r.exit).toBe(1);
    expect(r.stderr).toContain('hide');
    expect(r.stderr).toContain('remove');
    expect(r.stderr).toContain('add');
  });

  test('empty sub-action exits 1 with usage (project with no verb)', () => {
    const r = run('', undefined);
    expect(r.exit).toBe(1);
    expect(r.stderr).toMatch(/hide|remove|add/i);
  });

  test('add registers the root; list reflects it as JSON', () => {
    const root = makeAliveRoot('alpha');
    const a = run('add', root);
    expect(a.exit).toBe(0);
    expect(a.stderr).toContain(`added ${root}`);

    const l = run('list');
    expect(l.exit).toBe(0);
    const rows = JSON.parse(l.stdout);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ path: root, name: 'alpha' });
    expect(typeof rows[0].last_seen).toBe('string');
  });

  test('hide drops the root from list but keeps it on disk', () => {
    const root = makeAliveRoot('beta');
    run('add', root);
    const h = run('hide', root);
    expect(h.exit).toBe(0);
    expect(h.stderr).toContain(`hid ${root}`);

    expect(JSON.parse(run('list').stdout)).toEqual([]);
    // Still on disk (hidden, not removed).
    expect(read(baseDir).projects.some((p) => p.path === root)).toBe(true);
  });

  test('remove deletes the root entirely', () => {
    const root = makeAliveRoot('gamma');
    run('add', root);
    const r = run('remove', root);
    expect(r.exit).toBe(0);
    expect(r.stderr).toContain(`removed ${root}`);
    expect(read(baseDir).projects.some((p) => p.path === root)).toBe(false);
  });

  test('hide/remove on an unregistered path is a 0-exit no-op', () => {
    const ghost = join(projectsDir, 'never-registered');
    const h = run('hide', ghost);
    expect(h.exit).toBe(0);
    expect(h.stderr).toContain('not registered');
    const rm = run('remove', ghost);
    expect(rm.exit).toBe(0);
    expect(rm.stderr).toContain('not registered');
  });
});

describe('review-ui project — prune-on-read', () => {
  test('list drops a root whose dir vanished before listing', () => {
    const alive = makeAliveRoot('live');
    const dead = makeAliveRoot('dead');
    run('add', alive);
    run('add', dead);
    expect(JSON.parse(run('list').stdout)).toHaveLength(2);

    // The dead root disappears off disk; list must prune it before emitting.
    rmSync(dead, { recursive: true, force: true });
    const rows = JSON.parse(run('list').stdout);
    expect(rows).toHaveLength(1);
    expect(rows[0].path).toBe(alive);
    // And the prune is persisted, not just filtered from the view.
    expect(read(baseDir).projects.some((p) => p.path === dead)).toBe(false);
  });

  test('list drops a root whose .prove/prove.db vanished', () => {
    const root = makeAliveRoot('no-db');
    // Seed via the registry directly, then strip the db so the entry is dead.
    add(root, baseDir);
    rmSync(join(root, '.prove', 'prove.db'), { force: true });
    const rows = JSON.parse(run('list').stdout);
    expect(rows.some((p: { path: string }) => p.path === root)).toBe(false);
  });
});
