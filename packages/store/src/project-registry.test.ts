/**
 * Unit tests for the machine-global project auto-registry. Every test drives the
 * registry through an explicit base-dir override pointed at a fresh tmp dir, so
 * the developer's real `~/.claude-prove/projects.json` is NEVER touched.
 *
 * Each test seeds the file directly (with controlled `last_seen` timestamps
 * where staleness matters) and asserts the public surface — atomicity (no
 * partial file mid-write), the new-or-stale upsert gate, worktree → main-root
 * folding, and corrupt-file backup-aside.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import {
  type ProjectRegistry,
  add,
  canonicalProjectRoot,
  hide,
  list,
  prune,
  read,
  registryFilePath,
  remove,
  upsert,
} from './project-registry';

let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'prove-project-registry-'));
});

afterEach(() => {
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

/** Write a registry object verbatim to the override's `projects.json`. */
function seed(registry: ProjectRegistry): void {
  writeFileSync(registryFilePath(base), JSON.stringify(registry, null, 2), 'utf8');
}

/** An ISO timestamp `ms` milliseconds before now. */
function ago(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

/** A live project root: a real dir holding `.prove/prove.db`. */
function makeLiveProject(name: string): string {
  const root = join(base, name);
  mkdirSync(join(root, '.prove'), { recursive: true });
  writeFileSync(join(root, '.prove', 'prove.db'), 'sqlite', 'utf8');
  return root;
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe('project-registry: absent file', () => {
  test('read returns an empty registry, no throw', () => {
    expect(read(base)).toEqual({ projects: [] });
  });

  test('list against an absent file returns an empty array', () => {
    expect(list(base)).toEqual([]);
  });
});

describe('project-registry: atomicity', () => {
  test('upsert leaves no .tmp sibling and a fully-formed JSON file', () => {
    const root = makeLiveProject('proj-a');
    upsert(root, base);

    const dir = join(base);
    const stragglers = readdirSync(dir).filter((f) => f.endsWith('.tmp'));
    expect(stragglers).toEqual([]);

    // The destination always parses cleanly — never a half-written fragment.
    const raw = readFileSync(registryFilePath(base), 'utf8');
    const parsed = JSON.parse(raw) as ProjectRegistry;
    expect(parsed.projects).toHaveLength(1);
    expect(parsed.projects[0].path).toBe(root);
  });
});

describe('project-registry: upsert new-or-stale gate', () => {
  test('a fresh entry is NOT re-bumped within 24h', () => {
    const root = makeLiveProject('proj-a');
    const fresh = ago(HOUR); // seen one hour ago — well inside the window
    seed({ projects: [{ path: root, name: basename(root), last_seen: fresh }] });

    const result = upsert(root, base);
    expect(result.last_seen).toBe(fresh); // unchanged
    expect(read(base).projects[0].last_seen).toBe(fresh);
  });

  test('a stale entry (older than 24h) IS bumped', () => {
    const root = makeLiveProject('proj-a');
    const stale = ago(DAY + HOUR); // seen 25 hours ago — past the window
    seed({ projects: [{ path: root, name: basename(root), last_seen: stale }] });

    const result = upsert(root, base);
    expect(result.last_seen).not.toBe(stale);
    expect(Date.parse(result.last_seen)).toBeGreaterThan(Date.parse(stale));
  });

  test('an absent path is created and stamped', () => {
    const root = makeLiveProject('proj-a');
    const result = upsert(root, base);
    expect(result.path).toBe(root);
    expect(result.name).toBe(basename(root));
    expect(read(base).projects).toHaveLength(1);
  });
});

describe('project-registry: worktree folding', () => {
  test('a sub-task worktree path maps to the main repo root', () => {
    const mainRoot = '/Users/dev/myrepo';
    const worktree = join(mainRoot, '.claude', 'worktrees', 's1-foundation-task-1.1');
    expect(canonicalProjectRoot(worktree)).toBe(mainRoot);
  });

  test('a non-worktree path is returned unchanged (resolved)', () => {
    expect(canonicalProjectRoot('/Users/dev/myrepo')).toBe('/Users/dev/myrepo');
  });

  test('upsert from a worktree path registers the main root', () => {
    const mainRoot = makeLiveProject('myrepo');
    const worktree = join(mainRoot, '.claude', 'worktrees', 's1-foundation-task-1.1');
    const result = upsert(worktree, base);
    expect(result.path).toBe(mainRoot);
    expect(read(base).projects).toHaveLength(1);
    expect(read(base).projects[0].path).toBe(mainRoot);
  });
});

describe('project-registry: corrupt file backup-aside', () => {
  test('malformed JSON is treated as empty AND copied to a .bak sibling', () => {
    writeFileSync(registryFilePath(base), '{ not valid json', 'utf8');

    expect(read(base)).toEqual({ projects: [] });

    const baks = readdirSync(base).filter((f) => f.includes('.bak'));
    expect(baks).toHaveLength(1);
    // The original corrupt bytes are preserved in the backup.
    expect(readFileSync(join(base, baks[0]), 'utf8')).toBe('{ not valid json');
  });

  test('a top-level JSON array is treated as empty AND backed up', () => {
    writeFileSync(registryFilePath(base), JSON.stringify(['not', 'an', 'object']), 'utf8');
    expect(read(base)).toEqual({ projects: [] });
    expect(readdirSync(base).filter((f) => f.includes('.bak'))).toHaveLength(1);
  });

  test('a missing projects array is treated as empty AND backed up', () => {
    writeFileSync(registryFilePath(base), JSON.stringify({ other: true }), 'utf8');
    expect(read(base)).toEqual({ projects: [] });
    expect(readdirSync(base).filter((f) => f.includes('.bak'))).toHaveLength(1);
  });
});

describe('project-registry: prune', () => {
  test('drops entries whose root or prove.db no longer exists', () => {
    const live = makeLiveProject('live');
    const goneRoot = join(base, 'gone'); // never created on disk
    const noDb = join(base, 'nodb');
    mkdirSync(noDb, { recursive: true }); // dir exists, but no .prove/prove.db

    seed({
      projects: [
        { path: live, name: 'live', last_seen: ago(HOUR) },
        { path: goneRoot, name: 'gone', last_seen: ago(HOUR) },
        { path: noDb, name: 'nodb', last_seen: ago(HOUR) },
      ],
    });

    const dropped = prune(base);
    expect(dropped.sort()).toEqual([goneRoot, noDb].sort());
    expect(read(base).projects.map((p) => p.path)).toEqual([live]);
  });

  test('is a no-op (no write) when nothing is stale on disk', () => {
    const live = makeLiveProject('live');
    seed({ projects: [{ path: live, name: 'live', last_seen: ago(HOUR) }] });
    expect(prune(base)).toEqual([]);
  });
});

describe('project-registry: manual hide / remove / add', () => {
  test('list excludes hidden entries; read retains them', () => {
    const a = makeLiveProject('a');
    const b = makeLiveProject('b');
    seed({
      projects: [
        { path: a, name: 'a', last_seen: ago(HOUR) },
        { path: b, name: 'b', last_seen: ago(2 * HOUR) },
      ],
    });

    expect(hide(a, base)).toBe(true);
    expect(list(base).map((p) => p.path)).toEqual([b]);
    expect(read(base).projects).toHaveLength(2); // retained on disk
  });

  test('hide on an unregistered root is a no-op', () => {
    expect(hide('/Users/dev/never-seen', base)).toBe(false);
  });

  test('remove drops the entry entirely', () => {
    const a = makeLiveProject('a');
    seed({ projects: [{ path: a, name: 'a', last_seen: ago(HOUR) }] });
    expect(remove(a, base)).toBe(true);
    expect(read(base).projects).toEqual([]);
  });

  test('add un-hides and re-stamps an existing hidden entry', () => {
    const a = makeLiveProject('a');
    const old = ago(DAY * 3);
    seed({ projects: [{ path: a, name: 'a', last_seen: old, hidden: true }] });

    const result = add(a, base);
    expect(result.hidden).toBeUndefined();
    expect(Date.parse(result.last_seen)).toBeGreaterThan(Date.parse(old));
    expect(list(base).map((p) => p.path)).toEqual([a]); // visible again
  });

  test('list sorts most-recently-seen first', () => {
    const a = makeLiveProject('a');
    const b = makeLiveProject('b');
    seed({
      projects: [
        { path: a, name: 'a', last_seen: ago(3 * HOUR) },
        { path: b, name: 'b', last_seen: ago(HOUR) },
      ],
    });
    expect(list(base).map((p) => p.path)).toEqual([b, a]);
  });
});

describe('project-registry: preserves unrelated top-level keys', () => {
  test('a write round-trips an unknown top-level key', () => {
    const a = makeLiveProject('a');
    const stale = ago(DAY + HOUR);
    writeFileSync(
      registryFilePath(base),
      JSON.stringify({
        future_setting: { keep: true },
        projects: [{ path: a, name: 'a', last_seen: stale }],
      }),
      'utf8',
    );

    upsert(a, base); // triggers a write (entry is stale)
    expect(read(base).future_setting).toEqual({ keep: true });
  });
});

describe('project-registry: file path resolution', () => {
  test('registryFilePath honors the explicit base override', () => {
    expect(registryFilePath(base)).toBe(join(base, 'projects.json'));
  });

  test('an absolute non-worktree path resolves to itself', () => {
    const abs = '/Users/dev/plain-repo';
    expect(canonicalProjectRoot(abs)).toBe(resolve(abs));
  });
});
