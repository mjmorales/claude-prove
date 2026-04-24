/**
 * Tests for the PCD structural-map generator. Originally ported 1:1 from the
 * retired `tools/pcd/test_structural_map.py`; no longer bound to Python
 * parity — TypeScript is now the source of truth.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { validateArtifact } from './schemas';
import {
  _buildDependencyGraph,
  _clusterFiles,
  _countLines,
  _discoverWorkspacePackages,
  _resolveImportToFile,
  generateStructuralMap,
} from './structural-map';

// ---- helpers ---------------------------------------------------------------

function mkTmp(): string {
  return mkdtempSync(join(tmpdir(), 'pcd-structural-map-'));
}

function write(root: string, relPath: string, content: string): void {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf8');
}

// ---- _countLines -----------------------------------------------------------

describe('_countLines', () => {
  test('counts lines', () => {
    const tmp = mkTmp();
    try {
      write(tmp, 'sample.py', 'line1\nline2\nline3\n');
      expect(_countLines(join(tmp, 'sample.py'))).toBe(3);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('empty file', () => {
    const tmp = mkTmp();
    try {
      write(tmp, 'empty.py', '');
      expect(_countLines(join(tmp, 'empty.py'))).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('nonexistent file', () => {
    expect(_countLines('/nonexistent/path.py')).toBe(0);
  });

  test('single line no newline', () => {
    const tmp = mkTmp();
    try {
      write(tmp, 'one.py', 'single line');
      expect(_countLines(join(tmp, 'one.py'))).toBe(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---- _resolveImportToFile --------------------------------------------------

describe('_resolveImportToFile', () => {
  test('python module file', () => {
    const files = new Set(['cafi/hasher.py', 'cafi/__init__.py']);
    expect(_resolveImportToFile('app.py', 'cafi.hasher', 'python', files, '/tmp')).toBe(
      'cafi/hasher.py',
    );
  });

  test('python package init', () => {
    const files = new Set(['cafi/__init__.py']);
    expect(_resolveImportToFile('app.py', 'cafi', 'python', files, '/tmp')).toBe(
      'cafi/__init__.py',
    );
  });

  test('python relative import returns null', () => {
    const files = new Set(['utils.py']);
    expect(_resolveImportToFile('app.py', '.utils', 'python', files, '/tmp')).toBeNull();
  });

  test('python no match', () => {
    const files = new Set(['other.py']);
    expect(_resolveImportToFile('app.py', 'nonexistent', 'python', files, '/tmp')).toBeNull();
  });

  test('rust crate import', () => {
    const files = new Set(['src/parser.rs', 'src/main.rs']);
    expect(
      _resolveImportToFile('src/main.rs', 'crate::parser::Parser', 'rust', files, '/tmp'),
    ).toBe('src/parser.rs');
  });

  test('rust crate mod.rs', () => {
    const files = new Set(['src/parser/mod.rs', 'src/main.rs']);
    expect(
      _resolveImportToFile('src/main.rs', 'crate::parser::Parser', 'rust', files, '/tmp'),
    ).toBe('src/parser/mod.rs');
  });

  test('js relative import', () => {
    const files = new Set(['utils.js', 'index.js']);
    expect(_resolveImportToFile('index.js', './utils', 'javascript', files, '/tmp')).toBe(
      'utils.js',
    );
  });

  test('ts relative import', () => {
    const files = new Set(['lib/helpers.ts', 'index.ts']);
    expect(_resolveImportToFile('index.ts', './lib/helpers', 'typescript', files, '/tmp')).toBe(
      'lib/helpers.ts',
    );
  });

  test('ts relative import from nested source', () => {
    const files = new Set([
      'packages/cli/src/topics/pcd/structural-map.ts',
      'packages/cli/src/topics/pcd/import-parser.ts',
    ]);
    expect(
      _resolveImportToFile(
        'packages/cli/src/topics/pcd/structural-map.ts',
        './import-parser',
        'typescript',
        files,
        '/tmp',
      ),
    ).toBe('packages/cli/src/topics/pcd/import-parser.ts');
  });

  test('ts parent traversal from nested source', () => {
    const files = new Set([
      'packages/cli/src/topics/pcd/collapse.ts',
      'packages/cli/src/topics/schema/detect.ts',
    ]);
    expect(
      _resolveImportToFile(
        'packages/cli/src/topics/pcd/collapse.ts',
        '../schema/detect',
        'typescript',
        files,
        '/tmp',
      ),
    ).toBe('packages/cli/src/topics/schema/detect.ts');
  });

  test('js index file', () => {
    const files = new Set(['components/index.js']);
    expect(_resolveImportToFile('app.js', './components', 'javascript', files, '/tmp')).toBe(
      'components/index.js',
    );
  });

  test('js non-relative returns null', () => {
    const files = new Set(['react.js']);
    expect(_resolveImportToFile('app.js', 'react', 'javascript', files, '/tmp')).toBeNull();
  });

  test('unknown language', () => {
    const files = new Set(['foo.txt']);
    expect(_resolveImportToFile('app.ts', 'foo', 'unknown', files, '/tmp')).toBeNull();
  });

  test('ts workspace alias root export', () => {
    const files = new Set([
      'packages/cli/src/main.ts',
      'packages/shared/src/index.ts',
      'packages/shared/src/cache.ts',
    ]);
    const workspaces = new Map([
      [
        '@claude-prove/shared',
        {
          root: 'packages/shared',
          exportsMap: {
            '.': './src/index.ts',
            './cache': './src/cache.ts',
          },
        },
      ],
    ]);
    expect(
      _resolveImportToFile(
        'packages/cli/src/main.ts',
        '@claude-prove/shared',
        'typescript',
        files,
        '/tmp',
        workspaces,
      ),
    ).toBe('packages/shared/src/index.ts');
  });

  test('ts workspace alias subpath export', () => {
    const files = new Set([
      'packages/cli/src/main.ts',
      'packages/shared/src/index.ts',
      'packages/shared/src/cache.ts',
    ]);
    const workspaces = new Map([
      [
        '@claude-prove/shared',
        {
          root: 'packages/shared',
          exportsMap: {
            '.': './src/index.ts',
            './cache': './src/cache.ts',
          },
        },
      ],
    ]);
    expect(
      _resolveImportToFile(
        'packages/cli/src/main.ts',
        '@claude-prove/shared/cache',
        'typescript',
        files,
        '/tmp',
        workspaces,
      ),
    ).toBe('packages/shared/src/cache.ts');
  });

  test('ts workspace alias no match returns null', () => {
    const files = new Set(['packages/cli/src/main.ts']);
    const workspaces = new Map([
      ['@claude-prove/shared', { root: 'packages/shared', exportsMap: { '.': './src/index.ts' } }],
    ]);
    expect(
      _resolveImportToFile(
        'packages/cli/src/main.ts',
        'react',
        'typescript',
        files,
        '/tmp',
        workspaces,
      ),
    ).toBeNull();
  });
});

// ---- _discoverWorkspacePackages --------------------------------------------

describe('_discoverWorkspacePackages', () => {
  test('reads workspaces glob and subpackage exports', () => {
    const tmp = mkTmp();
    try {
      write(
        tmp,
        'package.json',
        JSON.stringify({
          name: 'root',
          private: true,
          workspaces: ['packages/*'],
        }),
      );
      write(
        tmp,
        'packages/shared/package.json',
        JSON.stringify({
          name: '@scope/shared',
          main: './src/index.ts',
          exports: { '.': './src/index.ts', './cache': './src/cache.ts' },
        }),
      );
      write(
        tmp,
        'packages/util/package.json',
        JSON.stringify({
          name: '@scope/util',
          main: './src/index.ts',
        }),
      );
      const map = _discoverWorkspacePackages(tmp);
      expect(map.get('@scope/shared')?.root).toBe('packages/shared');
      expect(map.get('@scope/shared')?.exportsMap).toEqual({
        '.': './src/index.ts',
        './cache': './src/cache.ts',
      });
      expect(map.get('@scope/util')?.exportsMap).toEqual({ '.': './src/index.ts' });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('handles explicit workspace paths (no glob)', () => {
    const tmp = mkTmp();
    try {
      write(tmp, 'package.json', JSON.stringify({ name: 'root', workspaces: ['apps/web'] }));
      write(
        tmp,
        'apps/web/package.json',
        JSON.stringify({ name: '@scope/web', main: './src/main.ts' }),
      );
      const map = _discoverWorkspacePackages(tmp);
      expect(map.get('@scope/web')?.root).toBe('apps/web');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('returns empty map when root lacks workspaces', () => {
    const tmp = mkTmp();
    try {
      write(tmp, 'package.json', JSON.stringify({ name: 'solo' }));
      expect(_discoverWorkspacePackages(tmp).size).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---- _buildDependencyGraph -------------------------------------------------

describe('_buildDependencyGraph', () => {
  test('python imports', () => {
    const tmp = mkTmp();
    try {
      write(tmp, 'app.py', 'from models import User\nimport utils\n');
      write(tmp, 'models.py', 'class User: pass\n');
      write(tmp, 'utils.py', 'def helper(): pass\n');

      const files = ['app.py', 'models.py', 'utils.py'];
      const { allImports, adjacency } = _buildDependencyGraph(files, tmp);

      expect(allImports.length).toBeGreaterThan(0);
      expect(adjacency.get('app.py')).toContain('models.py');
      expect(adjacency.get('app.py')).toContain('utils.py');
      expect(adjacency.get('models.py')).toEqual([]);
      expect(adjacency.get('utils.py')).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('nonexistent file skipped', () => {
    const tmp = mkTmp();
    try {
      const files = ['missing.py'];
      const { allImports, adjacency } = _buildDependencyGraph(files, tmp);
      expect(allImports).toEqual([]);
      expect(adjacency.get('missing.py')).toEqual([]);
      expect(adjacency.size).toBe(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---- _clusterFiles ---------------------------------------------------------

describe('_clusterFiles', () => {
  test('single component', () => {
    const files = ['a.py', 'b.py', 'c.py'];
    const adj = new Map<string, string[]>([
      ['a.py', ['b.py']],
      ['b.py', ['c.py']],
      ['c.py', []],
    ]);
    const clusters = _clusterFiles(files, adj);
    expect(clusters).toHaveLength(1);
    const firstCluster = clusters[0];
    if (firstCluster === undefined) throw new Error('expected at least one cluster');
    expect([...firstCluster.files].sort()).toEqual(['a.py', 'b.py', 'c.py']);
    expect(firstCluster.internal_edges).toBeGreaterThan(0);
  });

  test('two components', () => {
    const files = ['a.py', 'b.py', 'x.py', 'y.py'];
    const adj = new Map<string, string[]>([
      ['a.py', ['b.py']],
      ['b.py', []],
      ['x.py', ['y.py']],
      ['y.py', []],
    ]);
    const clusters = _clusterFiles(files, adj);
    expect(clusters).toHaveLength(2);
  });

  test('isolated files', () => {
    const files = ['a.py', 'b.py', 'c.py'];
    const adj = new Map<string, string[]>([
      ['a.py', []],
      ['b.py', []],
      ['c.py', []],
    ]);
    const clusters = _clusterFiles(files, adj);
    expect(clusters).toHaveLength(3);
  });

  test('split large component', () => {
    // 20 files in 4 dirs, chained, max_cluster_size=5
    const files: string[] = [];
    for (let i = 0; i < 20; i++) {
      files.push(`dir${Math.floor(i / 5)}/${String.fromCharCode(97 + i)}.py`);
    }
    const adj = new Map<string, string[]>();
    for (const f of files) adj.set(f, []);
    for (let i = 0; i < files.length - 1; i++) {
      adj.set(files[i] as string, [files[i + 1] as string]);
    }
    const clusters = _clusterFiles(files, adj, 5);
    expect(clusters.length).toBeGreaterThan(1);
    const all: string[] = [];
    for (const c of clusters) all.push(...c.files);
    expect([...all].sort()).toEqual([...files].sort());
  });

  test('empty files', () => {
    const clusters = _clusterFiles([], new Map());
    expect(clusters).toEqual([]);
  });

  test('external edges counted', () => {
    const files = ['a.py', 'b.py', 'c.py'];
    const adj = new Map<string, string[]>([
      ['a.py', ['b.py']],
      ['b.py', []],
      ['c.py', []],
    ]);
    const clusters = _clusterFiles(files, adj);
    expect(clusters).toHaveLength(2);
    const ab = clusters.find((c) => c.files.includes('a.py'));
    expect(ab?.internal_edges).toBe(1);
    expect(ab?.external_edges).toBe(0);
  });
});

// ---- generateStructuralMap -------------------------------------------------

describe('generateStructuralMap', () => {
  test('generate with python files', () => {
    const tmp = mkTmp();
    try {
      write(tmp, 'app.py', 'from models import User\nimport helpers\n\ndef main(): pass\n');
      write(tmp, 'models.py', 'class User:\n    pass\n');
      write(tmp, 'helpers.py', 'def help(): pass\n');

      const scope = ['app.py', 'models.py', 'helpers.py'];
      const result = generateStructuralMap(tmp, scope);

      expect(result.version).toBe(1);
      expect(result.generated_by).toBe('deterministic');
      expect(result.summary.total_files).toBe(3);
      expect(result.summary.total_lines).toBeGreaterThan(0);
      expect(result.summary.languages.python).toBeDefined();
      expect(result.modules).toHaveLength(3);
      expect(result.clusters.length).toBeGreaterThanOrEqual(1);

      const edgePairs = result.dependency_edges.map((e) => [e.from, e.to]);
      expect(edgePairs).toContainEqual(['app.py', 'models.py']);
      expect(edgePairs).toContainEqual(['app.py', 'helpers.py']);

      const outputPath = join(tmp, '.prove', 'steward', 'pcd', 'structural-map.json');
      expect(existsSync(outputPath)).toBe(true);
      const written = JSON.parse(readFileSync(outputPath, 'utf8'));
      expect(written.version).toBe(1);

      // Schema validation
      const validation = validateArtifact(result, 'structural_map');
      expect(validation.ok).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('scope limits files', () => {
    const tmp = mkTmp();
    try {
      write(tmp, 'a.py', 'x = 1\n');
      write(tmp, 'b.py', 'y = 2\n');
      write(tmp, 'c.py', 'z = 3\n');
      write(tmp, 'd.py', 'w = 4\n');
      write(tmp, 'e.py', 'v = 5\n');

      const result = generateStructuralMap(tmp, ['a.py', 'b.py']);

      expect(result.summary.total_files).toBe(2);
      expect(result.modules.map((m) => m.path).sort()).toEqual(['a.py', 'b.py']);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('cluster formation by directory', () => {
    const tmp = mkTmp();
    try {
      write(tmp, 'pkg_a/mod1.py', 'def f(): pass\n');
      write(tmp, 'pkg_a/mod2.py', 'from pkg_a.mod1 import f\n');
      write(tmp, 'pkg_b/mod1.py', 'def g(): pass\n');
      write(tmp, 'pkg_b/mod2.py', 'from pkg_b.mod1 import g\n');

      const scope = ['pkg_a/mod1.py', 'pkg_a/mod2.py', 'pkg_b/mod1.py', 'pkg_b/mod2.py'];
      const result = generateStructuralMap(tmp, scope);

      expect(result.clusters.length).toBeGreaterThanOrEqual(2);
      const clusterSets = result.clusters.map((c) => new Set(c.files));
      const pkgA = new Set(['pkg_a/mod1.py', 'pkg_a/mod2.py']);
      const pkgB = new Set(['pkg_b/mod1.py', 'pkg_b/mod2.py']);
      expect(clusterSets.some((cs) => isSuperset(cs, pkgA))).toBe(true);
      expect(clusterSets.some((cs) => isSuperset(cs, pkgB))).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('empty project', () => {
    const tmp = mkTmp();
    try {
      const result = generateStructuralMap(tmp, []);
      expect(result.version).toBe(1);
      expect(result.summary.total_files).toBe(0);
      expect(result.summary.total_lines).toBe(0);
      expect(result.modules).toEqual([]);
      expect(result.clusters).toEqual([]);
      expect(result.dependency_edges).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('no cafi cache — cafi_description absent', () => {
    const tmp = mkTmp();
    try {
      write(tmp, 'main.py', "print('hello')\n");

      const result = generateStructuralMap(tmp, ['main.py']);

      expect(result.summary.total_files).toBe(1);
      const mod = result.modules[0];
      if (mod === undefined) throw new Error('expected at least one module');
      expect('cafi_description' in mod).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('cafi descriptions enriched when cache exists', () => {
    const tmp = mkTmp();
    try {
      write(tmp, 'main.py', "print('hello')\n");

      const cacheDir = join(tmp, '.prove');
      mkdirSync(cacheDir, { recursive: true });
      const cache = {
        version: 1,
        files: {
          'main.py': {
            hash: 'abc123',
            description: 'Entry point script',
          },
        },
      };
      writeFileSync(join(cacheDir, 'file-index.json'), JSON.stringify(cache), 'utf8');

      const result = generateStructuralMap(tmp, ['main.py']);
      expect(result.modules[0]?.cafi_description).toBe('Entry point script');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('cafi empty description is omitted', () => {
    const tmp = mkTmp();
    try {
      write(tmp, 'main.py', "print('hello')\n");

      const cacheDir = join(tmp, '.prove');
      mkdirSync(cacheDir, { recursive: true });
      const cache = {
        version: 1,
        files: { 'main.py': { hash: 'h', description: '' } },
      };
      writeFileSync(join(cacheDir, 'file-index.json'), JSON.stringify(cache), 'utf8');

      const result = generateStructuralMap(tmp, ['main.py']);
      const mod = result.modules[0];
      if (mod === undefined) throw new Error('expected at least one module');
      expect('cafi_description' in mod).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('imported_by populated', () => {
    const tmp = mkTmp();
    try {
      write(tmp, 'lib.py', 'def func(): pass\n');
      write(tmp, 'app.py', 'import lib\n');

      const result = generateStructuralMap(tmp, ['lib.py', 'app.py']);
      const byPath = new Map(result.modules.map((m) => [m.path, m]));
      expect(byPath.get('lib.py')?.imported_by).toContain('app.py');
      expect(byPath.get('app.py')?.imports_from).toEqual(['lib.py']);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('output JSON written', () => {
    const tmp = mkTmp();
    try {
      write(tmp, 'a.py', 'x = 1\n');
      generateStructuralMap(tmp, ['a.py']);
      const outputPath = join(tmp, '.prove', 'steward', 'pcd', 'structural-map.json');
      expect(existsSync(outputPath)).toBe(true);
      const data = JSON.parse(readFileSync(outputPath, 'utf8'));
      expect(data.version).toBe(1);
      expect(data.generated_by).toBe('deterministic');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('mixed-language project', () => {
    const tmp = mkTmp();
    try {
      write(tmp, 'main.py', 'import json\n');
      write(tmp, 'app.ts', "import { thing } from './util';\n");
      write(tmp, 'util.ts', 'export const thing = 1;\n');
      write(tmp, 'src/lib.rs', 'use std::io;\n');
      write(tmp, 'go.mod', 'module example.com/foo\n');
      write(tmp, 'foo.go', 'package main\nimport "fmt"\n');

      const scope = ['main.py', 'app.ts', 'util.ts', 'src/lib.rs', 'foo.go'];
      const result = generateStructuralMap(tmp, scope);

      expect(result.summary.languages.python).toBe(1);
      expect(result.summary.languages.typescript).toBe(2);
      expect(result.summary.languages.rust).toBe(1);
      expect(result.summary.languages.go).toBe(1);

      const appTs = result.modules.find((m) => m.path === 'app.ts');
      expect(appTs?.imports_from).toContain('util.ts');

      const validation = validateArtifact(result, 'structural_map');
      expect(validation.ok).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('schema validates fixture output', () => {
    const tmp = mkTmp();
    try {
      write(tmp, 'a.py', 'import b\n');
      write(tmp, 'b.py', 'x = 1\n');
      const result = generateStructuralMap(tmp, ['a.py', 'b.py']);
      const { ok, errors } = validateArtifact(result, 'structural_map');
      expect(errors).toEqual([]);
      expect(ok).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

function isSuperset<T>(container: Set<T>, sub: Set<T>): boolean {
  for (const v of sub) {
    if (!container.has(v)) return false;
  }
  return true;
}

// ---- Fixture snapshots -----------------------------------------------------
//
// Each case runs `generateStructuralMap` against a fixture project and
// compares the result (timestamp-normalized) to a pinned JSON snapshot. The
// `python-captures/` directory retains its historical name (Python source
// retired in v0.40.0) but is now regenerated from this TypeScript
// implementation and acts as a regression fence for structural-map output.

describe('structural-map fixtures', () => {
  const fixturesRoot = join(import.meta.dir, '__fixtures__', 'structural-map');

  const cases: Array<{ name: string; scope: string[] }> = [
    {
      name: 'small',
      scope: ['app.py', 'helpers.py', 'models.py'],
    },
    {
      name: 'medium',
      scope: [
        'py/__init__.py',
        'py/app.py',
        'py/models.py',
        'py/utils.py',
        'ts/index.ts',
        'ts/math.ts',
        'ts/logger.ts',
        'rs/src/main.rs',
        'rs/src/parser.rs',
      ],
    },
    { name: 'edge', scope: ['solo.py'] },
  ];

  for (const { name, scope } of cases) {
    test(`${name} matches python capture`, () => {
      const projectDir = join(fixturesRoot, 'projects', name);
      const capturePath = join(fixturesRoot, 'python-captures', `${name}.json`);
      const expected = JSON.parse(readFileSync(capturePath, 'utf8'));

      const actual = generateStructuralMap(projectDir, scope);
      // Normalize non-deterministic fields before comparison.
      const normalized = { ...actual, timestamp: 'CAPTURED' };
      expect(normalized).toEqual(expected);
    });
  }
});
