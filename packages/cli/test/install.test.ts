import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = join(__dirname, '..', 'bin', 'run.ts');
// Dev mode emits the shell-interpolated prefix — resolved per-machine at hook
// fire time — never an absolute checkout path.
const EXPECTED_DEV_PREFIX =
  'bun run "${CLAUDE_PROVE_PLUGIN_DIR:-$HOME/.claude/plugins/prove}/packages/cli/bin/run.ts"';

interface RunResult {
  stdout: string;
  stderr: string;
  status: number;
}

function runBin(args: string[], cwd?: string): RunResult {
  const result = spawnSync('bun', ['run', BIN, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test' },
    cwd,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? -1,
  };
}

function makeNodeFixture(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `prove-install-${label}-`));
  // `package.json` marks the fixture as a Node project so the validator
  // detector inside bootstrapProveJson emits an npm test entry.
  writeFileSync(join(root, 'package.json'), '{}');
  return root;
}

describe('claude-prove install init', () => {
  test('writes settings.json and .prove.json in a Node fixture tmpdir', () => {
    const project = makeNodeFixture('init-ok');
    try {
      const { stdout, stderr, status } = runBin(['install', 'init', '--project', project]);

      expect(status).toBe(0);
      expect(stderr).toBe('');
      expect(stdout).toContain('claude-prove install init');

      const settingsPath = join(project, '.claude', 'settings.json');
      const configPath = join(project, '.claude', '.prove.json');
      expect(existsSync(settingsPath)).toBe(true);
      expect(existsSync(configPath)).toBe(true);

      // Dev-mode prefix is the machine-independent interpolated form. The
      // prefix contains quotes, so assert on the parsed command string rather
      // than the JSON-escaped file text.
      const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
      const firstCommand = settings.hooks.PostToolUse[0].hooks[0].command as string;
      expect(firstCommand.startsWith(EXPECTED_DEV_PREFIX)).toBe(true);

      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      expect(config.schema_version).toBeDefined();
      expect(Array.isArray(config.validators)).toBe(true);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  test('second run without --force is idempotent (no mtime change)', () => {
    const project = makeNodeFixture('idem');
    try {
      const first = runBin(['install', 'init', '--project', project]);
      expect(first.status).toBe(0);

      const settingsPath = join(project, '.claude', 'settings.json');
      const configPath = join(project, '.claude', '.prove.json');
      const settingsMtime = statSync(settingsPath).mtimeMs;
      const configMtime = statSync(configPath).mtimeMs;

      // Enough delay that any write would shift mtime past filesystem
      // granularity on every platform we run tests on.
      Bun.sleepSync(50);

      const second = runBin(['install', 'init', '--project', project]);
      expect(second.status).toBe(0);
      expect(second.stdout).toContain('up-to-date');

      expect(statSync(settingsPath).mtimeMs).toBe(settingsMtime);
      expect(statSync(configPath).mtimeMs).toBe(configMtime);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});

describe('claude-prove install init-hooks', () => {
  test('writes only settings.json, not .prove.json', () => {
    const project = makeNodeFixture('hooks-only');
    try {
      const settingsPath = join(project, '.claude', 'settings.json');
      const { stdout, stderr, status } = runBin([
        'install',
        'init-hooks',
        '--settings',
        settingsPath,
      ]);

      expect(status).toBe(0);
      expect(stderr).toBe('');
      expect(stdout).toContain('claude-prove install init-hooks');

      expect(existsSync(settingsPath)).toBe(true);
      expect(existsSync(join(project, '.claude', '.prove.json'))).toBe(false);

      const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
      const firstCommand = settings.hooks.PostToolUse[0].hooks[0].command as string;
      expect(firstCommand.startsWith(EXPECTED_DEV_PREFIX)).toBe(true);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});

describe('claude-prove install init-config', () => {
  test('writes only .prove.json in a Node fixture', () => {
    const project = makeNodeFixture('config-only');
    try {
      const { stdout, stderr, status } = runBin(['install', 'init-config', '--cwd', project]);

      expect(status).toBe(0);
      expect(stderr).toBe('');
      expect(stdout).toContain('claude-prove install init-config');

      expect(existsSync(join(project, '.claude', '.prove.json'))).toBe(true);
      expect(existsSync(join(project, '.claude', 'settings.json'))).toBe(false);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});

describe('claude-prove install local-env', () => {
  const REPO_ROOT = join(__dirname, '..', '..', '..');

  test('writes env.CLAUDE_PROVE_PLUGIN_DIR into settings.local.json', () => {
    const project = makeNodeFixture('local-env');
    const settingsPath = join(project, '.claude', 'settings.local.json');
    try {
      const { stdout, stderr, status } = runBin(
        ['install', 'local-env', '--plugin-dir', REPO_ROOT, '--settings', settingsPath],
        project,
      );

      expect(status).toBe(0);
      expect(stderr).toBe('');
      expect(stdout).toContain('claude-prove install local-env: wrote');

      const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
      // The CLI resolves the path, so compare resolved-to-resolved.
      expect(settings.env.CLAUDE_PROVE_PLUGIN_DIR).toBe(resolve(REPO_ROOT));
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  test('preserves existing local settings keys', () => {
    const project = makeNodeFixture('local-env-merge');
    const settingsPath = join(project, '.claude', 'settings.local.json');
    try {
      mkdirSync(join(project, '.claude'), { recursive: true });
      writeFileSync(
        settingsPath,
        JSON.stringify({ permissions: { allow: ['Bash(ls)'] }, env: { OTHER: 'kept' } }, null, 2),
      );
      const { status } = runBin(
        ['install', 'local-env', '--plugin-dir', REPO_ROOT, '--settings', settingsPath],
        project,
      );
      expect(status).toBe(0);

      const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
      expect(settings.permissions).toEqual({ allow: ['Bash(ls)'] });
      expect(settings.env.OTHER).toBe('kept');
      expect(settings.env.CLAUDE_PROVE_PLUGIN_DIR).toBe(resolve(REPO_ROOT));
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  test('rejects a plugin dir without the dev entry point', () => {
    const project = makeNodeFixture('local-env-bad');
    try {
      const { stderr, status } = runBin(['install', 'local-env', '--plugin-dir', project], project);
      expect(status).toBe(1);
      expect(stderr).toContain('does not contain');
      expect(existsSync(join(project, '.claude', 'settings.local.json'))).toBe(false);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});

describe('claude-prove install errors', () => {
  test('unknown action exits non-zero with a clear diagnostic', () => {
    const { stderr, status } = runBin(['install', 'bogus']);
    expect(status).not.toBe(0);
    expect(stderr).toContain("unknown action 'bogus'");
  });
});
