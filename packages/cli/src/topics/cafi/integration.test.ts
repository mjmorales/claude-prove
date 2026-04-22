/**
 * End-to-end CLI tests for the `cafi` topic.
 *
 * Each test spawns `bun run bin/run.ts cafi <action>` against a
 * freshly-seeded tmp project and asserts on stdout/stderr/exit-code.
 *
 * The `index` action shells out to the Claude CLI under the hood. We
 * can't reach `setClaudeRunner` across a subprocess boundary, so we
 * neutralise the describer by emptying `PATH` — the `claude` spawn
 * fails, every description comes back empty, `summary.errors` equals
 * `summary.total`, and the build still exits 0.
 *
 * For actions that require cache state (`get`, `lookup`, `clear`,
 * `context`) we seed `file-index.json` directly via `saveCache` from
 * `@claude-prove/shared` so the test does not depend on the Claude
 * CLI at all.
 *
 * The `gate` action reads its payload from stdin, so its integration
 * test pipes a canned Glob hook payload via `Bun.spawnSync`'s `stdin`
 * option and asserts the injected `additionalContext` on stdout.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { type FileCache, saveCache } from '@claude-prove/shared';
import { CACHE_FILENAME } from './indexer';

const HERE = dirname(Bun.fileURLToPath(import.meta.url));
const CLI_ENTRY = resolve(HERE, '../../../bin/run.ts');

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runCli(args: string[], env: Record<string, string> = {}): CliResult {
  // Invoke bun via its absolute path (`process.execPath`) so tests that
  // scrub PATH still launch the CLI. The child process inherits the
  // scrubbed PATH, which is what disables `claude` resolution inside
  // describer.ts.
  const proc = Bun.spawnSync({
    cmd: [process.execPath, 'run', CLI_ENTRY, 'cafi', ...args],
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...env },
  });
  return {
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    exitCode: proc.exitCode ?? -1,
  };
}

function runCliWithStdin(
  args: string[],
  stdin: string,
  env: Record<string, string> = {},
): CliResult {
  const proc = Bun.spawnSync({
    cmd: [process.execPath, 'run', CLI_ENTRY, 'cafi', ...args],
    stdin: new TextEncoder().encode(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...env },
  });
  return {
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    exitCode: proc.exitCode ?? -1,
  };
}

/** Seed a tmp project with a minimal `.claude/.prove.json` — cafi config is inline. */
function makeProject(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), `cafi-cli-${prefix}-`));
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(
    join(root, '.claude', '.prove.json'),
    JSON.stringify({
      schema_version: '4',
      tools: {
        cafi: {
          config: {
            excludes: [],
            max_file_size: 102400,
            concurrency: 1,
            batch_size: 5,
            triage: true,
          },
        },
      },
    }),
  );
  return root;
}

function writeProjectFile(root: string, relPath: string, content: string): void {
  const abs = join(root, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function cachePath(root: string): string {
  return join(root, '.prove', CACHE_FILENAME);
}

function seedCache(root: string, files: Record<string, string>): void {
  const now = new Date().toISOString();
  const entries: FileCache['files'] = {};
  for (const [path, description] of Object.entries(files)) {
    entries[path] = {
      hash: 'a'.repeat(64),
      description,
      last_indexed: now,
    };
  }
  saveCache(cachePath(root), { version: 1, files: entries });
}

describe('cafi CLI — index', () => {
  test('index with claude unavailable: exit 0, summary.errors > 0, warning on stderr', () => {
    const root = makeProject('index');
    try {
      writeProjectFile(root, 'README.md', '# readme\n');
      writeProjectFile(root, 'src/main.ts', 'export const main = 1;\n');
      // Empty PATH forces `claude` spawn to fail — describer returns empty strings.
      const { stdout, stderr, exitCode } = runCli(['index', '--project-root', root], {
        PATH: '',
      });
      expect(exitCode).toBe(0);
      // The describer's `logger.info` writes triage progress to stdout; the
      // JSON summary is the final block. Slice off the `{...}` run.
      const jsonStart = stdout.lastIndexOf('{');
      const jsonEnd = stdout.lastIndexOf('}');
      const summary = JSON.parse(stdout.slice(jsonStart, jsonEnd + 1));
      expect(summary.total).toBe(2);
      expect(summary.new).toBe(2);
      expect(summary.errors).toBe(2);
      expect(stderr).toContain('2 files received empty descriptions');
      expect(existsSync(cachePath(root))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('cafi CLI — status', () => {
  test('before index: cache_exists is false', () => {
    const root = makeProject('status-empty');
    try {
      writeProjectFile(root, 'README.md', '# readme\n');
      const { stdout, exitCode } = runCli(['status', '--project-root', root]);
      expect(exitCode).toBe(0);
      const status = JSON.parse(stdout);
      expect(status.cache_exists).toBe(false);
      expect(status.new).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('after seeding cache: cache_exists is true', () => {
    const root = makeProject('status-seeded');
    try {
      writeProjectFile(root, 'src/main.ts', 'export const main = 1;\n');
      seedCache(root, { 'src/main.ts': 'main entry point' });
      const { stdout, exitCode } = runCli(['status', '--project-root', root]);
      expect(exitCode).toBe(0);
      const status = JSON.parse(stdout);
      expect(status.cache_exists).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('cafi CLI — get', () => {
  test('known path: stdout is the description, exit 0', () => {
    const root = makeProject('get-hit');
    try {
      seedCache(root, { 'src/main.ts': 'the main entry point' });
      const { stdout, exitCode } = runCli(['get', 'src/main.ts', '--project-root', root]);
      expect(exitCode).toBe(0);
      expect(stdout.trim()).toBe('the main entry point');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('unknown path: exit 1 with stderr message', () => {
    const root = makeProject('get-miss');
    try {
      seedCache(root, { 'src/main.ts': 'main' });
      const { stderr, exitCode } = runCli(['get', 'nope.ts', '--project-root', root]);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('No description found for: nope.ts');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('cafi CLI — lookup', () => {
  test('keyword hits: prints markdown bullets, exit 0', () => {
    const root = makeProject('lookup-hit');
    try {
      seedCache(root, {
        'README.md': 'project readme',
        'src/main.ts': 'main entry point',
        'src/util.ts': 'small utilities',
      });
      const { stdout, exitCode } = runCli(['lookup', 'util', '--project-root', root]);
      expect(exitCode).toBe(0);
      expect(stdout).toBe('- `src/util.ts`: small utilities\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('no matches: exit 1 with stderr message', () => {
    const root = makeProject('lookup-miss');
    try {
      seedCache(root, { 'README.md': 'project readme' });
      const { stderr, exitCode } = runCli(['lookup', 'nothing-matches', '--project-root', root]);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('No files matching: nothing-matches');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('empty description renders as "(no description)"', () => {
    const root = makeProject('lookup-empty');
    try {
      seedCache(root, { 'orphan.md': '' });
      const { stdout, exitCode } = runCli(['lookup', 'orphan', '--project-root', root]);
      expect(exitCode).toBe(0);
      expect(stdout).toBe('- `orphan.md`: (no description)\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('cafi CLI — clear', () => {
  test('with cache: deletes file and prints "Cache cleared."', () => {
    const root = makeProject('clear-hit');
    try {
      seedCache(root, { 'src/main.ts': 'main' });
      expect(existsSync(cachePath(root))).toBe(true);
      const { stdout, exitCode } = runCli(['clear', '--project-root', root]);
      expect(exitCode).toBe(0);
      expect(stdout.trim()).toBe('Cache cleared.');
      expect(existsSync(cachePath(root))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('without cache: prints "No cache file found." and exits 0', () => {
    const root = makeProject('clear-miss');
    try {
      const { stdout, exitCode } = runCli(['clear', '--project-root', root]);
      expect(exitCode).toBe(0);
      expect(stdout.trim()).toBe('No cache file found.');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('cafi CLI — context', () => {
  test('with cache: prints the markdown block, exit 0', () => {
    const root = makeProject('context-hit');
    try {
      seedCache(root, {
        'README.md': 'project readme',
        'src/main.ts': 'main entry point',
      });
      const { stdout, exitCode } = runCli(['context', '--project-root', root]);
      expect(exitCode).toBe(0);
      expect(stdout).toBe(
        '# Project File Index\n\n- `README.md`: project readme\n- `src/main.ts`: main entry point\n',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('without cache: exit 1 with stderr message', () => {
    const root = makeProject('context-miss');
    try {
      const { stderr, exitCode } = runCli(['context', '--project-root', root]);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('No indexed files.');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('cafi CLI — error paths', () => {
  test('unknown action exits 1 with stderr message', () => {
    const { stderr, exitCode } = runCli(['bogus']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('Unknown cafi action: bogus');
    expect(stderr).toContain('Known: index, status, get, lookup, clear, context, gate');
  });
});

describe('cafi CLI — gate', () => {
  test('Glob payload with cached matches emits PreToolUse context on stdout', () => {
    const root = makeProject('gate-hit');
    try {
      seedCache(root, {
        'src/components/Button.tsx': 'Primary button component.',
        'src/components/Modal.tsx': 'Accessible modal dialog.',
        'src/server/index.ts': 'HTTP server entry point.',
      });
      const payload = JSON.stringify({
        tool_name: 'Glob',
        tool_input: { pattern: 'src/components/**/*.tsx' },
        cwd: root,
      });
      const { stdout, exitCode } = runCliWithStdin(['gate', '--project-root', root], payload);
      expect(exitCode).toBe(0);
      expect(stdout).not.toBe('');
      const parsed = JSON.parse(stdout);
      expect(parsed.hookSpecificOutput.hookEventName).toBe('PreToolUse');
      expect(parsed.hookSpecificOutput.permissionDecision).toBe('allow');
      const ctx: string = parsed.hookSpecificOutput.additionalContext;
      expect(ctx).toContain("CAFI index matches for 'components'");
      expect(ctx).toContain('src/components/Button.tsx');
      expect(ctx).not.toContain('src/server/index.ts');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
