/**
 * File discovery + per-file measurement for the `prompting token-count` command.
 *
 * Ports `scripts/token-count.py::resolve_paths` and `measure_files`. The glob
 * engine is `Bun.Glob`, which accepts the same recursive `**` / `*` patterns
 * as Python's `Path.glob`. Literal file paths (non-glob strings that resolve
 * to an existing file) are accepted too.
 *
 * Bun runtime required (Bun.Glob). This module is CLI-only — the `claude-prove` CLI
 * is Bun-native — so no Node.js fallback is provided. If a future consumer
 * needs Node compatibility, swap `Bun.Glob` for the `glob` npm package.
 */

import { readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { countTokens, stripFrontmatter } from './tokenizer';

export interface MeasureEntry {
  path: string;
  tokens: number;
  lines: number;
  chars: number;
}

/**
 * Resolve glob patterns and literal paths to a deduplicated file list.
 *
 * Order semantics match Python: literal paths land first, then each pattern's
 * lexicographically-sorted glob matches. Duplicates are deduped by realpath.
 */
export function resolvePaths(patterns: string[], cwd: string = process.cwd()): string[] {
  const seen = new Set<string>();
  const results: string[] = [];

  for (const pattern of patterns) {
    if (isExistingFile(pattern)) {
      const canonical = safeRealpath(pattern);
      if (canonical !== null && !seen.has(canonical)) {
        seen.add(canonical);
        results.push(pattern);
      }
      continue;
    }

    const glob = new Bun.Glob(pattern);
    const matches: string[] = [];
    for (const rel of glob.scanSync({ cwd, onlyFiles: true, dot: false })) {
      matches.push(rel);
    }
    matches.sort();

    for (const rel of matches) {
      const canonical = safeRealpath(resolve(cwd, rel));
      if (canonical !== null && !seen.has(canonical)) {
        seen.add(canonical);
        results.push(rel);
      }
    }
  }

  return results;
}

/**
 * Read each path and return `{path, tokens, lines, chars}`. When
 * `stripFrontmatterFlag` is true (default), a leading YAML frontmatter
 * block is removed before counting — matches Python defaults.
 */
export function measureFiles(paths: string[], stripFrontmatterFlag = true): MeasureEntry[] {
  return paths.map((path) => {
    const raw = readFileSync(path, 'utf8');
    const body = stripFrontmatterFlag ? stripFrontmatter(raw) : raw;
    return {
      path,
      tokens: countTokens(body),
      // Python: `stripped.count("\n") + 1`. Produces 1 for the empty string.
      lines: countNewlines(body) + 1,
      chars: body.length,
    };
  });
}

function isExistingFile(pathLike: string): boolean {
  try {
    return statSync(pathLike).isFile();
  } catch {
    return false;
  }
}

function safeRealpath(pathLike: string): string | null {
  try {
    return realpathSync(pathLike);
  } catch {
    return null;
  }
}

function countNewlines(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) n += 1;
  }
  return n;
}
