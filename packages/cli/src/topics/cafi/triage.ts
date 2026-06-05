/**
 * Deterministic triage for CAFI — decides which walked files are worth
 * routing-hint descriptions using glob heuristics, so obviously-skippable
 * files (tests, assets, lockfiles, boilerplate) never reach the describe
 * phase at all.
 */

import { basename } from 'node:path';
import { createLogger } from '@claude-prove/shared';

// All levels routed to stderr: `cafi plan` reserves stdout for its JSON
// output, and the triage progress line must never interleave with it.
const logger = createLogger('cafi.triage', {
  write: (_level, line) => process.stderr.write(`${line}\n`),
});

/** Glob patterns for files skipped by triage (basename or path match). */
export const TRIAGE_EXCLUDE_PATTERNS: readonly string[] = [
  // Test files
  'test_*',
  '*_test.*',
  '*_spec.*',
  '*.test.*',
  '*.spec.*',
  'conftest.py',
  'jest.config.*',
  'vitest.config.*',
  // Asset files
  '*.png',
  '*.jpg',
  '*.jpeg',
  '*.gif',
  '*.svg',
  '*.ico',
  '*.woff',
  '*.woff2',
  '*.ttf',
  '*.eot',
  '*.mp3',
  '*.mp4',
  '*.wav',
  '*.webm',
  // Generated / lock files
  '*.lock',
  '*.min.js',
  '*.min.css',
  '*.map',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'poetry.lock',
  'Pipfile.lock',
  'Cargo.lock',
  'go.sum',
  // Boilerplate
  'LICENSE',
  'LICENSE.*',
  'CHANGELOG*',
  'CHANGES*',
  '.gitignore',
  '.gitattributes',
  '.editorconfig',
  '.prettierrc*',
  '.eslintignore',
  '.stylelintrc*',
  '.dockerignore',
];

/** Directory prefixes whose contents are excluded entirely. */
export const TRIAGE_EXCLUDE_DIRS: readonly string[] = [
  'tests/',
  'test/',
  '__tests__/',
  'spec/',
  'vendor/',
  'node_modules/',
  'dist/',
  'build/',
  '.git/',
  '__pycache__/',
  '.mypy_cache/',
  '.pytest_cache/',
  '.tox/',
  '.venv/',
  'venv/',
  'env/',
];

/**
 * Convert a simple fnmatch-style glob (`*`, `?`, `[abc]`) into a regex that
 * matches the entire input. No recursive `**` — matches Python's `fnmatch`
 * on a single path segment or full path string.
 */
function fnmatchToRegex(pattern: string): RegExp {
  let re = '^';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i] as string;
    if (ch === '*') {
      re += '.*';
    } else if (ch === '?') {
      re += '.';
    } else if (ch === '[') {
      const close = pattern.indexOf(']', i + 1);
      if (close === -1) {
        re += '\\[';
      } else {
        re += `[${pattern.slice(i + 1, close)}]`;
        i = close;
      }
    } else if ('\\^$.|+(){}'.includes(ch)) {
      re += `\\${ch}`;
    } else {
      re += ch;
    }
    i++;
  }
  re += '$';
  return new RegExp(re);
}

function fnmatch(name: string, pattern: string): boolean {
  return fnmatchToRegex(pattern).test(name);
}

/** Check if a file path should be excluded by triage heuristics. */
export function isTriageExcluded(path: string): boolean {
  const base = basename(path);

  // Directory prefix match (either path starts with prefix, or prefix occurs
  // mid-path bounded by `/`).
  for (const dirPattern of TRIAGE_EXCLUDE_DIRS) {
    if (path.startsWith(dirPattern)) return true;
    if (`/${path}`.includes(`/${dirPattern}`)) return true;
  }

  // Basename or full-path fnmatch against each pattern.
  for (const pattern of TRIAGE_EXCLUDE_PATTERNS) {
    if (fnmatch(base, pattern) || fnmatch(path, pattern)) return true;
  }

  return false;
}

/**
 * Filter file list to only index-worthy files using deterministic heuristics.
 * Keeps obvious-skip files out of the describe plan entirely.
 */
export function triageFiles(filePaths: string[]): string[] {
  if (filePaths.length === 0) return [];
  const filtered = filePaths.filter((fp) => !isTriageExcluded(fp));
  logger.info(
    `Triage: ${filtered.length}/${filePaths.length} files selected for indexing (heuristic)`,
  );
  return filtered;
}
