/**
 * Project file walker — shared by CAFI and PCD.
 *
 * Ported from `tools/_lib/file_walker.py`. Walks the project tree
 * respecting .gitignore (via `git ls-files` + `git check-ignore`), binary
 * detection, size limits, and caller-supplied exclude patterns.
 *
 * When git is unavailable the walker falls back to a manual recursive
 * `readdirSync`, skipping dot-dirs and `.prove/`.
 */

import type { Dirent } from 'node:fs';
import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

/** Default cap on per-file size (bytes). Files larger than this are skipped. */
export const DEFAULT_MAX_FILE_SIZE = 102400;

/** How long to wait on git subprocess invocations before bailing out. */
const GIT_TIMEOUT_MS = 30_000;

/** First-chunk size used to sniff for binary content (null byte presence). */
const BINARY_SNIFF_BYTES = 8192;

export interface WalkOptions {
  excludes?: string[];
  maxFileSize?: number;
}

/**
 * Check whether a file is binary by scanning the first 8 KiB for null bytes.
 *
 * Mirrors Python's behaviour where an unreadable file is treated as binary
 * (callers already filter it out either way, but preserving the semantics
 * keeps the port behaviourally identical).
 */
export function isBinary(filePath: string): boolean {
  let fd: number | null = null;
  try {
    fd = openSync(filePath, 'r');
    const buf = Buffer.alloc(BINARY_SNIFF_BYTES);
    const bytesRead = readSync(fd, buf, 0, BINARY_SNIFF_BYTES, 0);
    return buf.subarray(0, bytesRead).includes(0);
  } catch {
    return true;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // best-effort cleanup — fd may already be closed
      }
    }
  }
}

/**
 * Walk `root` and return the sorted list of eligible file paths relative to it.
 *
 * Eligibility rules (in order):
 *   1. Start from `git ls-files --cached --others --exclude-standard` when
 *      available; otherwise fall back to a manual recursive walk that skips
 *      dot-dirs and `.prove/`.
 *   2. Drop anything matched by `git check-ignore --stdin` (catches
 *      tracked-then-ignored files).
 *   3. Drop `.prove` paths and `.claude/.prove.json`.
 *   4. Drop paths matching any `excludes` pattern.
 *   5. Drop missing files, files larger than `maxFileSize`, and binary files.
 */
export function walkProject(root: string, opts: WalkOptions = {}): string[] {
  const absRoot = resolve(root);
  const excludes = opts.excludes ?? [];
  const maxFileSize = opts.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;

  const gitListed = gitLsFiles(absRoot);
  const candidates = gitListed ?? manualWalk(absRoot);
  candidates.sort();

  const ignored = gitCheckIgnore(absRoot, candidates);
  const filtered = ignored.size > 0 ? candidates.filter((c) => !ignored.has(c)) : candidates;

  const result: string[] = [];
  for (const relPath of filtered) {
    if (isProveOrConfig(relPath)) continue;
    if (matchesAny(relPath, excludes)) continue;

    const fullPath = `${absRoot}${sep}${relPath}`;
    if (!isEligibleFile(fullPath, maxFileSize)) continue;
    result.push(relPath);
  }
  return result;
}

/** Expose for tests — lightweight wrapper around the subprocess boundary. */
export function _gitCheckIgnore(root: string, paths: string[]): Set<string> {
  return gitCheckIgnore(root, paths);
}

/** Expose for tests — pattern match with normalization applied. */
export function _matchesAny(path: string, patterns: string[]): boolean {
  return matchesAny(path, patterns);
}

// ---------------------------------------------------------------------------
// Subprocess helpers
// ---------------------------------------------------------------------------

function gitLsFiles(root: string): string[] | null {
  let proc: ReturnType<typeof Bun.spawnSync>;
  try {
    proc = Bun.spawnSync({
      cmd: ['git', 'ls-files', '--cached', '--others', '--exclude-standard'],
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: GIT_TIMEOUT_MS,
    });
  } catch {
    return null;
  }
  if (proc.exitCode !== 0) return null;

  const stdout = proc.stdout?.toString() ?? '';
  const files = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return files;
}

function gitCheckIgnore(root: string, paths: string[]): Set<string> {
  if (paths.length === 0) return new Set();

  let proc: ReturnType<typeof Bun.spawnSync>;
  try {
    proc = Bun.spawnSync({
      cmd: ['git', 'check-ignore', '--stdin'],
      cwd: root,
      stdin: new TextEncoder().encode(paths.join('\n')),
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: GIT_TIMEOUT_MS,
    });
  } catch {
    return new Set();
  }

  // git check-ignore: exit 0 = some ignored, exit 1 = none, other = error.
  if (proc.exitCode !== 0 && proc.exitCode !== 1) return new Set();

  const stdout = proc.stdout?.toString() ?? '';
  const ignored = new Set<string>();
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length > 0) ignored.add(trimmed);
  }
  return ignored;
}

// ---------------------------------------------------------------------------
// Filesystem walk + filters
// ---------------------------------------------------------------------------

function manualWalk(root: string): string[] {
  const result: string[] = [];
  walkDir(root, root, result);
  return result;
}

function walkDir(root: string, dir: string, out: string[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' }) as Dirent[];
  } catch {
    return;
  }
  for (const entry of entries) {
    const name = entry.name;
    if (entry.isDirectory()) {
      if (name.startsWith('.') || name === '.prove') continue;
      walkDir(root, `${dir}${sep}${name}`, out);
      continue;
    }
    if (entry.isFile()) {
      const full = `${dir}${sep}${name}`;
      out.push(relative(root, full));
    }
  }
}

function isProveOrConfig(relPath: string): boolean {
  if (relPath.startsWith('.prove')) return true;
  if (relPath.startsWith(`${sep}.prove`)) return true;
  if (relPath === `.claude${sep}.prove.json`) return true;
  return false;
}

function isEligibleFile(fullPath: string, maxFileSize: number): boolean {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(fullPath);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  if (stat.size > maxFileSize) return false;
  if (isBinary(fullPath)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Glob pattern normalization + matching (PurePath.full_match-equivalent)
// ---------------------------------------------------------------------------

/**
 * Normalize an exclude pattern to the canonical form used by the matcher.
 *
 * Rules mirror the Python port so configs carry over unchanged:
 *   - `dist`              -> `**\/dist/**` (match dir anywhere)
 *   - `client/addons/gut` -> `client/addons/gut/**` (rooted dir)
 *   - `dist/`             -> `dist/**` (trailing slash on bare name)
 *   - `*.log`             -> `**\/*.log` (extension glob at any depth)
 *   - anything with `/` + wildcards passes through
 */
export function normalizePattern(pattern: string): string {
  const stripped = pattern.replace(/\/+$/, '');

  // Bare name (no wildcard metacharacters at all).
  if (!/[*?[]/.test(stripped)) {
    if (stripped.includes('/')) return `${stripped}/**`;
    return `**/${stripped}/**`;
  }

  // Trailing-slash directory with wildcards.
  if (pattern.endsWith('/')) return `${stripped}/**`;

  // Simple basename glob like *.log — match at any depth.
  if (!pattern.includes('/')) return `**/${pattern}`;

  return pattern;
}

function matchesAny(path: string, patterns: string[]): boolean {
  if (patterns.length === 0) return false;
  const segments = path.split(/[/\\]/).filter((s) => s.length > 0);
  for (const pattern of patterns) {
    if (fullMatch(segments, splitPatternSegments(normalizePattern(pattern)))) return true;
  }
  return false;
}

function splitPatternSegments(pattern: string): string[] {
  return pattern.split('/').filter((s) => s.length > 0);
}

/**
 * Match path segments against pattern segments using Python
 * `PurePath.full_match` semantics.
 *
 * Rules:
 *   - `**` segment: matches zero or more path segments when it appears
 *     anywhere except in trailing position; trailing `**` requires at least
 *     one segment (so `dist/**` does not match `dist` alone).
 *   - Any other segment: matched as a shell-style glob against exactly one
 *     path segment.
 */
function fullMatch(pathSegs: string[], patternSegs: string[]): boolean {
  return matchFrom(pathSegs, 0, patternSegs, 0);
}

function matchFrom(
  pathSegs: string[],
  startPi: number,
  patternSegs: string[],
  startQi: number,
): boolean {
  let pi = startPi;
  let qi = startQi;
  while (qi < patternSegs.length) {
    const token = patternSegs[qi];
    if (token === '**') {
      const isTrailing = qi === patternSegs.length - 1;
      const minSkip = isTrailing ? 1 : 0;
      // Try every possible skip length from minSkip to remaining path segments.
      for (let skip = minSkip; pi + skip <= pathSegs.length; skip++) {
        if (matchFrom(pathSegs, pi + skip, patternSegs, qi + 1)) return true;
      }
      return false;
    }
    if (pi >= pathSegs.length) return false;
    if (!matchSegment(pathSegs[pi] ?? '', token ?? '')) return false;
    pi++;
    qi++;
  }
  return pi === pathSegs.length;
}

/** Glob-match a single path segment. Supports `*`, `?`, and `[...]` classes. */
function matchSegment(segment: string, pattern: string): boolean {
  const regex = globToRegex(pattern);
  return regex.test(segment);
}

function globToRegex(pattern: string): RegExp {
  let re = '^';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '*') {
      re += '[^/]*';
    } else if (ch === '?') {
      re += '[^/]';
    } else if (ch === '[') {
      const close = pattern.indexOf(']', i + 1);
      if (close === -1) {
        re += '\\[';
      } else {
        re += `[${pattern.slice(i + 1, close)}]`;
        i = close;
      }
    } else if ('\\^$.|+(){}'.includes(ch ?? '')) {
      re += `\\${ch}`;
    } else {
      re += ch;
    }
    i++;
  }
  re += '$';
  return new RegExp(re);
}
