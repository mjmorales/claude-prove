/**
 * End-to-end CLI tests for the `cafi` topic.
 *
 * Each test spawns `bun run bin/run.ts cafi <action>` against a
 * freshly-seeded tmp project and asserts on stdout/stderr/exit-code.
 *
 * The describe phase between `plan` and `save` is driven by the Claude
 * session in production; here the test plays driver — it parses the plan
 * JSON, fabricates descriptions, and pipes them back through `save`.
 *
 * For actions that require cache state (`get`, `lookup`, `clear`,
 * `context`) we seed `file-index.json` directly via `saveCache` from
 * `@claude-prove/shared` so the test does not depend on the plan/save
 * round trip at all.
 *
 * The `gate` and `save` actions read from stdin, so their integration
 * tests pipe payloads via `Bun.spawnSync`'s `stdin` option.
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
  // Invoke bun via its absolute path (`process.execPath`) so the CLI
  // launches regardless of the caller's PATH.
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

describe('cafi CLI — plan -> save round trip', () => {
  test('plan emits the batched delta; save merges driver descriptions', () => {
    const root = makeProject('plan-save');
    try {
      writeProjectFile(root, 'README.md', '# readme\n');
      writeProjectFile(root, 'src/main.ts', 'export const main = 1;\n');

      const planRun = runCli(['plan', '--project-root', root]);
      expect(planRun.exitCode).toBe(0);
      // stdout is pure JSON — triage progress goes to stderr.
      const plan = JSON.parse(planRun.stdout);
      expect(plan.total).toBe(2);
      expect(plan.new).toBe(2);
      expect(plan.deleted).toEqual([]);
      expect(plan.batches).toHaveLength(1);

      // Play the driver: describe every planned file and save.
      const files: Record<string, { hash: string; description: string }> = {};
      for (const batch of plan.batches) {
        for (const entry of batch.files) {
          files[entry.path] = { hash: entry.hash, description: `driver hint for ${entry.path}` };
        }
      }
      const saveRun = runCliWithStdin(
        ['save', '--project-root', root],
        JSON.stringify({ files, deleted: plan.deleted }),
      );
      expect(saveRun.exitCode).toBe(0);
      const result = JSON.parse(saveRun.stdout);
      expect(result).toEqual({ saved: 2, pruned: 0, rejected: [] });
      expect(existsSync(cachePath(root))).toBe(true);

      // The loop converges: a second plan has nothing left to describe.
      const replan = JSON.parse(runCli(['plan', '--project-root', root]).stdout);
      expect(replan.new).toBe(0);
      expect(replan.stale).toBe(0);
      expect(replan.unchanged).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('save rejects drifted files and warns on stderr, exit 0', () => {
    const root = makeProject('save-drift');
    try {
      writeProjectFile(root, 'src/main.ts', 'export const main = 1;\n');
      const saveRun = runCliWithStdin(
        ['save', '--project-root', root],
        JSON.stringify({
          files: { 'src/main.ts': { hash: 'f'.repeat(64), description: 'drifted' } },
        }),
      );
      expect(saveRun.exitCode).toBe(0);
      const result = JSON.parse(saveRun.stdout);
      expect(result.rejected).toEqual([{ path: 'src/main.ts', reason: 'hash-drift' }]);
      expect(saveRun.stderr).toContain('1 file(s) rejected');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('save with a malformed payload exits 1', () => {
    const root = makeProject('save-bad');
    try {
      const saveRun = runCliWithStdin(['save', '--project-root', root], 'not json');
      expect(saveRun.exitCode).toBe(1);
      expect(saveRun.stderr).toContain('payload is not valid JSON');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('cafi CLI — index (removed)', () => {
  test('exits 1 pointing at /prove:index', () => {
    const root = makeProject('index-removed');
    try {
      const { stderr, exitCode } = runCli(['index', '--project-root', root]);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('/prove:index');
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
    expect(stderr).toContain('Known: plan, save, status, get, lookup, clear, context, gate, index');
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
