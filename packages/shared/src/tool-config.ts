/**
 * Per-tool config reader for `.claude/.prove.json`.
 *
 * Replaces `tools/_lib/config.py`, but reads from the post-v4 schema path
 * `tools.<toolName>.config` instead of the retired top-level `index` key.
 * Callers (CAFI, PCD, etc.) pass their own tool name plus the defaults they
 * want merged with user overrides.
 */

import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Default config values. Matches the Python version one-for-one so existing
 * tools keep the same fallbacks until they opt in to stricter validation.
 */
export const DEFAULT_CONFIG: Readonly<Record<string, unknown>> = Object.freeze({
  excludes: [],
  max_file_size: 102400,
  concurrency: 3,
  batch_size: 25,
  triage: true,
});

export class MissingConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingConfigError';
  }
}

export interface LoadToolConfigOptions {
  /** When `true` (default) throw `MissingConfigError` if the file is absent. */
  require?: boolean;
}

export interface ToolConfigLogger {
  warn(message: string): void;
}

/**
 * Read and merge `tools.<toolName>.config` from `.claude/.prove.json`.
 *
 * Merge order: `defaults` < user overrides from the config file. Missing
 * tool entries return `defaults` as-is. JSON or I/O errors log a warning
 * (via `console.warn` by default) and fall back to `defaults` so a broken
 * config file degrades gracefully for non-critical tools.
 */
export function loadToolConfig<Defaults extends Record<string, unknown>>(
  projectRoot: string,
  toolName: string,
  defaults: Defaults,
  options: LoadToolConfigOptions = {},
  logger: ToolConfigLogger = console,
): Defaults & Record<string, unknown> {
  const require = options.require ?? true;
  const configPath = resolve(projectRoot, '.claude', '.prove.json');

  if (!fileExists(configPath)) {
    if (require) {
      throw new MissingConfigError(
        `No .claude/.prove.json found.\n  Project root: ${resolve(
          projectRoot,
        )}\n  Expected config: ${configPath}\nConfig is required to run.`,
      );
    }
    return { ...defaults };
  }

  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch (err) {
    logger.warn(`Could not read config from ${configPath}: ${stringifyError(err)}`);
    return { ...defaults };
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    logger.warn(`Could not read config from ${configPath}: ${stringifyError(err)}`);
    return { ...defaults };
  }

  const toolConfig = extractToolConfig(data, toolName);
  return { ...defaults, ...toolConfig };
}

function fileExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function extractToolConfig(data: unknown, toolName: string): Record<string, unknown> {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return {};
  const tools = (data as { tools?: unknown }).tools;
  if (tools === null || typeof tools !== 'object' || Array.isArray(tools)) return {};

  const entry = (tools as Record<string, unknown>)[toolName];
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return {};

  const config = (entry as { config?: unknown }).config;
  if (config === null || typeof config !== 'object' || Array.isArray(config)) return {};
  return config as Record<string, unknown>;
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
