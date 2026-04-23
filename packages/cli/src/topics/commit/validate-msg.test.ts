/**
 * Parity tests for the `prove commit validate-msg` port.
 *
 * Each case writes a commit-message file into a temp dir that also carries
 * a synthetic `.claude/.prove.json`, then asserts the exit code matches the
 * Python source's behavior (scripts/validate_commit_msg.py).
 *
 * Scopes fixture mirrors the real repo (.claude/.prove.json `scopes`):
 *   agents, cache, commands, packages, references, skills, scripts
 * Plus the built-in scopes (docs, repo, config, release) which are always
 * allowed even when no `.prove.json` is present.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUILTIN_SCOPES, PATTERN, TYPES, loadScopes, runValidateMsgCmd } from './validate-msg';

const SCOPES_FIXTURE: Record<string, string> = {
  agents: 'agents/',
  cache: 'cache/',
  commands: 'commands/',
  packages: 'packages/',
  references: 'references/',
  skills: 'skills/',
  scripts: 'scripts/',
};

let rootDir: string;

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'validate-msg-'));
  mkdirSync(join(rootDir, '.claude'), { recursive: true });
  writeFileSync(
    join(rootDir, '.claude', '.prove.json'),
    JSON.stringify({ schema_version: '5', scopes: SCOPES_FIXTURE }),
  );
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

function writeMsg(body: string): string {
  const path = join(rootDir, 'COMMIT_EDITMSG');
  writeFileSync(path, body);
  return path;
}

describe('constants match Python source', () => {
  test('TYPES is the canonical conventional-commits 11-set', () => {
    expect([...TYPES].sort()).toEqual([
      'build',
      'chore',
      'ci',
      'docs',
      'feat',
      'fix',
      'perf',
      'refactor',
      'revert',
      'style',
      'test',
    ]);
  });

  test('BUILTIN_SCOPES is {docs, repo, config, release}', () => {
    expect([...BUILTIN_SCOPES].sort()).toEqual(['config', 'docs', 'release', 'repo']);
  });

  test('PATTERN matches type / optional scope / optional `!` / description', () => {
    const m = PATTERN.exec('feat(scrum)!: add thing');
    expect(m?.groups?.type).toBe('feat');
    expect(m?.groups?.scope).toBe('scrum');
    expect(m?.groups?.description).toBe('add thing');
  });
});

describe('loadScopes', () => {
  test('returns the key set from .claude/.prove.json', () => {
    const scopes = loadScopes(rootDir);
    expect([...scopes].sort()).toEqual(Object.keys(SCOPES_FIXTURE).sort());
  });

  test('returns empty set when .prove.json is absent', () => {
    const empty = mkdtempSync(join(tmpdir(), 'validate-msg-empty-'));
    try {
      expect(loadScopes(empty).size).toBe(0);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('runValidateMsgCmd — valid messages', () => {
  test('plain type without scope: `feat: description`', () => {
    expect(runValidateMsgCmd(writeMsg('feat: add feature'), rootDir)).toBe(0);
  });

  test('type with registered scope: `fix(packages): description`', () => {
    expect(runValidateMsgCmd(writeMsg('fix(packages): patch bug'), rootDir)).toBe(0);
  });

  test('breaking-change without scope: `chore!: breaking`', () => {
    expect(runValidateMsgCmd(writeMsg('chore!: breaking change'), rootDir)).toBe(0);
  });

  test('breaking-change with scope: `refactor(scripts)!: breaking`', () => {
    expect(runValidateMsgCmd(writeMsg('refactor(scripts)!: breaking rename'), rootDir)).toBe(0);
  });

  test('builtin scope `docs`: `docs(docs): description`', () => {
    expect(runValidateMsgCmd(writeMsg('docs(docs): clarify readme'), rootDir)).toBe(0);
  });

  test('builtin scope `release`: `chore(release): description`', () => {
    expect(runValidateMsgCmd(writeMsg('chore(release): v0.44.0'), rootDir)).toBe(0);
  });

  test('each registered scope is accepted', () => {
    for (const scope of Object.keys(SCOPES_FIXTURE)) {
      const code = runValidateMsgCmd(writeMsg(`feat(${scope}): touch ${scope}`), rootDir);
      expect(code).toBe(0);
    }
  });

  test('merge commit passthrough: `Merge branch ...`', () => {
    expect(runValidateMsgCmd(writeMsg('Merge branch foo into bar'), rootDir)).toBe(0);
  });

  test('revert auto-message passthrough: `Revert "feat: x"`', () => {
    expect(runValidateMsgCmd(writeMsg('Revert "feat: x"'), rootDir)).toBe(0);
  });

  test('only the first line is validated — body is ignored', () => {
    const msg = 'feat(packages): title\n\nLong body with: invalid patterns everywhere.';
    expect(runValidateMsgCmd(writeMsg(msg), rootDir)).toBe(0);
  });

  test('no .prove.json ⇒ any well-formed scope passes', () => {
    const noConfig = mkdtempSync(join(tmpdir(), 'validate-msg-noconfig-'));
    try {
      const path = join(noConfig, 'MSG');
      writeFileSync(path, 'feat(anything): still valid');
      expect(runValidateMsgCmd(path, noConfig)).toBe(0);
    } finally {
      rmSync(noConfig, { recursive: true, force: true });
    }
  });
});

describe('runValidateMsgCmd — invalid messages', () => {
  test('unknown type: `foo: bad type`', () => {
    expect(runValidateMsgCmd(writeMsg('foo: bad type'), rootDir)).toBe(1);
  });

  test('missing colon: `feat bad: missing colon`', () => {
    // Regex requires `: ` immediately after type (and optional scope/`!`).
    // `feat bad: missing colon` doesn't match — the space after `feat`
    // breaks the group.
    expect(runValidateMsgCmd(writeMsg('feat bad missing colon'), rootDir)).toBe(1);
  });

  test('uppercase scope: `feat(UPPER): invalid scope`', () => {
    // Scope regex is `[a-z][a-z0-9_-]*` — uppercase fails the pattern.
    expect(runValidateMsgCmd(writeMsg('feat(UPPER): invalid scope'), rootDir)).toBe(1);
  });

  test('unregistered scope: `feat(unknown): unregistered scope`', () => {
    expect(runValidateMsgCmd(writeMsg('feat(unknown): unregistered scope'), rootDir)).toBe(1);
  });

  test('empty message', () => {
    expect(runValidateMsgCmd(writeMsg(''), rootDir)).toBe(1);
  });

  test('no space after colon: `feat:no-space`', () => {
    // PATTERN requires `: ` (colon + space) — `feat:no-space` fails.
    expect(runValidateMsgCmd(writeMsg('feat:no-space'), rootDir)).toBe(1);
  });

  test('empty description: `feat: `', () => {
    // `(?<description>.+)` requires at least one char after `: `.
    expect(runValidateMsgCmd(writeMsg('feat: '), rootDir)).toBe(1);
  });
});
