/**
 * End-to-end parity tests for the `prove claude-md` topic.
 *
 * The Python reference implementation (`skills/claude-md/__main__.py`) was
 * run against four fixture projects with deterministic (sorted) filesystem
 * traversal; the resulting scan JSON, CLAUDE.md, and subagent-context
 * markdown live under `__fixtures__/golden/` with `__PLUGIN_DIR__` as a
 * placeholder for the absolute plugin path.
 *
 * This suite drives the TS CLI the same way (spawning `bun run bin/run.ts
 * claude-md ...` per the task contract), substitutes the placeholder in the
 * golden, and asserts byte-equality. Any divergence in scanner detectors,
 * composer templates, or managed-block structure surfaces here.
 *
 * Fixtures exercised:
 *   - self         (the prove plugin repo — full feature matrix)
 *   - go-fixture   (minimal Go project)
 *   - node-fixture (Node + TypeScript + React + Next.js)
 *   - python-fixture (minimal Python project)
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compose, composeSubagentContext } from './composer';
import { scanProject } from './scanner';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = join(__dirname, '__fixtures__', 'golden');
// packages/cli/src/topics/claude-md/integration.test.ts -> packages/cli/bin/run.ts
const RUN_TS = resolve(__dirname, '..', '..', '..', 'bin', 'run.ts');
const BUN_BIN = process.execPath;

// Plugin root used when capturing goldens; we substitute `__PLUGIN_DIR__` in
// the recorded output with the current worktree's plugin root before asserting.
// Resolved to the prove plugin root (5 levels up from this test file).
const PLUGIN_ROOT = resolve(__dirname, '..', '..', '..', '..', '..');

interface FixtureSpec {
  name: string;
  buildRoot: () => string;
}

const fixtures: FixtureSpec[] = [
  { name: 'self', buildRoot: () => PLUGIN_ROOT },
  { name: 'go-fixture', buildRoot: () => buildGoFixture() },
  { name: 'node-fixture', buildRoot: () => buildNodeFixture() },
  { name: 'python-fixture', buildRoot: () => buildPythonFixture() },
];

// ---------------------------------------------------------------------------
// Fixture builders — match the projects used when capturing goldens
// ---------------------------------------------------------------------------

import { mkdirSync } from 'node:fs';

/**
 * Create a tmp directory with the exact basename `wantName` so the scanner's
 * dirname fallback yields the golden-captured project name. We `mkdtempSync`
 * a parent, then nest the fixture inside it.
 */
function mkTmpWithName(wantName: string): string {
  const parent = mkdtempSync(join(tmpdir(), 'claude-md-parent-'));
  const root = join(parent, wantName);
  mkdirSync(root);
  return root;
}

function write(root: string, rel: string, content = ''): void {
  const full = join(root, rel);
  const dir = full.slice(0, full.lastIndexOf('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(full, content);
}

function buildGoFixture(): string {
  const root = mkTmpWithName('go-fixture');
  write(root, 'go.mod', 'module example.com/myapp\n\ngo 1.21\n');
  write(root, 'cmd/main.go', '');
  write(root, 'internal/handler.go', '');
  write(root, 'internal/handler_test.go', '');
  return root;
}

function buildNodeFixture(): string {
  const root = mkTmpWithName('node-fixture');
  write(
    root,
    'package.json',
    JSON.stringify({
      name: 'my-app',
      dependencies: { react: '^18.0.0', next: '^14.0.0' },
    }),
  );
  write(root, 'tsconfig.json', '{}');
  write(root, 'src/App.tsx', '');
  write(root, 'src/App.test.tsx', '');
  mkdirSync(join(root, 'components'));
  return root;
}

function buildPythonFixture(): string {
  const root = mkTmpWithName('python-fixture');
  write(root, 'pyproject.toml', '[project]\nname = "my-lib"\n');
  write(root, 'src/my_module.py', '');
  write(root, 'tests/test_my_module.py', '');
  return root;
}

// ---------------------------------------------------------------------------
// Golden helpers
// ---------------------------------------------------------------------------

// Live plugin version read from the real plugin.json so the test tolerates
// auto-bumped patch releases. Goldens pin the placeholder `__PLUGIN_VERSION__`
// (not a literal version) so they don't need to be refreshed per release.
const PLUGIN_VERSION = JSON.parse(
  readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'),
).version as string;

function readGolden(name: string): string {
  return readFileSync(join(GOLDEN_DIR, name), 'utf8')
    .replaceAll('__PLUGIN_DIR__', PLUGIN_ROOT)
    .replaceAll('__PLUGIN_VERSION__', PLUGIN_VERSION);
}

function expectGoldenEqual(actual: string, goldenName: string): void {
  const expected = readGolden(goldenName);
  if (actual !== expected) {
    // Surface the first differing line range for a readable failure.
    const diffLine = firstDiff(actual, expected);
    const msg =
      `golden mismatch for ${goldenName}${diffLine ? ` (first diff at ${diffLine})` : ''}` +
      `\n--- expected ---\n${expected}\n--- actual ---\n${actual}\n`;
    throw new Error(msg);
  }
  expect(actual).toBe(expected);
}

function firstDiff(a: string, b: string): string | null {
  const al = a.split('\n');
  const bl = b.split('\n');
  for (let i = 0; i < Math.max(al.length, bl.length); i++) {
    if (al[i] !== bl[i]) {
      return `line ${i + 1}: '${al[i] ?? ''}' vs '${bl[i] ?? ''}'`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// In-process parity — direct scanner/composer calls vs goldens
// ---------------------------------------------------------------------------

describe('claude-md — golden parity (direct API)', () => {
  const toClean: string[] = [];
  const cleanup = (root: string) => {
    if (root !== PLUGIN_ROOT) toClean.push(root);
  };
  const teardown = () => {
    for (const d of toClean.splice(0)) rmSync(d, { recursive: true, force: true });
  };

  for (const fixture of fixtures) {
    test(`${fixture.name} — scan matches golden`, () => {
      const root = fixture.buildRoot();
      cleanup(root);
      const scan = scanProject(root, PLUGIN_ROOT);
      const actual = `${JSON.stringify(scan, null, 2)}`;
      // Python's json.dumps(indent=2) writes a trailing-newline-less string;
      // goldens were captured the same way — no trailing newline.
      expectGoldenEqual(actual, `${fixture.name}-scan.json`);
    });

    test(`${fixture.name} — compose matches golden CLAUDE.md`, () => {
      const root = fixture.buildRoot();
      cleanup(root);
      const scan = scanProject(root, PLUGIN_ROOT);
      const actual = compose(scan, PLUGIN_ROOT);
      expectGoldenEqual(actual, `${fixture.name}-CLAUDE.md`);
    });

    test(`${fixture.name} — subagent-context matches golden`, () => {
      const root = fixture.buildRoot();
      cleanup(root);
      const scan = scanProject(root, PLUGIN_ROOT);
      const actual = composeSubagentContext(scan, PLUGIN_ROOT);
      expectGoldenEqual(actual, `${fixture.name}-subagent-context.md`);
    });
  }

  test('cleanup', () => {
    teardown();
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CLI dispatch — exercise the full cac entry through `bun run bin/run.ts`
// ---------------------------------------------------------------------------

interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runClaudeMd(args: string[], cwd: string): SpawnResult {
  const proc = Bun.spawnSync({
    cmd: [BUN_BIN, 'run', RUN_TS, 'claude-md', ...args],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env },
  });
  return {
    exitCode: proc.exitCode ?? -1,
    stdout: proc.stdout?.toString() ?? '',
    stderr: proc.stderr?.toString() ?? '',
  };
}

describe('claude-md — CLI dispatch', () => {
  test('scan prints pretty JSON matching golden (go fixture)', () => {
    const root = buildGoFixture();
    try {
      const result = runClaudeMd(
        ['scan', '--project-root', root, '--plugin-dir', PLUGIN_ROOT],
        root,
      );
      expect(result.exitCode).toBe(0);
      // The CLI emits the JSON + trailing newline. The golden has no trailing
      // newline (matches Python `print(json.dumps(...))` which adds one newline
      // too; strip to compare apples to apples).
      const actual = result.stdout.replace(/\n$/, '');
      expectGoldenEqual(actual, 'go-fixture-scan.json');
    } finally {
      // Remove the parent too (mkTmpWithName nests the fixture).
      rmSync(dirname(root), { recursive: true, force: true });
    }
  });

  test('subagent-context prints markdown matching golden (node fixture)', () => {
    const root = buildNodeFixture();
    try {
      const result = runClaudeMd(
        ['subagent-context', '--project-root', root, '--plugin-dir', PLUGIN_ROOT],
        root,
      );
      expect(result.exitCode).toBe(0);
      expectGoldenEqual(result.stdout, 'node-fixture-subagent-context.md');
    } finally {
      // Remove the parent too (mkTmpWithName nests the fixture).
      rmSync(dirname(root), { recursive: true, force: true });
    }
  });

  test('generate writes CLAUDE.md matching golden (python fixture)', () => {
    const root = buildPythonFixture();
    try {
      const result = runClaudeMd(
        ['generate', '--project-root', root, '--plugin-dir', PLUGIN_ROOT],
        root,
      );
      expect(result.exitCode).toBe(0);
      const status = JSON.parse(result.stdout);
      expect(status.status).toBe('generated');
      expect(status.path).toBe(join(root, 'CLAUDE.md'));
      const written = readFileSync(status.path, 'utf8');
      expectGoldenEqual(written, 'python-fixture-CLAUDE.md');
    } finally {
      // Remove the parent too (mkTmpWithName nests the fixture).
      rmSync(dirname(root), { recursive: true, force: true });
    }
  });

  test('refuses to run against ~/.claude', () => {
    // Point --project-root inside HOME/.claude; should exit 2 without touching anything.
    const fakeProject = join(process.env.HOME ?? '/tmp', '.claude', 'some-nested-path');
    const result = runClaudeMd(
      ['generate', '--project-root', fakeProject, '--plugin-dir', PLUGIN_ROOT],
      '/',
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('ERROR: --project-root is inside ~/.claude/');
  });

  test('unknown action exits 1', () => {
    const result = runClaudeMd(['bogus', '--project-root', PLUGIN_ROOT], PLUGIN_ROOT);
    expect(result.exitCode).toBe(1);
  });
});

// Suppress unused warning — readdirSync kept for potential debugging of golden dir contents.
void readdirSync;
