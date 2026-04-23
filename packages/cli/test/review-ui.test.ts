import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = join(__dirname, '..', 'bin', 'run.ts');

const DEFAULT_PORT = 5174;
const DEFAULT_IMAGE = 'ghcr.io/mjmorales/claude-prove/review-ui';
const DEFAULT_TAG = 'latest';

interface RunResult {
  stdout: string;
  stderr: string;
  status: number;
}

function runBin(args: string[]): RunResult {
  const result = spawnSync('bun', ['run', BIN, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test' },
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? -1,
  };
}

interface FixtureOptions {
  /** Full `.claude/.prove.json` contents. If undefined, no config file is written. */
  config?: string;
}

function makeFixture(label: string, opts: FixtureOptions = {}): string {
  const root = mkdtempSync(join(tmpdir(), `prove-review-ui-${label}-`));
  if (opts.config !== undefined) {
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude', '.prove.json'), opts.config);
  }
  return root;
}

describe('prove review-ui config', () => {
  test('all three keys set -> emits them verbatim as JSON', () => {
    const project = makeFixture('all-set', {
      config: JSON.stringify({
        schema_version: '4',
        tools: {
          acb: {
            config: {
              review_ui_port: 5678,
              review_ui_image: 'ghcr.io/example/ui',
              review_ui_tag: 'v1.2.3',
            },
          },
        },
      }),
    });
    try {
      const { stdout, stderr, status } = runBin(['review-ui', 'config', '--cwd', project]);

      expect(status).toBe(0);
      expect(stderr).toBe('');

      const parsed = JSON.parse(stdout) as Record<string, unknown>;
      expect(parsed).toEqual({
        port: 5678,
        image: 'ghcr.io/example/ui',
        tag: 'v1.2.3',
      });
      // Port must survive as a number (not a string) so `jq -r .port`
      // yields a shell-clean integer for downstream commands.
      expect(typeof parsed.port).toBe('number');
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  test('some keys missing -> documented defaults fill the gaps', () => {
    const project = makeFixture('partial', {
      config: JSON.stringify({
        schema_version: '4',
        tools: {
          acb: {
            config: {
              review_ui_port: 6000,
              // image + tag intentionally absent
            },
          },
        },
      }),
    });
    try {
      const { stdout, status } = runBin(['review-ui', 'config', '--cwd', project]);

      expect(status).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed).toEqual({
        port: 6000,
        image: DEFAULT_IMAGE,
        tag: DEFAULT_TAG,
      });
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  test('config absent -> emits hardcoded defaults, exit 0', () => {
    const project = makeFixture('absent');
    try {
      const { stdout, stderr, status } = runBin(['review-ui', 'config', '--cwd', project]);

      expect(status).toBe(0);
      expect(stderr).toBe('');
      expect(JSON.parse(stdout)).toEqual({
        port: DEFAULT_PORT,
        image: DEFAULT_IMAGE,
        tag: DEFAULT_TAG,
      });
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  test('malformed JSON -> exit 1 with clear stderr message', () => {
    const project = makeFixture('malformed', { config: '{ this is not json' });
    try {
      const { stdout, stderr, status } = runBin(['review-ui', 'config', '--cwd', project]);

      expect(status).toBe(1);
      expect(stdout).toBe('');
      expect(stderr).toContain('malformed JSON');
      expect(stderr).toContain('.claude/.prove.json');
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  test('tools.acb.config entirely missing -> all defaults', () => {
    const project = makeFixture('no-acb', {
      config: JSON.stringify({ schema_version: '4' }),
    });
    try {
      const { stdout, status } = runBin(['review-ui', 'config', '--cwd', project]);

      expect(status).toBe(0);
      expect(JSON.parse(stdout)).toEqual({
        port: DEFAULT_PORT,
        image: DEFAULT_IMAGE,
        tag: DEFAULT_TAG,
      });
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});

describe('prove review-ui errors', () => {
  test('unknown action exits non-zero with a clear diagnostic', () => {
    const { stderr, status } = runBin(['review-ui', 'bogus']);
    expect(status).not.toBe(0);
    expect(stderr).toContain("unknown action 'bogus'");
  });
});
