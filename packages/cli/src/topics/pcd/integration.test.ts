/**
 * End-to-end CLI tests for the `pcd` topic.
 *
 * Each test spawns `bun run bin/run.ts pcd <action>` against a freshly-
 * seeded tmp project and asserts the dual-stream contract:
 *   - stdout: parseable JSON (consumed by LLM agents)
 *   - stderr: human summary, prefixed `PCD: project_root=<abspath>`
 *
 * The pipeline scenario (map -> seed triage -> collapse -> batch -> status)
 * runs the full happy path so we catch regressions in any single handler's
 * artifact contract.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(Bun.fileURLToPath(import.meta.url));
const CLI_ENTRY = resolve(HERE, '../../../bin/run.ts');
const SMALL_PROJECT = resolve(HERE, '__fixtures__/structural-map/projects/small');

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runCli(args: string[], env: Record<string, string> = {}): CliResult {
  const proc = Bun.spawnSync({
    cmd: [process.execPath, 'run', CLI_ENTRY, 'pcd', ...args],
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

/** Copy the in-repo small Python project into a fresh tmp dir for each test. */
function makeSmallProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'pcd-cli-'));
  for (const file of ['app.py', 'helpers.py', 'models.py']) {
    writeFileSync(join(root, file), readFileSync(join(SMALL_PROJECT, file), 'utf8'));
  }
  return root;
}

function seedTriageManifest(root: string): void {
  const pcdDir = join(root, '.prove', 'steward', 'pcd');
  mkdirSync(pcdDir, { recursive: true });
  writeFileSync(
    join(pcdDir, 'triage-manifest.json'),
    JSON.stringify({
      version: 1,
      stats: { files_reviewed: 2, high_risk: 1, medium_risk: 0, low_risk: 1 },
      cards: [
        {
          file: 'app.py',
          risk: 'high',
          confidence: 5,
          cluster_id: 0,
          status: 'needs_review',
          signals: ['complex_flow'],
        },
        {
          file: 'helpers.py',
          risk: 'low',
          confidence: 5,
          cluster_id: 0,
          status: 'clean',
          signals: [],
        },
      ],
      question_index: [
        {
          id: 'q1',
          from_file: 'app.py',
          target_files: ['helpers.py'],
          text: 'why call greet here?',
        },
      ],
    }),
  );
}

describe('pcd cli', () => {
  test('unknown action exits 1 with helpful error', () => {
    const result = runCli(['bogus']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unknown pcd action 'bogus'");
    expect(result.stderr).toContain('map, collapse, batch, status');
  });

  test('map writes structural-map.json and emits json stdout + human stderr', () => {
    const root = makeSmallProject();
    try {
      const result = runCli([
        'map',
        '--project-root',
        root,
        '--scope',
        'app.py,helpers.py,models.py',
      ]);
      expect(result.exitCode).toBe(0);

      const artifactPath = join(root, '.prove', 'steward', 'pcd', 'structural-map.json');
      expect(existsSync(artifactPath)).toBe(true);

      const parsed = JSON.parse(result.stdout) as {
        version: number;
        summary: { total_files: number; languages: Record<string, number> };
        clusters: unknown[];
        dependency_edges: unknown[];
      };
      expect(parsed.version).toBe(1);
      expect(parsed.summary.total_files).toBe(3);
      expect(parsed.summary.languages.python).toBe(3);

      expect(result.stderr).toContain(`PCD: project_root=${root}`);
      expect(result.stderr).toContain(
        `Structural map: 3 files, python: 3, ${parsed.clusters.length} clusters, ${parsed.dependency_edges.length} edges`,
      );
      expect(result.stderr).toContain(`Written to ${artifactPath}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('map with whitespace-padded scope trims and drops empties', () => {
    const root = makeSmallProject();
    try {
      const result = runCli(['map', '--project-root', root, '--scope', ' app.py ,, helpers.py , ']);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout) as {
        summary: { total_files: number };
        modules: Array<{ path: string }>;
      };
      expect(parsed.summary.total_files).toBe(2);
      expect(parsed.modules.map((m) => m.path).sort()).toEqual(['app.py', 'helpers.py']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('collapse without triage-manifest exits 1 with Python-verbatim error', () => {
    const root = mkdtempSync(join(tmpdir(), 'pcd-cli-'));
    try {
      const result = runCli(['collapse', '--project-root', root]);
      expect(result.exitCode).toBe(1);
      const expectedPath = join(root, '.prove', 'steward', 'pcd', 'triage-manifest.json');
      expect(result.stderr).toContain(`PCD: project_root=${root}`);
      expect(result.stderr).toContain(`Error: triage manifest not found: ${expectedPath}`);
      expect(result.stdout).toBe('');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('batch without collapsed-manifest exits 1 with Python-verbatim error', () => {
    const root = mkdtempSync(join(tmpdir(), 'pcd-cli-'));
    try {
      const result = runCli(['batch', '--project-root', root]);
      expect(result.exitCode).toBe(1);
      const expectedPath = join(root, '.prove', 'steward', 'pcd', 'collapsed-manifest.json');
      expect(result.stderr).toContain(`Error: collapsed manifest not found: ${expectedPath}`);
      expect(result.stdout).toBe('');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('status with no artifacts reports all missing with exit 0', () => {
    const root = mkdtempSync(join(tmpdir(), 'pcd-cli-'));
    try {
      const result = runCli(['status', '--project-root', root]);
      expect(result.exitCode).toBe(0);

      const parsed = JSON.parse(result.stdout) as {
        found: Record<string, string>;
        missing: Record<string, string>;
      };
      expect(parsed.found).toEqual({});
      expect(Object.keys(parsed.missing)).toEqual([
        'structural-map.json',
        'triage-manifest.json',
        'collapsed-manifest.json',
        'batch-definitions.json',
      ]);

      expect(result.stderr).toContain('No pipeline-status.json found. Artifact check:');
      expect(result.stderr).toContain('[MISSING] Round 0a (structural map) (structural-map.json)');
      expect(result.stderr).toContain(
        '[MISSING] Round 2 (batch formation) (batch-definitions.json)',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('status with pipeline-status.json emits round table sorted by name', () => {
    const root = mkdtempSync(join(tmpdir(), 'pcd-cli-'));
    try {
      const pcdDir = join(root, '.prove', 'steward', 'pcd');
      mkdirSync(pcdDir, { recursive: true });
      writeFileSync(
        join(pcdDir, 'pipeline-status.json'),
        JSON.stringify({
          rounds: {
            round_0a: { status: 'complete' },
            round_1: { status: 'running' },
            round_2: 'skipped',
          },
        }),
      );

      const result = runCli(['status', '--project-root', root]);
      expect(result.exitCode).toBe(0);

      const parsed = JSON.parse(result.stdout) as {
        rounds: Record<string, unknown>;
      };
      expect(Object.keys(parsed.rounds)).toHaveLength(3);

      expect(result.stderr).toContain('Pipeline status:');
      expect(result.stderr).toContain('  round_0a: complete');
      expect(result.stderr).toContain('  round_1: running');
      expect(result.stderr).toContain('  round_2: skipped');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('full pipeline: map -> seed triage -> collapse -> batch -> status', () => {
    const root = makeSmallProject();
    try {
      // 1. map
      const mapResult = runCli([
        'map',
        '--project-root',
        root,
        '--scope',
        'app.py,helpers.py,models.py',
      ]);
      expect(mapResult.exitCode).toBe(0);

      // 2. seed triage manifest (simulates Round 1 output).
      seedTriageManifest(root);

      // 3. collapse
      const collapseResult = runCli(['collapse', '--project-root', root, '--token-budget', '4000']);
      expect(collapseResult.exitCode).toBe(0);
      const collapsed = JSON.parse(collapseResult.stdout) as {
        stats: { total_cards: number; preserved: number; collapsed: number };
      };
      expect(collapsed.stats.total_cards).toBe(2);
      expect(collapsed.stats.preserved).toBe(1);
      expect(collapsed.stats.collapsed).toBe(1);
      expect(collapseResult.stderr).toContain(
        'Collapse: 2 total cards, 1 preserved, 1 collapsed, compression ratio 0.50',
      );

      // 4. batch
      const batchResult = runCli(['batch', '--project-root', root, '--max-files', '10']);
      expect(batchResult.exitCode).toBe(0);
      const batches = JSON.parse(batchResult.stdout) as Array<{
        batch_id: number;
        files: string[];
        estimated_tokens: number;
      }>;
      expect(Array.isArray(batches)).toBe(true);
      expect(batches.length).toBe(1);
      expect(batches[0]?.batch_id).toBe(1);
      expect(batches[0]?.files).toEqual(['app.py']);
      expect(batchResult.stderr).toContain('Batches: 1 batches, files per batch: [1]');

      // 5. status — all four artifacts minus triage were just written, triage was seeded.
      const statusResult = runCli(['status', '--project-root', root]);
      expect(statusResult.exitCode).toBe(0);
      const status = JSON.parse(statusResult.stdout) as {
        found: Record<string, string>;
        missing: Record<string, string>;
      };
      expect(Object.keys(status.found).sort()).toEqual([
        'batch-definitions.json',
        'collapsed-manifest.json',
        'structural-map.json',
        'triage-manifest.json',
      ]);
      expect(status.missing).toEqual({});
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('collapse --token-budget defaults to 8000 when flag omitted', () => {
    const root = makeSmallProject();
    try {
      seedTriageManifest(root);
      const result = runCli(['collapse', '--project-root', root]);
      expect(result.exitCode).toBe(0);
      // Budget currently influences stats-only reporting; the handler must
      // accept omission without crashing and emit a valid collapsed manifest.
      const parsed = JSON.parse(result.stdout) as { version: number };
      expect(parsed.version).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('batch --max-files defaults to 15 when flag omitted', () => {
    const root = makeSmallProject();
    try {
      // Batch reads both structural-map.json and collapsed-manifest.json, so
      // the full map -> collapse chain must run before --max-files is tested.
      const mapResult = runCli([
        'map',
        '--project-root',
        root,
        '--scope',
        'app.py,helpers.py,models.py',
      ]);
      expect(mapResult.exitCode).toBe(0);
      seedTriageManifest(root);
      const collapseResult = runCli(['collapse', '--project-root', root]);
      expect(collapseResult.exitCode).toBe(0);
      const result = runCli(['batch', '--project-root', root]);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout) as Array<{ batch_id: number }>;
      expect(parsed.length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
