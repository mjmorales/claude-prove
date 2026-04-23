import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = join(__dirname, '..', 'bin', 'run.ts');
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const EXPECTED_DEV_PREFIX = `bun run ${join(REPO_ROOT, 'packages', 'cli', 'bin', 'run.ts')}`;

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

describe('prove install init', () => {
  test('writes settings.json and .prove.json in a Node fixture tmpdir', () => {
    const project = makeNodeFixture('init-ok');
    try {
      const { stdout, stderr, status } = runBin(['install', 'init', '--project', project]);

      expect(status).toBe(0);
      expect(stderr).toBe('');
      expect(stdout).toContain('prove install init');

      const settingsPath = join(project, '.claude', 'settings.json');
      const configPath = join(project, '.claude', '.prove.json');
      expect(existsSync(settingsPath)).toBe(true);
      expect(existsSync(configPath)).toBe(true);

      // Dev-mode prefix is derived from the repo root, so the generated
      // hook command embeds the exact absolute path the spawned CLI used.
      const settings = readFileSync(settingsPath, 'utf8');
      expect(settings).toContain(EXPECTED_DEV_PREFIX);

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

describe('prove install init-hooks', () => {
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
      expect(stdout).toContain('prove install init-hooks');

      expect(existsSync(settingsPath)).toBe(true);
      expect(existsSync(join(project, '.claude', '.prove.json'))).toBe(false);

      const settings = readFileSync(settingsPath, 'utf8');
      expect(settings).toContain(EXPECTED_DEV_PREFIX);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});

describe('prove install init-config', () => {
  test('writes only .prove.json in a Node fixture', () => {
    const project = makeNodeFixture('config-only');
    try {
      const { stdout, stderr, status } = runBin(['install', 'init-config', '--cwd', project]);

      expect(status).toBe(0);
      expect(stderr).toBe('');
      expect(stdout).toContain('prove install init-config');

      expect(existsSync(join(project, '.claude', '.prove.json'))).toBe(true);
      expect(existsSync(join(project, '.claude', 'settings.json'))).toBe(false);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});

describe('prove install errors', () => {
  test('unknown action exits non-zero with a clear diagnostic', () => {
    const { stderr, status } = runBin(['install', 'bogus']);
    expect(status).not.toBe(0);
    expect(stderr).toContain("unknown action 'bogus'");
  });
});
