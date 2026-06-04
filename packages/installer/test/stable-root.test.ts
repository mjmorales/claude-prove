import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PROJECT_LINK_REL,
  ensureProjectLink,
  ensureStableRoot,
  stableRootPath,
} from '../src/stable-root';

// ensureStableRoot writes to the real home dir (~/.claude-prove/latest), so
// these tests snapshot and restore whatever link is there — the suite must
// not corrupt the developer machine's live stable root.
let savedTarget: string | undefined;
let dirA: string;
let dirB: string;

beforeEach(() => {
  try {
    savedTarget = readlinkSync(stableRootPath());
  } catch {
    savedTarget = undefined;
  }
  dirA = mkdtempSync(join(tmpdir(), 'stable-root-a-'));
  dirB = mkdtempSync(join(tmpdir(), 'stable-root-b-'));
});

afterEach(() => {
  rmSync(stableRootPath(), { force: true });
  if (savedTarget !== undefined) {
    symlinkSync(savedTarget, stableRootPath());
  }
  rmSync(dirA, { recursive: true, force: true });
  rmSync(dirB, { recursive: true, force: true });
});

describe('ensureStableRoot', () => {
  test('creates the symlink pointing at the plugin dir', () => {
    const link = ensureStableRoot(dirA);
    expect(link).toBe(stableRootPath());
    expect(readlinkSync(link)).toBe(dirA);
  });

  test('re-points an existing symlink atomically', () => {
    ensureStableRoot(dirA);
    ensureStableRoot(dirB);
    expect(readlinkSync(stableRootPath())).toBe(dirB);
  });

  test('is idempotent for the same target', () => {
    ensureStableRoot(dirA);
    ensureStableRoot(dirA);
    expect(readlinkSync(stableRootPath())).toBe(dirA);
  });

  test('throws when the plugin dir does not exist', () => {
    expect(() => ensureStableRoot(join(dirA, 'missing'))).toThrow(/does not exist/);
  });

  test('refuses to clobber a non-symlink at the link path', () => {
    rmSync(stableRootPath(), { force: true });
    mkdirSync(join(homedir(), '.claude-prove'), { recursive: true });
    writeFileSync(stableRootPath(), 'occupied');
    try {
      expect(() => ensureStableRoot(dirA)).toThrow(/not a symlink/);
    } finally {
      rmSync(stableRootPath(), { force: true });
    }
  });
});

describe('ensureProjectLink', () => {
  test('creates the project link pointing at the stable root and gitignores it', () => {
    const project = mkdtempSync(join(tmpdir(), 'project-link-'));
    try {
      const link = ensureProjectLink(project);
      expect(link).toBe(join(project, PROJECT_LINK_REL));
      expect(readlinkSync(link)).toBe(stableRootPath());
      expect(readFileSync(join(project, '.gitignore'), 'utf8')).toContain(PROJECT_LINK_REL);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  test('appends to an existing .gitignore without duplicating', () => {
    const project = mkdtempSync(join(tmpdir(), 'project-link-gi-'));
    try {
      writeFileSync(join(project, '.gitignore'), 'node_modules/\n');
      ensureProjectLink(project);
      ensureProjectLink(project);
      const gi = readFileSync(join(project, '.gitignore'), 'utf8');
      expect(gi).toContain('node_modules/');
      expect(gi.split('\n').filter((l) => l.trim() === PROJECT_LINK_REL)).toHaveLength(1);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  test('refuses to clobber a non-symlink at the link path', () => {
    const project = mkdtempSync(join(tmpdir(), 'project-link-clobber-'));
    try {
      mkdirSync(join(project, '.claude', 'prove-plugin'), { recursive: true });
      expect(() => ensureProjectLink(project)).toThrow(/not a symlink/);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});

describe('PROJECT_LINK_REL', () => {
  test('is the project-relative form the CLAUDE.md importer loads', () => {
    expect(PROJECT_LINK_REL).toBe('.claude/prove-plugin');
  });
});
