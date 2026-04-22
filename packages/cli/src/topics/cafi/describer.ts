/**
 * Description generator for CAFI using the Claude CLI.
 *
 * Ported from `tools/cafi/describer.py`. Generates routing-hint descriptions
 * for files by shelling out to `claude -p -` with a structured prompt.
 * Triage (deciding what to index) uses deterministic glob heuristics so we
 * never burn tokens on obvious exclusions.
 */

import { basename } from 'node:path';
import { createLogger } from '@claude-prove/shared';

const logger = createLogger('cafi.describer');

// --- Public constants -------------------------------------------------------

export const MAX_CONTENT_LENGTH = 8000;
export const CLI_TIMEOUT_SECONDS = 30;
export const BATCH_TIMEOUT_SECONDS = 120;
export const DEFAULT_BATCH_SIZE = 25;

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

export const PROMPT_TEMPLATE = `Describe this file as a routing hint for an LLM coding agent. Your description must follow this exact format:

Read this file when [specific task/scenario]. Contains [what the file contains]. Key exports: [main functions/classes/constants].

Rules:
- Be specific about WHEN to read (not just "when working with X" but "when adding a new validator" or "when debugging test failures")
- The description must be a single paragraph, max 3 sentences
- Focus on actionability: what task would make this file relevant?
- Do not include the file path in the description

File path: {path}

File contents:
{content}`;

export const BATCH_PROMPT_TEMPLATE = `Describe each file below as a routing hint for an LLM coding agent. For each file, produce a description following this exact format:

Read this file when [specific task/scenario]. Contains [what the file contains]. Key exports: [main functions/classes/constants].

Rules:
- Be specific about WHEN to read (not just "when working with X" but "when adding a new validator" or "when debugging test failures")
- Each description must be a single paragraph, max 3 sentences
- Focus on actionability: what task would make this file relevant?
- Do not include the file path in the description

Return ONLY a JSON object mapping each file path to its description string. No explanation, no markdown fences, just the JSON object.

Example output format:
{{"src/utils.py": "Read this file when adding helper functions. Contains utility methods for string parsing. Key exports: parse_url, slugify.", "src/main.py": "Read this file when modifying the CLI entry point. Contains argument parsing and command dispatch. Key exports: main, run_command."}}

{files_block}`;

// --- Template formatting ----------------------------------------------------

/**
 * Minimal `str.format`-compatible substitution. Replaces `{key}` tokens with
 * `vars[key]` and collapses doubled braces (`{{` / `}}`) to single braces so
 * literal JSON examples inside templates survive interpolation unchanged.
 */
export function formatTemplate(template: string, vars: Record<string, string>): string {
  let out = '';
  let i = 0;
  while (i < template.length) {
    const ch = template[i];
    if (ch === '{' && template[i + 1] === '{') {
      out += '{';
      i += 2;
      continue;
    }
    if (ch === '}' && template[i + 1] === '}') {
      out += '}';
      i += 2;
      continue;
    }
    if (ch === '{') {
      const end = template.indexOf('}', i + 1);
      if (end === -1) {
        out += ch;
        i++;
        continue;
      }
      const key = template.slice(i + 1, end);
      if (key in vars) {
        out += vars[key];
        i = end + 1;
        continue;
      }
      out += template.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

// --- Triage -----------------------------------------------------------------

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
 * Saves tokens by keeping obvious-skip files away from the LLM.
 */
export function triageFiles(filePaths: string[]): string[] {
  if (filePaths.length === 0) return [];
  const filtered = filePaths.filter((fp) => !isTriageExcluded(fp));
  logger.info(
    `Triage: ${filtered.length}/${filePaths.length} files selected for indexing (heuristic)`,
  );
  return filtered;
}

// --- Prompt builders --------------------------------------------------------

/** Truncate content to `MAX_CONTENT_LENGTH` with a trailing marker. */
export function truncateContent(content: string): string {
  if (content.length <= MAX_CONTENT_LENGTH) return content;
  return `${content.slice(0, MAX_CONTENT_LENGTH)}\n\n[... truncated at 8000 characters ...]`;
}

/** Build the single-file description prompt. */
export function generatePrompt(filePath: string, content: string): string {
  return formatTemplate(PROMPT_TEMPLATE, {
    path: filePath,
    content: truncateContent(content),
  });
}

/** Build the multi-file batch prompt. */
export function buildBatchPrompt(fileEntries: Array<[string, string]>): string {
  const parts = fileEntries.map(
    ([path, content]) => `--- FILE: ${path} ---\n${truncateContent(content)}\n--- END FILE ---`,
  );
  const filesBlock = parts.join('\n\n');
  return formatTemplate(BATCH_PROMPT_TEMPLATE, { files_block: filesBlock });
}

/** Strip leading/trailing ``` ... ``` fences from an LLM response. */
export function stripJsonFences(raw: string): string {
  let text = raw.trim();
  if (text.startsWith('```')) {
    const lines = text.split('\n');
    text = lines.slice(1).join('\n');
  }
  if (text.endsWith('```')) {
    const lines = text.split('\n');
    text = lines.slice(0, -1).join('\n');
  }
  return text.trim();
}

// --- Claude CLI runner ------------------------------------------------------

/**
 * Spawn `claude -p - --output-format text --model haiku` with the prompt
 * piped to stdin. Returns trimmed stdout on exit code 0; throws otherwise.
 */
export type ClaudeRunner = (prompt: string, timeoutSeconds: number) => Promise<string>;

async function realClaudeRunner(prompt: string, timeoutSeconds: number): Promise<string> {
  const proc = Bun.spawn({
    cmd: ['claude', '-p', '-', '--output-format', 'text', '--model', 'haiku'],
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: timeoutSeconds * 1000,
  });
  proc.stdin.write(prompt);
  await proc.stdin.end();

  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`claude CLI exited with code ${exitCode}: ${stderr || stdout}`);
  }
  return stdout.trim();
}

let currentRunner: ClaudeRunner = realClaudeRunner;

/** Override the CLI runner — for tests only. */
export function setClaudeRunner(runner: ClaudeRunner | null): void {
  currentRunner = runner ?? realClaudeRunner;
}

/** Low-level invocation; re-throws on spawn/timeout/non-zero exit. */
export async function callClaudeCli(
  prompt: string,
  timeoutSeconds: number = CLI_TIMEOUT_SECONDS,
): Promise<string> {
  return currentRunner(prompt, timeoutSeconds);
}

// --- Single-file description ------------------------------------------------

async function readFileText(filePath: string): Promise<string | null> {
  try {
    return await Bun.file(filePath).text();
  } catch (err) {
    logger.warn(`Could not read ${filePath}: ${stringifyError(err)}`);
    return null;
  }
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Read one file, prompt Claude for a routing description, return the result.
 * Returns an empty string on any I/O or CLI failure (matches Python parity).
 */
export async function describeFile(filePath: string, projectRoot: string): Promise<string> {
  const fullPath = `${projectRoot}/${filePath}`;
  const content = await readFileText(fullPath);
  if (content === null) return '';

  const prompt = generatePrompt(filePath, content);
  try {
    return await callClaudeCli(prompt);
  } catch (err) {
    logger.warn(`Claude CLI failed for ${filePath}: ${stringifyError(err)}`);
    return '';
  }
}

// --- Batched description ----------------------------------------------------

/**
 * Describe a batch in one CLI call. Single-file batches fall through to the
 * per-file prompt for simplicity.
 */
async function describeBatch(
  filePaths: string[],
  projectRoot: string,
): Promise<Record<string, string>> {
  const results: Record<string, string> = {};
  const entries: Array<[string, string]> = [];

  for (const fp of filePaths) {
    const content = await readFileText(`${projectRoot}/${fp}`);
    if (content === null) {
      results[fp] = '';
    } else {
      entries.push([fp, content]);
    }
  }

  if (entries.length === 0) return results;

  // Single-file fast path — same prompt shape as describeFile.
  if (entries.length === 1) {
    const [fp, content] = entries[0] as [string, string];
    const prompt = generatePrompt(fp, content);
    try {
      results[fp] = await callClaudeCli(prompt);
    } catch (err) {
      logger.warn(`Claude CLI failed for ${fp}: ${stringifyError(err)}`);
      results[fp] = '';
    }
    return results;
  }

  const prompt = buildBatchPrompt(entries);
  const timeoutSeconds = Math.max(BATCH_TIMEOUT_SECONDS, entries.length * 10);

  try {
    const raw = await callClaudeCli(prompt, timeoutSeconds);
    const stripped = stripJsonFences(raw);
    const parsed = JSON.parse(stripped) as unknown;

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      logger.warn('Batch response was not a JSON object, falling back');
      for (const [fp] of entries) {
        if (!(fp in results)) results[fp] = '';
      }
      return results;
    }

    const parsedMap = parsed as Record<string, unknown>;
    for (const [fp] of entries) {
      const desc = parsedMap[fp];
      results[fp] = typeof desc === 'string' ? desc : '';
    }
  } catch (err) {
    logger.warn(
      `Batch CLI call failed (${stringifyError(err)}), all ${entries.length} files get empty descriptions`,
    );
    for (const [fp] of entries) {
      if (!(fp in results)) results[fp] = '';
    }
  }

  return results;
}

function chunkList<T>(items: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  return chunks;
}

export interface DescribeFilesOptions {
  /** Max concurrent batches in flight. Default: 3. */
  concurrency?: number;
  /** Files per batch. Default: 25. */
  batchSize?: number;
  /** Invoked after each batch completes with (done, total, lastPathInBatch). */
  onProgress?: (done: number, total: number, path: string) => void;
}

/**
 * Batch-describe multiple files using parallel Claude CLI calls.
 *
 * Files are chunked into batches and each batch is sent to a single CLI
 * session. Up to `concurrency` batches run in parallel via a simple
 * semaphore. Failed batches leave every file in the batch as empty string.
 */
export async function describeFiles(
  filePaths: string[],
  projectRoot: string,
  options: DescribeFilesOptions = {},
): Promise<Record<string, string>> {
  const concurrency = options.concurrency ?? 3;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const onProgress = options.onProgress;

  const results: Record<string, string> = {};
  const total = filePaths.length;
  const batches = chunkList(filePaths, batchSize);
  let completed = 0;

  let cursor = 0;
  async function worker(): Promise<void> {
    while (true) {
      const idx = cursor++;
      if (idx >= batches.length) return;
      const batch = batches[idx] as string[];
      try {
        const batchResults = await describeBatch(batch, projectRoot);
        Object.assign(results, batchResults);
      } catch (err) {
        logger.warn(`Unexpected error describing batch: ${stringifyError(err)}`);
        for (const fp of batch) {
          if (!(fp in results)) results[fp] = '';
        }
      }

      completed = Math.min(completed + batch.length, total);
      if (onProgress) onProgress(completed, total, batch[batch.length - 1] as string);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, batches.length) }, () => worker());
  await Promise.all(workers);

  return results;
}
