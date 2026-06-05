import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CURRENT_SCHEMA_VERSION } from '../src/topics/schema/schemas';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = join(__dirname, '..', 'bin', 'run.ts');
const REPO_ROOT = resolve(__dirname, '..', '..', '..');

interface RunResult {
  stdout: string;
  stderr: string;
  status: number;
}

/** The portable interpolated hook command emitted by the current installer. */
const PORTABLE_COMMAND =
  'bun run "${CLAUDE_PROVE_PLUGIN_DIR:-$HOME/.claude/plugins/prove}/packages/cli/bin/run.ts" run-state hook validate';

function runDoctor(cwd: string, envOverrides: Record<string, string> = {}): RunResult {
  // Pin CLAUDE_PLUGIN_ROOT to the repo checkout: the worktree has
  // `.claude-plugin/plugin.json` and `packages/cli/src/`, so the plugin-root
  // and mode checks both pass under a dev install. CLAUDE_PROVE_PLUGIN_DIR is
  // pinned too so the plugin-dir-env / hook-paths expansion is hermetic
  // regardless of this machine's default plugin install; pass '' to simulate
  // an unset var (the resolver treats empty as unset).
  const result = spawnSync('bun', ['run', BIN, 'install', 'doctor'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: REPO_ROOT,
      CLAUDE_PROVE_PLUGIN_DIR: REPO_ROOT,
      NODE_ENV: 'test',
      ...envOverrides,
    },
    cwd,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? -1,
  };
}

/**
 * Build a minimal healthy project layout under `root`:
 *   .claude/settings.json   — one prove hook block using the portable
 *                             interpolated command (resolved via the pinned
 *                             CLAUDE_PROVE_PLUGIN_DIR in runDoctor)
 *   .claude/.prove.json     — schema_version matches CURRENT_SCHEMA_VERSION
 */
function scaffoldHealthy(root: string): void {
  const claudeDir = join(root, '.claude');
  mkdirSync(claudeDir, { recursive: true });

  const settings = {
    hooks: {
      PostToolUse: [
        {
          matcher: 'Write|Edit|MultiEdit',
          hooks: [
            {
              type: 'command',
              command: PORTABLE_COMMAND,
              timeout: 5000,
            },
          ],
          _tool: 'run_state',
        },
      ],
    },
  };
  writeFileSync(join(claudeDir, 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`);

  const proveJson = {
    schema_version: CURRENT_SCHEMA_VERSION,
    validators: [],
    reporters: [],
  };
  writeFileSync(join(claudeDir, '.prove.json'), `${JSON.stringify(proveJson, null, 2)}\n`);
}

function makeTmpProject(label: string): string {
  return mkdtempSync(join(tmpdir(), `prove-doctor-${label}-`));
}

describe('claude-prove install doctor', () => {
  test('healthy fixture reports no failures and exits 0', () => {
    const root = makeTmpProject('healthy');
    try {
      scaffoldHealthy(root);
      const { stdout, status } = runDoctor(root);

      expect(status).toBe(0);
      expect(stdout).toContain('[PASS] plugin-root');
      expect(stdout).toContain('[PASS] mode');
      expect(stdout).toContain('[PASS] plugin-dir-env');
      expect(stdout).toContain('(via process-env)');
      expect(stdout).toContain('[PASS] hook-paths[run_state:Write|Edit|MultiEdit]');
      expect(stdout).toContain('[PASS] hook-exec[script]');
      expect(stdout).toContain('[PASS] prove-json-version');
      expect(stdout).toMatch(/\d+ passed, \d+ warnings, 0 failures/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('unset env var falls back to the settings.local.json env block', () => {
    const root = makeTmpProject('local-settings');
    try {
      scaffoldHealthy(root);
      writeFileSync(
        join(root, '.claude', 'settings.local.json'),
        `${JSON.stringify({ env: { CLAUDE_PROVE_PLUGIN_DIR: REPO_ROOT } }, null, 2)}\n`,
      );

      const { stdout, status } = runDoctor(root, { CLAUDE_PROVE_PLUGIN_DIR: '' });

      expect(status).toBe(0);
      expect(stdout).toContain('[PASS] plugin-dir-env');
      expect(stdout).toContain('(via settings.local.json)');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('unresolvable plugin dir fails plugin-dir-env with the local-env fix hint', () => {
    const root = makeTmpProject('unresolvable');
    try {
      scaffoldHealthy(root);
      const bogus = join(root, 'nowhere');

      const { stdout, stderr, status } = runDoctor(root, { CLAUDE_PROVE_PLUGIN_DIR: bogus });
      const combined = `${stdout}\n${stderr}`;

      expect(status).toBe(1);
      expect(combined).toContain('[FAIL] plugin-dir-env');
      expect(combined).toContain('install local-env');
      expect(combined).toContain('[FAIL] hook-paths[run_state:Write|Edit|MultiEdit]');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('stable-root fails when CLAUDE.md references the project link and it is absent', () => {
    const root = makeTmpProject('stable-root-missing');
    try {
      scaffoldHealthy(root);
      writeFileSync(
        join(root, 'CLAUDE.md'),
        '# proj\n\n@.claude/prove-plugin/references/claude-prove-reference.md\n',
      );

      const { stdout, stderr, status } = runDoctor(root);
      const combined = `${stdout}\n${stderr}`;

      expect(status).toBe(1);
      expect(combined).toContain('[FAIL] stable-root');
      expect(combined).toContain('does not exist');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('stable-root fails when the chain dangles', () => {
    const root = makeTmpProject('stable-root-dangling');
    try {
      scaffoldHealthy(root);
      writeFileSync(
        join(root, 'CLAUDE.md'),
        '# proj\n\n@.claude/prove-plugin/references/claude-prove-reference.md\n',
      );
      symlinkSync(join(root, 'nowhere'), join(root, '.claude', 'prove-plugin'));

      const { stdout, stderr, status } = runDoctor(root);
      const combined = `${stdout}\n${stderr}`;

      expect(status).toBe(1);
      expect(combined).toContain('[FAIL] stable-root');
      expect(combined).toContain('dangles');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('stable-root passes when the chain resolves', () => {
    const root = makeTmpProject('stable-root-ok');
    try {
      scaffoldHealthy(root);
      writeFileSync(
        join(root, 'CLAUDE.md'),
        '# proj\n\n@.claude/prove-plugin/references/claude-prove-reference.md\n',
      );
      symlinkSync(REPO_ROOT, join(root, '.claude', 'prove-plugin'));

      const { stdout, status } = runDoctor(root);

      expect(status).toBe(0);
      expect(stdout).toContain('[PASS] stable-root');
      expect(stdout).toContain(`-> ${REPO_ROOT}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('machine-absolute dev prefix warns with the init-hooks --force fix hint', () => {
    const root = makeTmpProject('baked');
    try {
      scaffoldHealthy(root);
      const runTs = join(REPO_ROOT, 'packages', 'cli', 'bin', 'run.ts');
      const settings = {
        hooks: {
          PostToolUse: [
            {
              matcher: 'Write|Edit|MultiEdit',
              hooks: [
                {
                  type: 'command',
                  command: `bun run ${runTs} run-state hook validate`,
                  timeout: 5000,
                },
              ],
              _tool: 'run_state',
            },
          ],
        },
      };
      writeFileSync(
        join(root, '.claude', 'settings.json'),
        `${JSON.stringify(settings, null, 2)}\n`,
      );

      const { stdout, status } = runDoctor(root);

      // Warnings never fail the run.
      expect(status).toBe(0);
      expect(stdout).toContain('[WARN] hook-paths[run_state:Write|Edit|MultiEdit]');
      expect(stdout).toContain('machine-absolute dev prefix');
      expect(stdout).toContain('install init-hooks --force');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('hook target that exists but cannot execute fails hook-exec with the dev_mode fix', () => {
    // Marketplace-clone shape: the dev entry point file exists (so the
    // hook-paths and plugin-dir-env checks pass) but executing it dies on
    // module resolution because the workspace deps were never installed.
    const root = makeTmpProject('exec-dead');
    try {
      scaffoldHealthy(root);
      const clone = join(root, 'clone');
      mkdirSync(join(clone, 'packages', 'cli', 'bin'), { recursive: true });
      writeFileSync(
        join(clone, 'packages', 'cli', 'bin', 'run.ts'),
        "import '@claude-prove/shared';\n",
      );

      const { stdout, stderr, status } = runDoctor(root, { CLAUDE_PROVE_PLUGIN_DIR: clone });
      const combined = `${stdout}\n${stderr}`;

      expect(status).toBe(1);
      expect(combined).toContain('[PASS] hook-paths[run_state:Write|Edit|MultiEdit]');
      expect(combined).toContain('[FAIL] hook-exec[script]');
      expect(combined).toContain('Cannot find module');
      expect(combined).toContain('"dev_mode": false');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('malformed .prove.json fails with schema-migrate fix hint', () => {
    const root = makeTmpProject('malformed');
    try {
      scaffoldHealthy(root);
      // Overwrite with invalid JSON.
      writeFileSync(join(root, '.claude', '.prove.json'), '{ not valid json');

      const { stdout, stderr, status } = runDoctor(root);
      const combined = `${stdout}\n${stderr}`;

      expect(status).toBe(1);
      expect(combined).toContain('[FAIL] prove-json-version');
      expect(combined).toContain('failed to parse');
      expect(combined).toContain('fix: fix the JSON syntax');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('stale hook prefix fails with install init --force fix hint', () => {
    const root = makeTmpProject('stale');
    try {
      scaffoldHealthy(root);

      // Point the hook at a non-existent binary path.
      const settings = {
        hooks: {
          PostToolUse: [
            {
              matcher: 'Write|Edit|MultiEdit',
              hooks: [
                {
                  type: 'command',
                  command: '/nonexistent/claude-prove run-state hook validate',
                  timeout: 5000,
                },
              ],
              _tool: 'run_state',
            },
          ],
        },
      };
      writeFileSync(
        join(root, '.claude', 'settings.json'),
        `${JSON.stringify(settings, null, 2)}\n`,
      );

      const { stdout, stderr, status } = runDoctor(root);
      const combined = `${stdout}\n${stderr}`;

      expect(status).toBe(1);
      expect(combined).toContain('[FAIL] hook-paths[run_state:Write|Edit|MultiEdit]');
      expect(combined).toContain('/nonexistent/claude-prove');
      expect(combined).toContain('install init --force');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('bare hook command resolves on $PATH and passes hook-paths + hook-exec', () => {
    // The portable compiled-install form: hooks invoke `claude-prove ...`
    // with no path, relying on $PATH the same way the firing shell does.
    const root = makeTmpProject('bare-path');
    try {
      scaffoldHealthy(root);
      const binDir = join(root, 'bin');
      mkdirSync(binDir, { recursive: true });
      writeFileSync(join(binDir, 'fake-prove'), '#!/bin/sh\necho "fake-prove 0.0.0-test"\n', {
        mode: 0o755,
      });

      const settings = {
        hooks: {
          PostToolUse: [
            {
              matcher: 'Write|Edit|MultiEdit',
              hooks: [
                {
                  type: 'command',
                  command: 'fake-prove run-state hook validate',
                  timeout: 5000,
                },
              ],
              _tool: 'run_state',
            },
          ],
        },
      };
      writeFileSync(
        join(root, '.claude', 'settings.json'),
        `${JSON.stringify(settings, null, 2)}\n`,
      );

      const { stdout, status } = runDoctor(root, {
        PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
      });

      expect(status).toBe(0);
      expect(stdout).toContain('[PASS] hook-paths[run_state:Write|Edit|MultiEdit]');
      expect(stdout).toContain('[PASS] hook-exec[binary]');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('bare hook command missing from $PATH fails with the PATH-specific fix', () => {
    const root = makeTmpProject('bare-miss');
    try {
      scaffoldHealthy(root);
      const settings = {
        hooks: {
          PostToolUse: [
            {
              matcher: 'Write|Edit|MultiEdit',
              hooks: [
                {
                  type: 'command',
                  command: 'definitely-not-on-path-prove run-state hook validate',
                  timeout: 5000,
                },
              ],
              _tool: 'run_state',
            },
          ],
        },
      };
      writeFileSync(
        join(root, '.claude', 'settings.json'),
        `${JSON.stringify(settings, null, 2)}\n`,
      );

      const { stdout, stderr, status } = runDoctor(root);
      const combined = `${stdout}\n${stderr}`;

      expect(status).toBe(1);
      expect(combined).toContain('[FAIL] hook-paths[run_state:Write|Edit|MultiEdit]');
      expect(combined).toContain('not found on $PATH: definitely-not-on-path-prove');
      // A $PATH miss must NOT suggest the generic regen — that advice can
      // replace working hook commands on a misdetected machine.
      expect(combined).toContain('install upgrade');
      expect(combined).not.toContain('install init --force');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('missing binary on PATH (compiled mode) — binary-on-path check FAILs', () => {
    // Force compiled mode by pinning CLAUDE_PLUGIN_ROOT at a dir that has
    // `.claude-plugin/plugin.json` but NO `packages/cli/src/`. Scrub PATH
    // so `which claude-prove` misses. Other checks will also fail
    // (hook-paths, prove-json) but this test asserts binary-on-path is
    // individually exercised and reports its actionable fix.
    const root = mkdtempSync(join(tmpdir(), 'prove-doctor-nobinary-'));
    try {
      // Compiled-mode plugin root: plugin.json present, packages/cli/src absent.
      const pluginRoot = join(root, 'plugin');
      mkdirSync(join(pluginRoot, '.claude-plugin'), { recursive: true });
      writeFileSync(join(pluginRoot, '.claude-plugin', 'plugin.json'), '{}\n');

      // Project root: minimal .claude so doctor has something to scan.
      const projectRoot = join(root, 'project');
      mkdirSync(join(projectRoot, '.claude'), { recursive: true });
      writeFileSync(
        join(projectRoot, '.claude', '.prove.json'),
        `${JSON.stringify({ schema_version: CURRENT_SCHEMA_VERSION, validators: [] }, null, 2)}\n`,
      );
      writeFileSync(
        join(projectRoot, '.claude', 'settings.json'),
        `${JSON.stringify({ hooks: {} }, null, 2)}\n`,
      );

      // Resolve absolute bun path so we can scrub PATH without losing exec.
      const bunBin = process.execPath;
      const emptyDir = join(root, 'empty-path');
      mkdirSync(emptyDir, { recursive: true });

      const result = spawnSync(bunBin, ['run', BIN, 'install', 'doctor'], {
        encoding: 'utf8',
        env: {
          CLAUDE_PLUGIN_ROOT: pluginRoot,
          NODE_ENV: 'test',
          // PATH contains only a directory we just created — definitely no `claude-prove`.
          PATH: emptyDir,
          HOME: process.env.HOME ?? '',
        },
        cwd: projectRoot,
      });
      const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;

      expect(result.status).toBe(1);
      expect(combined).toContain('[FAIL] binary-on-path');
      expect(combined).toContain('~/.local/bin');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
