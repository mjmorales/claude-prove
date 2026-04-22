import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_MAX_FILE_SIZE,
  _gitCheckIgnore,
  _matchesAny,
  isBinary,
  normalizePattern,
  walkProject,
} from './file-walker';

function makeTmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `fw-${prefix}-`));
}

function write(path: string, content: string | Uint8Array): void {
  writeFileSync(path, content);
}

function initGitRepo(root: string): void {
  Bun.spawnSync({
    cmd: ['git', 'init', '-q'],
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  Bun.spawnSync({
    cmd: ['git', 'config', 'user.email', 'test@test.com'],
    cwd: root,
  });
  Bun.spawnSync({ cmd: ['git', 'config', 'user.name', 'Test'], cwd: root });
  Bun.spawnSync({ cmd: ['git', 'config', 'commit.gpgsign', 'false'], cwd: root });
}

function gitAddCommit(root: string): void {
  Bun.spawnSync({ cmd: ['git', 'add', '-A'], cwd: root });
  Bun.spawnSync({
    cmd: ['git', 'commit', '-q', '-m', 'init'],
    cwd: root,
    env: { ...process.env, GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@test.com' },
  });
}

describe('isBinary', () => {
  test('text file returns false', () => {
    const tmp = makeTmp('bin-text');
    try {
      const path = join(tmp, 'file.txt');
      write(path, 'plain text\nline two\n');
      expect(isBinary(path)).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('file with null byte returns true', () => {
    const tmp = makeTmp('bin-null');
    try {
      const path = join(tmp, 'file.bin');
      write(path, new Uint8Array([0x00, 0x01, 0x02, 0x89, 0x50, 0x4e, 0x47]));
      expect(isBinary(path)).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('empty file is not binary', () => {
    const tmp = makeTmp('bin-empty');
    try {
      const path = join(tmp, 'empty');
      write(path, '');
      expect(isBinary(path)).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('missing file is treated as binary (skipped by walker)', () => {
    expect(isBinary('/nonexistent/definitely/missing.xyz')).toBe(true);
  });
});

describe('normalizePattern', () => {
  test('bare top-level name wraps with **/ and /**', () => {
    expect(normalizePattern('dist')).toBe('**/dist/**');
  });

  test('bare rooted path gets /** suffix', () => {
    expect(normalizePattern('client/addons/gut')).toBe('client/addons/gut/**');
  });

  test('trailing slash on bare name still matches dir at any depth', () => {
    // After rstrip("/"), `dist/` becomes a bare name (no wildcards),
    // so normalization mirrors `dist` and matches anywhere in the tree.
    expect(normalizePattern('dist/')).toBe('**/dist/**');
  });

  test('simple basename glob gets **/ prefix', () => {
    expect(normalizePattern('*.log')).toBe('**/*.log');
  });

  test('rooted glob passes through', () => {
    expect(normalizePattern('src/**/*.py')).toBe('src/**/*.py');
  });

  test('trailing slash on wildcard dir normalizes to /**', () => {
    expect(normalizePattern('foo*/')).toBe('foo*/**');
  });
});

describe('_matchesAny', () => {
  test('wildcard extension matches at any depth', () => {
    expect(_matchesAny('data.log', ['*.log'])).toBe(true);
    expect(_matchesAny('sub/debug.log', ['*.log'])).toBe(true);
    expect(_matchesAny('main.py', ['*.log'])).toBe(false);
  });

  test('directory with trailing slash', () => {
    expect(_matchesAny('dist/bundle.js', ['dist/'])).toBe(true);
    expect(_matchesAny('dist/sub/file.js', ['dist/'])).toBe(true);
    expect(_matchesAny('distro/file.txt', ['dist/'])).toBe(false);
  });

  test('directory without trailing slash (bare rooted path)', () => {
    expect(_matchesAny('client/addons/gut/gut.gd', ['client/addons/gut'])).toBe(true);
    expect(_matchesAny('client/addons/gut/sub/deep.gd', ['client/addons/gut'])).toBe(true);
    expect(_matchesAny('client/addons/gutter/x.gd', ['client/addons/gut'])).toBe(false);
  });

  test('bare directory pattern does not partial-match a sibling', () => {
    expect(_matchesAny('src/utils_extra/foo.py', ['src/utils'])).toBe(false);
    expect(_matchesAny('src/utils/foo.py', ['src/utils'])).toBe(true);
  });

  test('double-star across middle segments', () => {
    expect(_matchesAny('src/a/b/c.py', ['src/**/*.py'])).toBe(true);
    expect(_matchesAny('src/a/b/c.js', ['src/**/*.py'])).toBe(false);
  });

  test('question-mark is single-char wildcard', () => {
    expect(_matchesAny('file1.py', ['file?.py'])).toBe(true);
    expect(_matchesAny('file10.py', ['file?.py'])).toBe(false);
  });

  test('multiple patterns: first match wins', () => {
    expect(_matchesAny('data.log', ['*.txt', '*.log'])).toBe(true);
    expect(_matchesAny('main.py', ['*.txt', '*.log'])).toBe(false);
  });

  test('empty pattern list matches nothing', () => {
    expect(_matchesAny('anything.py', [])).toBe(false);
  });
});

describe('walkProject (manual fallback, no git)', () => {
  test('returns all eligible files sorted', () => {
    const tmp = makeTmp('walk-nogit');
    try {
      write(join(tmp, 'main.py'), '# main\n');
      write(join(tmp, 'util.py'), '# util\n');
      mkdirSync(join(tmp, 'sub'));
      write(join(tmp, 'sub', 'lib.py'), '# lib\n');
      const files = walkProject(tmp);
      expect(files).toEqual(['main.py', 'sub/lib.py', 'util.py']);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('excludes patterns filter out matches', () => {
    const tmp = makeTmp('walk-excl');
    try {
      write(join(tmp, 'main.py'), '# main\n');
      write(join(tmp, 'data.log'), 'log\n');
      write(join(tmp, 'notes.txt'), 'notes\n');
      const files = walkProject(tmp, { excludes: ['*.log', '*.txt'] });
      expect(files).toContain('main.py');
      expect(files).not.toContain('data.log');
      expect(files).not.toContain('notes.txt');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('skips files larger than maxFileSize', () => {
    const tmp = makeTmp('walk-size');
    try {
      write(join(tmp, 'small.txt'), 'x\n');
      write(join(tmp, 'big.txt'), 'x'.repeat(DEFAULT_MAX_FILE_SIZE + 1));
      const files = walkProject(tmp);
      expect(files).toContain('small.txt');
      expect(files).not.toContain('big.txt');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('skips binary files (null byte sniff)', () => {
    const tmp = makeTmp('walk-bin');
    try {
      write(join(tmp, 'main.py'), '# main\n');
      write(join(tmp, 'image.dat'), new Uint8Array([0x00, 0x01, 0x02, 0x03]));
      const files = walkProject(tmp);
      expect(files).toContain('main.py');
      expect(files).not.toContain('image.dat');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('skips the .prove directory', () => {
    const tmp = makeTmp('walk-prove');
    try {
      write(join(tmp, 'main.py'), '# main\n');
      mkdirSync(join(tmp, '.prove'));
      write(join(tmp, '.prove', 'cache.json'), '{}\n');
      const files = walkProject(tmp);
      for (const f of files) expect(f.startsWith('.prove')).toBe(false);
      expect(files).toContain('main.py');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('skips .claude/.prove.json config', () => {
    const tmp = makeTmp('walk-cfg');
    try {
      write(join(tmp, 'main.py'), '# main\n');
      mkdirSync(join(tmp, '.claude'));
      write(join(tmp, '.claude', '.prove.json'), '{}\n');
      write(join(tmp, '.claude', 'other.json'), '{"a":1}\n');
      const files = walkProject(tmp);
      expect(files).not.toContain('.claude/.prove.json');
      // Other dotfiles under .claude should survive the manual walk though
      // .claude itself starts with . and is therefore skipped by manualWalk.
      expect(files).toContain('main.py');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('walkProject (git integration)', () => {
  test('respects .gitignore for tracked-then-ignored files', () => {
    const tmp = makeTmp('walk-git');
    try {
      initGitRepo(tmp);
      write(join(tmp, 'keep.py'), '# keep\n');
      write(join(tmp, 'secret.env'), 'KEY=val\n');
      mkdirSync(join(tmp, 'dist'));
      write(join(tmp, 'dist', 'bundle.js'), '// bundle\n');
      write(join(tmp, '.gitignore'), '*.env\ndist/\n');
      gitAddCommit(tmp);

      const files = walkProject(tmp);
      expect(files).toContain('keep.py');
      expect(files).not.toContain('secret.env');
      for (const f of files) expect(f.startsWith('dist/')).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('_gitCheckIgnore identifies ignored files in a real repo', () => {
    const tmp = makeTmp('checkign');
    try {
      initGitRepo(tmp);
      write(join(tmp, 'keep.py'), '# keep\n');
      write(join(tmp, 'secret.env'), 'KEY=val\n');
      write(join(tmp, '.gitignore'), '*.env\n');
      gitAddCommit(tmp);

      const ignored = _gitCheckIgnore(tmp, ['keep.py', 'secret.env']);
      expect(ignored.has('keep.py')).toBe(false);
      expect(ignored.has('secret.env')).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('_gitCheckIgnore returns empty set for empty input', () => {
    expect(_gitCheckIgnore('/tmp', []).size).toBe(0);
  });

  test('_gitCheckIgnore returns empty set when directory is not a git repo', () => {
    const tmp = makeTmp('nogit');
    try {
      const ignored = _gitCheckIgnore(tmp, ['anything.py']);
      expect(ignored.size).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
