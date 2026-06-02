/**
 * Bounds-enforcement PreToolUse hook tests.
 *
 * Pure-logic tests inject an `ActiveBounds` stub through `BoundsHookDeps` so a
 * failure points at one function; the glob/extraction helpers are tested
 * directly; the on-disk active-task resolution is exercised against a real
 * scrum store written to a temp dir. The CLI boundary (stdin → exit) is
 * covered in `dispatch.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openScrumStore } from '../../scrum/store';
import type { ActiveBounds, BoundsHookDeps } from './bounds';
import {
  extractBashWriteTargets,
  globMatch,
  matchesAny,
  resolveActiveBoundsFromStore,
  runBoundsHook,
  toProjectRelative,
} from './bounds';

const PROJECT_ROOT = '/repo';

/** A deps stub returning a fixed `ActiveBounds` (or null for permissive). */
function stubDeps(active: ActiveBounds | null): BoundsHookDeps {
  return { resolveActiveBounds: () => active };
}

function writeBounds(write: string[]): ActiveBounds {
  return { bounds: { write }, projectRoot: PROJECT_ROOT };
}

function readBounds(read: string[]): ActiveBounds {
  return { bounds: { read }, projectRoot: PROJECT_ROOT };
}

describe('runBoundsHook — write wall', () => {
  test('blocks a Write outside the declared write globs (exit 2 + reason)', () => {
    const result = runBoundsHook(
      { tool_name: 'Write', tool_input: { file_path: '/repo/docs/readme.md' } },
      stubDeps(writeBounds(['src/**'])),
    );
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain('"decision": "block"');
    expect(result.stdout).toContain('docs/readme.md');
    expect(result.stdout).toContain('src/**');
  });

  test('passes a Write inside the declared write globs (exit 0, silent)', () => {
    const result = runBoundsHook(
      { tool_name: 'Write', tool_input: { file_path: '/repo/src/auth/login.ts' } },
      stubDeps(writeBounds(['src/**'])),
    );
    expect(result).toEqual({ exitCode: 0, stdout: '', stderr: '' });
  });

  test('blocks Edit + MultiEdit outside write scope', () => {
    for (const tool of ['Edit', 'MultiEdit']) {
      const result = runBoundsHook(
        { tool_name: tool, tool_input: { file_path: '/repo/other/x.ts' } },
        stubDeps(writeBounds(['src/**'])),
      );
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toContain('"decision": "block"');
    }
  });

  test('resolves a relative file_path against the project root before matching', () => {
    const blocked = runBoundsHook(
      { tool_name: 'Write', tool_input: { file_path: 'docs/x.md' }, cwd: PROJECT_ROOT },
      stubDeps(writeBounds(['src/**'])),
    );
    expect(blocked.exitCode).toBe(2);
    const allowed = runBoundsHook(
      { tool_name: 'Write', tool_input: { file_path: 'src/x.ts' }, cwd: PROJECT_ROOT },
      stubDeps(writeBounds(['src/**'])),
    );
    expect(allowed.stdout).toBe('');
  });
});

describe('runBoundsHook — read wall', () => {
  test('blocks a Read outside the declared read globs', () => {
    const result = runBoundsHook(
      { tool_name: 'Read', tool_input: { file_path: '/repo/secrets/key.pem' } },
      stubDeps(readBounds(['src/**'])),
    );
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain('"decision": "block"');
    expect(result.stdout).toContain('secrets/key.pem');
  });

  test('passes a Read inside the declared read globs', () => {
    const result = runBoundsHook(
      { tool_name: 'Read', tool_input: { file_path: '/repo/src/db/conn.ts' } },
      stubDeps(readBounds(['src/**'])),
    );
    expect(result.stdout).toBe('');
  });

  test('Read with only write bounds declared is permissive (no read glob to check)', () => {
    const result = runBoundsHook(
      { tool_name: 'Read', tool_input: { file_path: '/repo/anything.ts' } },
      stubDeps(writeBounds(['src/**'])),
    );
    expect(result.stdout).toBe('');
  });
});

describe('runBoundsHook — Bash wall', () => {
  test('blocks a Bash redirection writing outside the write globs', () => {
    const result = runBoundsHook(
      {
        tool_name: 'Bash',
        tool_input: { command: 'echo hi > /repo/docs/out.txt' },
        cwd: PROJECT_ROOT,
      },
      stubDeps(writeBounds(['src/**'])),
    );
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain('"decision": "block"');
    expect(result.stdout).toContain('docs/out.txt');
  });

  test('blocks an rm outside the write globs', () => {
    const result = runBoundsHook(
      { tool_name: 'Bash', tool_input: { command: 'rm -rf config/prod.yaml' }, cwd: PROJECT_ROOT },
      stubDeps(writeBounds(['src/**'])),
    );
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain('config/prod.yaml');
  });

  test('passes a Bash write inside the write globs', () => {
    const result = runBoundsHook(
      { tool_name: 'Bash', tool_input: { command: 'echo x >> src/gen.ts' }, cwd: PROJECT_ROOT },
      stubDeps(writeBounds(['src/**'])),
    );
    expect(result.stdout).toBe('');
  });

  test('passes a read-only Bash command (no write target)', () => {
    const result = runBoundsHook(
      { tool_name: 'Bash', tool_input: { command: 'cat src/x.ts | grep foo' }, cwd: PROJECT_ROOT },
      stubDeps(writeBounds(['src/**'])),
    );
    expect(result.stdout).toBe('');
  });

  test('ignores writes outside the repo (not the wall’s concern)', () => {
    const result = runBoundsHook(
      {
        tool_name: 'Bash',
        tool_input: { command: 'echo x > /tmp/scratch.txt' },
        cwd: PROJECT_ROOT,
      },
      stubDeps(writeBounds(['src/**'])),
    );
    expect(result.stdout).toBe('');
  });
});

describe('runBoundsHook — permissive by construction', () => {
  test('null payload passes silently', () => {
    expect(runBoundsHook(null, stubDeps(writeBounds(['src/**'])))).toEqual({
      exitCode: 0,
      stdout: '',
      stderr: '',
    });
  });

  test('irrelevant tool passes (active bounds never consulted)', () => {
    let consulted = false;
    const deps: BoundsHookDeps = {
      resolveActiveBounds: () => {
        consulted = true;
        return writeBounds(['src/**']);
      },
    };
    const result = runBoundsHook({ tool_name: 'Glob', tool_input: { pattern: '**' } }, deps);
    expect(result.stdout).toBe('');
    expect(consulted).toBe(false);
  });

  test('absent active bounds passes (most tasks have none)', () => {
    const result = runBoundsHook(
      { tool_name: 'Write', tool_input: { file_path: '/repo/anywhere.ts' } },
      stubDeps(null),
    );
    expect(result.stdout).toBe('');
  });

  test('empty write glob list passes', () => {
    const result = runBoundsHook(
      { tool_name: 'Write', tool_input: { file_path: '/repo/anywhere.ts' } },
      stubDeps(writeBounds([])),
    );
    expect(result.stdout).toBe('');
  });

  test('a thrown resolver never false-blocks', () => {
    const deps: BoundsHookDeps = {
      resolveActiveBounds: () => {
        throw new Error('db locked');
      },
    };
    const result = runBoundsHook(
      { tool_name: 'Write', tool_input: { file_path: '/repo/anywhere.ts' } },
      deps,
    );
    expect(result).toEqual({ exitCode: 0, stdout: '', stderr: '' });
  });

  test('missing file_path passes', () => {
    const result = runBoundsHook(
      { tool_name: 'Write', tool_input: {} },
      stubDeps(writeBounds(['src/**'])),
    );
    expect(result.stdout).toBe('');
  });
});

describe('globMatch', () => {
  test('** spans directory separators', () => {
    expect(globMatch('src/a/b/c.ts', 'src/**')).toBe(true);
    expect(globMatch('src/x.ts', 'src/**')).toBe(true);
  });

  test('trailing /** matches the bare directory itself', () => {
    expect(globMatch('src', 'src/**')).toBe(true);
  });

  test('* does not span a separator', () => {
    expect(globMatch('src/a.ts', 'src/*')).toBe(true);
    expect(globMatch('src/a/b.ts', 'src/*')).toBe(false);
  });

  test('? matches exactly one non-separator char', () => {
    expect(globMatch('a.ts', '?.ts')).toBe(true);
    expect(globMatch('ab.ts', '?.ts')).toBe(false);
  });

  test('non-matching prefix fails', () => {
    expect(globMatch('docs/x.md', 'src/**')).toBe(false);
  });

  test('matchesAny is true when any glob matches', () => {
    expect(matchesAny('test/x.ts', ['src/**', 'test/**'])).toBe(true);
    expect(matchesAny('lib/x.ts', ['src/**', 'test/**'])).toBe(false);
  });
});

describe('toProjectRelative', () => {
  test('absolute in-repo path becomes project-relative POSIX', () => {
    expect(toProjectRelative('/repo/src/x.ts', '/repo')).toBe('src/x.ts');
  });

  test('relative path resolves against the project root', () => {
    expect(toProjectRelative('src/x.ts', '/repo')).toBe('src/x.ts');
  });

  test('path escaping the project root yields null', () => {
    expect(toProjectRelative('/elsewhere/x.ts', '/repo')).toBeNull();
    expect(toProjectRelative('../x.ts', '/repo')).toBeNull();
  });
});

describe('extractBashWriteTargets', () => {
  test('captures > and >> redirections', () => {
    expect(extractBashWriteTargets('echo a > out.txt')).toContain('out.txt');
    expect(extractBashWriteTargets('echo a >> log.txt')).toContain('log.txt');
  });

  test('captures fd-numbered redirection 2> err.log', () => {
    expect(extractBashWriteTargets('cmd 2> err.log')).toContain('err.log');
  });

  test('captures mutating-command path args', () => {
    expect(extractBashWriteTargets('rm -rf build/cache')).toContain('build/cache');
    expect(extractBashWriteTargets('mv a.ts src/a.ts')).toEqual(['a.ts', 'src/a.ts']);
    expect(extractBashWriteTargets('touch src/new.ts')).toContain('src/new.ts');
  });

  test('captures dd of= target', () => {
    expect(extractBashWriteTargets('dd if=/dev/zero of=disk.img bs=1M')).toContain('disk.img');
  });

  test('inspects mutators inside a pipeline/chain', () => {
    expect(extractBashWriteTargets('git status && rm secret.key')).toContain('secret.key');
  });

  test('strips surrounding quotes', () => {
    expect(extractBashWriteTargets('echo a > "my file.txt"')).toContain('my file.txt');
  });

  test('read-only command yields no targets', () => {
    expect(extractBashWriteTargets('cat src/x.ts | grep foo')).toEqual([]);
  });
});

describe('resolveActiveBoundsFromStore', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bounds-resolve-'));
    // Mark the temp dir as a git repo so the git-common-dir walk resolves it
    // as the main worktree root.
    mkdirSync(join(dir, '.git'), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function seedStore(seed: (store: ReturnType<typeof openScrumStore>) => void): void {
    const store = openScrumStore({ override: join(dir, '.prove', 'prove.db') });
    try {
      seed(store);
    } finally {
      store.close();
    }
  }

  test('returns the single in_progress task carrying path globs', () => {
    seedStore((store) => {
      store.createTask({ id: 't1', title: 'bounded', bounds: { write: ['src/**'] } });
      store.updateTaskStatus('t1', 'ready');
      store.updateTaskStatus('t1', 'in_progress');
    });
    const active = resolveActiveBoundsFromStore(dir);
    expect(active?.bounds.write).toEqual(['src/**']);
    expect(active?.projectRoot).toBe(resolve(dir));
  });

  test('returns null when no in_progress task has path globs (permissive)', () => {
    seedStore((store) => {
      store.createTask({ id: 't1', title: 'unbounded' });
      store.updateTaskStatus('t1', 'ready');
      store.updateTaskStatus('t1', 'in_progress');
    });
    expect(resolveActiveBoundsFromStore(dir)).toBeNull();
  });

  test('returns null when more than one in_progress task is bounded (ambiguous)', () => {
    seedStore((store) => {
      for (const id of ['t1', 't2']) {
        store.createTask({ id, title: id, bounds: { write: ['src/**'] } });
        store.updateTaskStatus(id, 'ready');
        store.updateTaskStatus(id, 'in_progress');
      }
    });
    expect(resolveActiveBoundsFromStore(dir)).toBeNull();
  });

  test('returns null when the store does not exist', () => {
    expect(resolveActiveBoundsFromStore(dir)).toBeNull();
  });
});
