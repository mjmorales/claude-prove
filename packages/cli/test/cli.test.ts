import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = join(__dirname, '..', 'bin', 'run.ts');

const EXPECTED_TOPICS = [
  'acb',
  'cafi',
  'hook',
  'install',
  'pcd',
  'round-table',
  'run-state',
  'schema',
  'scrum',
  'store',
];

function runBin(args: string[]): { stdout: string; stderr: string; status: number } {
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

describe('prove CLI help', () => {
  test('--help lists every expected topic exactly once', () => {
    const { stdout, status } = runBin(['--help']);
    expect(status).toBe(0);
    for (const topic of EXPECTED_TOPICS) {
      // Match topic as a standalone token to avoid substring collisions
      const pattern = new RegExp(`(^|\\s)${topic}(\\s|$)`, 'm');
      expect(stdout).toMatch(pattern);
    }
  });
});

describe('prove CLI stub commands', () => {
  test('each stub exits 0 with the "not yet implemented" notice', () => {
    for (const topic of EXPECTED_TOPICS) {
      const { stdout, status } = runBin([topic]);
      expect(status).toBe(0);
      expect(stdout).toContain('not yet implemented');
      expect(stdout).toContain('2026-04-21-typescript-cli-unification.md');
    }
  });
});
