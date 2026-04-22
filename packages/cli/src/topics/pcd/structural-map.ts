/**
 * PCD Round 0a: deterministic structural map generator.
 *
 * Ported 1:1 from `tools/pcd/structural_map.py`. Produces dependency graphs
 * and file clusters from import analysis. Reuses the shared project walker
 * and CAFI cache loader so on-disk output stays byte-identical to Python —
 * key order, module traversal order, cluster IDs, and edge order all match.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { loadCache, loadToolConfig, walkProject } from '@claude-prove/shared';
import { type ImportEntry, type Language, detectLanguage, parseImports } from './import-parser';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const OUTPUT_DIR = join('.prove', 'steward', 'pcd');
export const OUTPUT_FILE = 'structural-map.json';
export const CACHE_PATH = join('.prove', 'file-index.json');

const DEFAULT_MAX_CLUSTER_SIZE = 15;

// ---------------------------------------------------------------------------
// Public output shape
// ---------------------------------------------------------------------------

export interface StructuralMapModule {
  path: string;
  lines: number;
  language: string;
  exports: string[];
  imports_from: string[];
  imported_by: string[];
  cluster_id: number;
  /** Present only when `.prove/file-index.json` has a non-empty description. */
  cafi_description?: string;
}

export interface StructuralMapCluster {
  id: number;
  name: string;
  files: string[];
  internal_edges: number;
  external_edges: number;
}

export interface StructuralMapEdge {
  from: string;
  to: string;
  type: 'internal';
}

export interface StructuralMapSummary {
  total_files: number;
  total_lines: number;
  languages: Record<string, number>;
}

export interface StructuralMap {
  version: 1;
  timestamp: string;
  generated_by: 'deterministic';
  summary: StructuralMapSummary;
  modules: StructuralMapModule[];
  clusters: StructuralMapCluster[];
  dependency_edges: StructuralMapEdge[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Count lines in a file. Returns 0 on any I/O error. */
export function _countLines(filePath: string): number {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch {
    return 0;
  }
  if (content.length === 0) return 0;
  // Python's `sum(1 for _ in f)`: one line per `\n`, plus a final partial
  // line if the file doesn't end with `\n`. Equivalently: number of `\n`s
  // plus 1 if the last char isn't `\n`.
  let count = 0;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') count++;
  }
  if (content[content.length - 1] !== '\n') count++;
  return count;
}

/**
 * Resolve a module name to a project-relative file path per language rules.
 *
 * Mirrors `_resolve_import_to_file` in the Python source: Python =
 * package-relative dotted paths, Rust = crate-relative `::` paths, Go =
 * module-prefix-relative paths, JS/TS = `./` + `../` relative file specs.
 */
export function _resolveImportToFile(
  module: string,
  language: string,
  projectFiles: Set<string>,
  projectRoot: string,
): string | null {
  if (language === 'python') return resolvePython(module, projectFiles);
  if (language === 'rust') return resolveRust(module, projectFiles);
  if (language === 'go') return resolveGo(module, projectFiles, projectRoot);
  if (language === 'javascript' || language === 'typescript') {
    return resolveJsTs(module, projectFiles);
  }
  return null;
}

function resolvePython(module: string, projectFiles: Set<string>): string | null {
  if (module.startsWith('.')) return null;
  const parts = module.split('.');
  if (parts.length === 0) return null;
  const candidate = `${parts.join(sep)}.py`;
  if (projectFiles.has(candidate)) return candidate;
  const candidatePkg = `${parts.join(sep)}${sep}__init__.py`;
  if (projectFiles.has(candidatePkg)) return candidatePkg;
  return null;
}

function resolveRust(module: string, projectFiles: Set<string>): string | null {
  if (
    !module.startsWith('crate::') &&
    !module.startsWith('self::') &&
    !module.startsWith('super::')
  ) {
    return null;
  }
  const parts = module.split('::');
  const pathParts = parts.slice(1);
  if (pathParts.length === 0) return null;
  const prefix = parts[0] === 'crate' ? 'src' : '';
  // Drop the trailing segment if it looks like a type name (starts uppercase).
  // Mirrors Python's `path_parts[-1][0].isupper()` — only ASCII uppercase A-Z
  // counts since `.isupper()` returns False on digits/punct.
  const last = pathParts[pathParts.length - 1] ?? '';
  const trimmed = last.length > 0 && /^[A-Z]/.test(last) ? pathParts.slice(0, -1) : pathParts;
  if (trimmed.length === 0) return null;
  const base = prefix ? join(prefix, ...trimmed) : join(...trimmed);
  const candidate = `${base}.rs`;
  if (projectFiles.has(candidate)) return candidate;
  const candidateMod = join(base, 'mod.rs');
  if (projectFiles.has(candidateMod)) return candidateMod;
  return null;
}

function resolveGo(module: string, projectFiles: Set<string>, projectRoot: string): string | null {
  // Read go.mod to find the module prefix, if any.
  let modulePrefix = '';
  try {
    const goMod = readFileSync(join(projectRoot, 'go.mod'), 'utf8');
    for (const rawLine of goMod.split('\n')) {
      const line = rawLine.trim();
      if (line.startsWith('module ')) {
        const remainder = line.slice('module '.length).trim();
        modulePrefix = remainder;
        break;
      }
    }
  } catch {
    // No go.mod — fall through with empty prefix.
  }

  let rel: string;
  if (modulePrefix !== '' && module.startsWith(modulePrefix)) {
    rel = module.slice(modulePrefix.length).replace(/^\/+/, '');
  } else {
    rel = module;
  }

  // Match Python's `for pf in sorted(project_files)` order.
  const sorted = [...projectFiles].sort();
  for (const pf of sorted) {
    if (pf.startsWith(`${rel}/`) && pf.endsWith('.go')) return pf;
    if (pf === `${rel}.go`) return pf;
  }
  return null;
}

function resolveJsTs(module: string, projectFiles: Set<string>): string | null {
  if (!module.startsWith('./') && !module.startsWith('../')) return null;
  const base = normalize(module);
  const extensions = ['.js', '.jsx', '.ts', '.tsx', '.mjs'];
  const ext = extname(base);
  if (extensions.includes(ext)) {
    return projectFiles.has(base) ? base : null;
  }
  for (const e of extensions) {
    const candidate = base + e;
    if (projectFiles.has(candidate)) return candidate;
  }
  for (const e of extensions) {
    const candidate = join(base, `index${e}`);
    if (projectFiles.has(candidate)) return candidate;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Core pipeline
// ---------------------------------------------------------------------------

interface DependencyGraph {
  allImports: ImportEntry[];
  adjacency: Map<string, string[]>;
}

/**
 * Parse every file's imports and build a per-source adjacency list of
 * internal + external imports that resolved to another project file.
 * Dedup is per-source in first-appearance order.
 */
export function _buildDependencyGraph(files: string[], projectRoot: string): DependencyGraph {
  const projectFiles = new Set(files);
  const allImports: ImportEntry[] = [];
  const adjacency = new Map<string, string[]>();
  for (const f of files) adjacency.set(f, []);

  for (const relPath of files) {
    const fullPath = join(projectRoot, relPath);
    let content: string;
    try {
      content = readFileSync(fullPath, 'utf8');
    } catch {
      continue;
    }

    const imports = parseImports(relPath, content);
    for (const imp of imports) allImports.push(imp);

    const language = detectLanguage(relPath);
    if (language === null) continue;

    const seen = new Set<string>();
    const targets = adjacency.get(relPath) ?? [];
    for (const imp of imports) {
      if (imp.import_type !== 'internal' && imp.import_type !== 'external') continue;
      const target = _resolveImportToFile(
        imp.imported_module,
        language satisfies Language,
        projectFiles,
        projectRoot,
      );
      if (target !== null && target !== relPath && !seen.has(target)) {
        seen.add(target);
        targets.push(target);
      }
    }
  }

  return { allImports, adjacency };
}

/**
 * Cluster files by dependency connectivity then by directory proximity.
 *
 * Algorithm (byte-matched to Python's `_cluster_files`):
 *   1. BFS connected components on the undirected dependency graph, sorted
 *      entry points + sorted neighbor visit order.
 *   2. Components larger than `maxClusterSize` are split by directory, then
 *      chunked in `maxClusterSize` slices.
 *   3. Cluster IDs are assigned in final-group order.
 */
export function _clusterFiles(
  files: string[],
  adjacency: Map<string, string[]>,
  maxClusterSize: number = DEFAULT_MAX_CLUSTER_SIZE,
): StructuralMapCluster[] {
  const undirected = new Map<string, Set<string>>();
  for (const f of files) undirected.set(f, new Set());

  for (const [src, targets] of adjacency) {
    for (const tgt of targets) {
      if (undirected.has(tgt)) {
        undirected.get(src)?.add(tgt);
        undirected.get(tgt)?.add(src);
      }
    }
  }

  const visited = new Set<string>();
  const components: string[][] = [];
  const sortedFiles = [...files].sort();

  for (const start of sortedFiles) {
    if (visited.has(start)) continue;
    const component: string[] = [];
    const queue: string[] = [start];
    while (queue.length > 0) {
      const node = queue.shift() as string;
      if (visited.has(node)) continue;
      visited.add(node);
      component.push(node);
      const neighbors = [...(undirected.get(node) ?? new Set<string>())].sort();
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) queue.push(neighbor);
      }
    }
    if (component.length > 0) {
      component.sort();
      components.push(component);
    }
  }

  // Split oversized components by directory subtree, then fixed-size chunks.
  const finalGroups: string[][] = [];
  for (const comp of components) {
    if (comp.length <= maxClusterSize) {
      finalGroups.push(comp);
      continue;
    }
    const dirGroups = new Map<string, string[]>();
    for (const f of comp) {
      const d = dirname(f) || '.';
      const bucket = dirGroups.get(d);
      if (bucket) bucket.push(f);
      else dirGroups.set(d, [f]);
    }
    for (const d of [...dirGroups.keys()].sort()) {
      const group = dirGroups.get(d) ?? [];
      for (let i = 0; i < group.length; i += maxClusterSize) {
        finalGroups.push(group.slice(i, i + maxClusterSize));
      }
    }
  }

  const clusters: StructuralMapCluster[] = [];
  for (let idx = 0; idx < finalGroups.length; idx++) {
    const group = finalGroups[idx] as string[];
    const clusterId = idx;

    let name: string;
    if (group.length === 1) {
      const only = group[0] as string;
      const dirPart = dirname(only);
      name = dirPart && dirPart !== '.' ? dirPart : stripExt(only);
    } else {
      name = group.length > 0 ? commonPath(group) : 'root';
    }
    if (!name || name === '.') name = 'root';

    const clusterSet = new Set(group);
    let internalEdges = 0;
    let externalEdges = 0;
    for (const f of group) {
      for (const tgt of adjacency.get(f) ?? []) {
        if (clusterSet.has(tgt)) internalEdges++;
        else externalEdges++;
      }
    }

    clusters.push({
      id: clusterId,
      name,
      files: group,
      internal_edges: internalEdges,
      external_edges: externalEdges,
    });
  }

  return clusters;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Generate a deterministic PCD structural map for `projectRoot`.
 *
 * If `scope` is provided, only those project-relative paths are analyzed
 * (used by scoped steward-review). Otherwise the shared walker enumerates
 * files honoring `.claude/.prove.json` excludes + size cap. The resulting
 * map is written to `.prove/steward/pcd/structural-map.json` and returned.
 */
export function generateStructuralMap(projectRoot: string, scope?: string[]): StructuralMap {
  const absRoot = resolve(projectRoot);

  let files: string[];
  if (scope !== undefined) {
    files = [...scope];
  } else {
    const config = loadToolConfig(
      absRoot,
      'pcd',
      { excludes: [] as string[], max_file_size: 102400 as number },
      { require: false },
    );
    files = walkProject(absRoot, {
      excludes: config.excludes as string[],
      maxFileSize: config.max_file_size as number,
    });
  }

  const { adjacency } = _buildDependencyGraph(files, absRoot);
  const clusters = _clusterFiles(files, adjacency);

  const fileToCluster = new Map<string, number>();
  for (const cluster of clusters) {
    for (const f of cluster.files) fileToCluster.set(f, cluster.id);
  }

  // Build reverse adjacency (imported_by), deduped + sorted per target.
  const importedBy = new Map<string, string[]>();
  for (const f of files) importedBy.set(f, []);
  for (const [src, targets] of adjacency) {
    for (const tgt of targets) {
      const bucket = importedBy.get(tgt);
      if (bucket) bucket.push(src);
    }
  }
  for (const [key, list] of importedBy) {
    importedBy.set(key, [...new Set(list)].sort());
  }

  const cachePath = join(absRoot, CACHE_PATH);
  const cafiCache = loadCache(cachePath);
  const cafiFiles = cafiCache.files as Record<string, { description?: string } | undefined>;

  const modules: StructuralMapModule[] = [];
  const dependencyEdges: StructuralMapEdge[] = [];
  const languageCounts: Record<string, number> = {};
  let totalLines = 0;

  const sortedFiles = [...files].sort();
  for (const relPath of sortedFiles) {
    const lines = _countLines(join(absRoot, relPath));
    totalLines += lines;

    const language = detectLanguage(relPath) ?? 'unknown';
    languageCounts[language] = (languageCounts[language] ?? 0) + 1;

    const cafiEntry = cafiFiles[relPath];
    const rawDesc = cafiEntry?.description;
    const cafiDesc = rawDesc !== undefined && rawDesc !== '' ? rawDesc : null;

    const importsFrom = [...new Set(adjacency.get(relPath) ?? [])].sort();
    const module: StructuralMapModule = {
      path: relPath,
      lines,
      language,
      exports: [],
      imports_from: importsFrom,
      imported_by: importedBy.get(relPath) ?? [],
      cluster_id: fileToCluster.get(relPath) ?? 0,
    };
    if (cafiDesc !== null) module.cafi_description = cafiDesc;
    modules.push(module);

    for (const tgt of adjacency.get(relPath) ?? []) {
      dependencyEdges.push({ from: relPath, to: tgt, type: 'internal' });
    }
  }

  const structuralMap: StructuralMap = {
    version: 1,
    timestamp: new Date().toISOString().replace('Z', '+00:00'),
    generated_by: 'deterministic',
    summary: {
      total_files: files.length,
      total_lines: totalLines,
      languages: languageCounts,
    },
    modules,
    clusters,
    dependency_edges: dependencyEdges,
  };

  const outputDir = join(absRoot, OUTPUT_DIR);
  mkdirSync(outputDir, { recursive: true });
  const outputPath = join(outputDir, OUTPUT_FILE);
  writeFileSync(outputPath, `${JSON.stringify(structuralMap, null, 2)}\n`, 'utf8');

  return structuralMap;
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function stripExt(path: string): string {
  const ext = extname(path);
  return ext ? path.slice(0, -ext.length) : path;
}

/**
 * Port of Python's `os.path.commonpath(paths)`:
 *   - Splits each path into segments (POSIX separator), drops empty segs.
 *   - Returns the longest shared segment prefix joined with `/`.
 *   - Assumes inputs are relative paths (walkProject output always is).
 */
function commonPath(paths: string[]): string {
  if (paths.length === 0) return '';
  if (paths.length === 1) return paths[0] ?? '';
  const splits = paths.map((p) => p.split('/').filter((s) => s.length > 0));
  const first = splits[0] ?? [];
  let prefixLen = first.length;
  for (let i = 1; i < splits.length; i++) {
    const next = splits[i] ?? [];
    const minLen = Math.min(prefixLen, next.length);
    let j = 0;
    while (j < minLen && first[j] === next[j]) j++;
    prefixLen = j;
    if (prefixLen === 0) break;
  }
  return first.slice(0, prefixLen).join('/');
}

// Exported only for tests that need to inspect the internal shape.
export { commonPath as _commonPath };
