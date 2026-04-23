import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { currentBranch, headSha, mainWorktreeRoot, worktreeRoot } from './git';

function makeTmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `git-${prefix}-`));
}

/** Initialize a git repo with one commit on `main`. Returns the repo root. */
function initRepo(dir: string): string {
  run(['git', 'init', '--quiet', '--initial-branch=main'], dir);
  run(['git', 'config', 'user.email', 'test@example.com'], dir);
  run(['git', 'config', 'user.name', 'test'], dir);
  run(['git', 'config', 'commit.gpgsign', 'false'], dir);
  writeFileSync(join(dir, 'README.md'), '# test\n', 'utf8');
  run(['git', 'add', '.'], dir);
  run(['git', 'commit', '--quiet', '-m', 'init'], dir);
  return dir;
}

function run(cmd: string[], cwd: string): void {
  const proc = Bun.spawnSync({ cmd, cwd, stdout: 'pipe', stderr: 'pipe' });
  if (proc.exitCode !== 0) {
    const err = proc.stderr?.toString() ?? '';
    throw new Error(`${cmd.join(' ')} failed (exit ${proc.exitCode}): ${err}`);
  }
}

function runStdout(cmd: string[], cwd: string): string {
  const proc = Bun.spawnSync({ cmd, cwd, stdout: 'pipe', stderr: 'pipe' });
  if (proc.exitCode !== 0) {
    throw new Error(`${cmd.join(' ')} failed: ${proc.stderr?.toString() ?? ''}`);
  }
  return proc.stdout?.toString().trim() ?? '';
}

describe('currentBranch', () => {
  test('returns branch name on a normal repo', () => {
    const tmp = makeTmpDir('branch');
    try {
      initRepo(tmp);
      expect(currentBranch(tmp)).toBe('main');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('returns null on detached HEAD', () => {
    const tmp = makeTmpDir('detached');
    try {
      initRepo(tmp);
      const sha = runStdout(['git', 'rev-parse', 'HEAD'], tmp);
      run(['git', 'checkout', '--quiet', '--detach', sha], tmp);
      expect(currentBranch(tmp)).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('returns null outside a git repo', () => {
    const tmp = makeTmpDir('nonrepo');
    try {
      expect(currentBranch(tmp)).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('headSha', () => {
  test('returns 40-char HEAD SHA', () => {
    const tmp = makeTmpDir('sha');
    try {
      initRepo(tmp);
      const sha = headSha(tmp);
      expect(sha).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('returns null outside a git repo', () => {
    const tmp = makeTmpDir('sha-none');
    try {
      expect(headSha(tmp)).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('worktreeRoot', () => {
  test('returns the repo root when invoked from the repo', () => {
    const tmp = makeTmpDir('wt-root');
    try {
      initRepo(tmp);
      const root = worktreeRoot(tmp);
      expect(root).not.toBeNull();
      // realpath equivalence: macOS /var vs /private/var.
      const real = runStdout(['git', 'rev-parse', '--show-toplevel'], tmp);
      expect(root).toBe(real);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('returns null outside a git repo', () => {
    const tmp = makeTmpDir('wt-none');
    try {
      expect(worktreeRoot(tmp)).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('mainWorktreeRoot', () => {
  test('returns the main repo root when invoked from the main repo', () => {
    const tmp = makeTmpDir('main-self');
    try {
      initRepo(tmp);
      const main = mainWorktreeRoot(tmp);
      const selfWt = worktreeRoot(tmp);
      expect(main).toBe(selfWt);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('returns the main repo root even when invoked from a linked worktree', () => {
    const tmp = makeTmpDir('main-linked');
    try {
      const mainRoot = initRepo(tmp);
      const linkedPath = join(tmp, '..', `linked-${Date.now()}`);
      run(['git', 'worktree', 'add', '--quiet', '-b', 'feature/linked', linkedPath], mainRoot);
      try {
        const mainFromLinked = mainWorktreeRoot(linkedPath);
        const mainSelf = worktreeRoot(mainRoot);
        expect(mainFromLinked).toBe(mainSelf);

        // Sanity: current worktree from inside the linked tree is the linked path.
        const linkedSelf = worktreeRoot(linkedPath);
        expect(linkedSelf).not.toBe(mainSelf);
      } finally {
        rmSync(linkedPath, { recursive: true, force: true });
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('returns null outside a git repo', () => {
    const tmp = makeTmpDir('main-none');
    try {
      expect(mainWorktreeRoot(tmp)).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
