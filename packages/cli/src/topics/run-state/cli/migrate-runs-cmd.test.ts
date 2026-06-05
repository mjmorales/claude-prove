/**
 * migrate-runs-cmd.ts CLI-contract tests.
 *
 * Verifies `run-state migrate-runs` follows the stdout=JSON-plan,
 * stderr=summary, exit-code contract: it discovers JSON-first run dirs under
 * the runs root, emits a content-migration plan, narrows by --branch/--slug,
 * and stays read-only. The shipped content-hop registry is empty (every bump
 * is structural), so behind-version artifacts surface as structural-only —
 * which is the real, current behavior the operator sees.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CURRENT_SCHEMA_VERSION } from '../schemas';
import { runMigrateRuns } from './migrate-runs-cmd';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'migrate-runs-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

interface Captured {
  stdout: string;
  stderr: string;
  exit: number;
}

function withCapture(fn: () => number): Captured {
  let stdout = '';
  let stderr = '';
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string | Uint8Array) => {
    stdout += typeof c === 'string' ? c : Buffer.from(c).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => {
    stderr += typeof c === 'string' ? c : Buffer.from(c).toString('utf8');
    return true;
  }) as typeof process.stderr.write;
  try {
    const exit = fn();
    return { stdout, stderr, exit };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

function writeArtifact(branch: string, slug: string, name: string, version: string): string {
  const runDir = join(root, '.prove', 'runs', branch, slug);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, name),
    `${JSON.stringify({ schema_version: version, kind: name.replace('.json', '') }, null, 2)}\n`,
    'utf8',
  );
  return runDir;
}

function runsRoot(): string {
  return join(root, '.prove', 'runs');
}

describe('runMigrateRuns', () => {
  test('emits an empty plan with exit 0 when no runs exist', () => {
    const { stdout, stderr, exit } = withCapture(() => runMigrateRuns({ runsRoot: runsRoot() }));
    expect(exit).toBe(0);
    const plan = JSON.parse(stdout);
    expect(plan.runs).toEqual([]);
    expect(plan.artifactsBehind).toBe(0);
    expect(stderr).toContain('nothing to migrate');
  });

  test('reports current artifacts as nothing to migrate', () => {
    writeArtifact('main', 'a', 'plan.json', CURRENT_SCHEMA_VERSION);
    const { stdout, stderr, exit } = withCapture(() => runMigrateRuns({ runsRoot: runsRoot() }));
    expect(exit).toBe(0);
    expect(JSON.parse(stdout).artifactsBehind).toBe(0);
    expect(stderr).toContain('nothing to migrate');
  });

  test('finds a behind-version artifact and reports it as structural-only', () => {
    writeArtifact('main', 'a', 'plan.json', '1');
    const { stdout, stderr, exit } = withCapture(() => runMigrateRuns({ runsRoot: runsRoot() }));
    expect(exit).toBe(0);
    const plan = JSON.parse(stdout);
    expect(plan.artifactsBehind).toBe(1);
    // Empty shipped registry => no content reshaping; the summary points the
    // operator at the deterministic `run-state migrate` for the structural part.
    expect(plan.artifactsNeedingContent).toBe(0);
    expect(stderr).toContain('run-state migrate');
    expect(plan.runs[0].artifacts[0].kind).toBe('plan');
    expect(plan.runs[0].artifacts[0].fromVersion).toBe('1');
  });

  test('sweeps multiple branches by default', () => {
    writeArtifact('main', 'a', 'plan.json', '1');
    writeArtifact('feat', 'b', 'prd.json', '1');
    const { stdout } = withCapture(() => runMigrateRuns({ runsRoot: runsRoot() }));
    expect(JSON.parse(stdout).runs).toHaveLength(2);
  });

  test('narrows to one run with --branch/--slug', () => {
    writeArtifact('main', 'a', 'plan.json', '1');
    writeArtifact('feat', 'b', 'plan.json', '1');
    const { stdout } = withCapture(() =>
      runMigrateRuns({ runsRoot: runsRoot(), branch: 'main', slug: 'a' }),
    );
    const plan = JSON.parse(stdout);
    expect(plan.runs).toHaveLength(1);
    expect(plan.runs[0].runDir).toContain(join('main', 'a'));
  });

  test('is read-only — does not rewrite the artifact', () => {
    const runDir = writeArtifact('main', 'a', 'plan.json', '1');
    const before = readFileSync(join(runDir, 'plan.json'), 'utf8');
    withCapture(() => runMigrateRuns({ runsRoot: runsRoot() }));
    expect(readFileSync(join(runDir, 'plan.json'), 'utf8')).toBe(before);
  });

  test('a missing runs root is not an error — empty plan', () => {
    const { exit, stdout } = withCapture(() =>
      runMigrateRuns({ runsRoot: join(root, 'no', 'such', 'runs') }),
    );
    expect(exit).toBe(0);
    expect(JSON.parse(stdout).runs).toEqual([]);
  });
});
