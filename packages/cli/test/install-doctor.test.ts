import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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

function runDoctor(cwd: string): RunResult {
  // Pin CLAUDE_PLUGIN_ROOT to the repo checkout: the worktree has
  // `.claude-plugin/plugin.json` and `packages/cli/src/`, so the plugin-root
  // and mode checks both pass under a dev install.
  const result = spawnSync('bun', ['run', BIN, 'install', 'doctor'], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: REPO_ROOT, NODE_ENV: 'test' },
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
 *   .claude/settings.json   — one prove hook block pointing at the repo's
 *                             cli entry (which exists in this worktree)
 *   .claude/.prove.json     — schema_version matches CURRENT_SCHEMA_VERSION
 */
function scaffoldHealthy(root: string): void {
  const claudeDir = join(root, '.claude');
  mkdirSync(claudeDir, { recursive: true });

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

describe('prove install doctor', () => {
  test('healthy fixture reports no failures and exits 0', () => {
    const root = makeTmpProject('healthy');
    try {
      scaffoldHealthy(root);
      const { stdout, status } = runDoctor(root);

      expect(status).toBe(0);
      expect(stdout).toContain('[PASS] plugin-root');
      expect(stdout).toContain('[PASS] mode');
      expect(stdout).toContain('[PASS] hook-paths[run_state:Write|Edit|MultiEdit]');
      expect(stdout).toContain('[PASS] prove-json-version');
      expect(stdout).toMatch(/\d+ passed, \d+ warnings, 0 failures/);
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
                  command: '/nonexistent/prove run-state hook validate',
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
      expect(combined).toContain('/nonexistent/prove');
      expect(combined).toContain('install init --force');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
