/**
 * `prove review-ui config` — emit review-ui config as JSON with defaults filled.
 *
 * Reads `.claude/.prove.json` from --cwd (default: process.cwd()) and emits
 * `{ port, image, tag }` on stdout. Any missing key falls back to the
 * hardcoded defaults, so shell callers can do `jq -r .port`, `.image`,
 * `.tag` without their own `${VAR:-default}` chain.
 *
 * Replaces the three `python3 -c 'import json,...'` one-liners in
 * `commands/review-ui.md` with a single `prove review-ui config` call.
 *
 * Exit codes:
 *   0  success (including missing config file -> defaults)
 *   1  malformed JSON or unexpected read error
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface ReviewUiConfig {
  port: number;
  image: string;
  tag: string;
}

export interface RunConfigOptions {
  cwd?: string;
}

const DEFAULT_PORT = 5174;
const DEFAULT_IMAGE = 'ghcr.io/mjmorales/claude-prove/review-ui';
const DEFAULT_TAG = 'latest';

export const REVIEW_UI_DEFAULTS: Readonly<ReviewUiConfig> = Object.freeze({
  port: DEFAULT_PORT,
  image: DEFAULT_IMAGE,
  tag: DEFAULT_TAG,
});

export function runConfig(opts: RunConfigOptions): number {
  const cwd = resolve(opts.cwd ?? process.cwd());
  const configPath = join(cwd, '.claude', '.prove.json');

  let parsed: unknown;
  try {
    parsed = readConfigFile(configPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`prove review-ui config: ${msg}`);
    return 1;
  }

  const resolved = resolveReviewUiConfig(parsed);
  process.stdout.write(`${JSON.stringify(resolved)}\n`);
  return 0;
}

/**
 * Returns `undefined` when the file is absent (caller falls back to
 * defaults). Throws on malformed JSON or unexpected I/O errors so the
 * caller can surface them as exit 1.
 */
function readConfigFile(configPath: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch (err) {
    if (isEnoent(err)) return undefined;
    throw new Error(`failed to read ${configPath}: ${errMessage(err)}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`malformed JSON in ${configPath}: ${errMessage(err)}`);
  }
}

/**
 * Walks `tools.acb.config.review_ui_{port,image,tag}` and merges over the
 * hardcoded defaults. Generic enough to extend to other keys later if the
 * review-ui topic grows — the traversal operates on the parsed JSON, not on
 * a coupled schema.
 */
export function resolveReviewUiConfig(parsed: unknown): ReviewUiConfig {
  const acbConfig = pickObject(pickObject(pickObject(parsed, 'tools'), 'acb'), 'config');

  const port = coercePort(acbConfig.review_ui_port);
  const image = coerceString(acbConfig.review_ui_image);
  const tag = coerceString(acbConfig.review_ui_tag);

  return {
    port: port ?? DEFAULT_PORT,
    image: image ?? DEFAULT_IMAGE,
    tag: tag ?? DEFAULT_TAG,
  };
}

function pickObject(value: unknown, key: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object') return {};
  const next = (value as Record<string, unknown>)[key];
  if (next === null || typeof next !== 'object') return {};
  return next as Record<string, unknown>;
}

function coercePort(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return undefined;
}

function coerceString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  return undefined;
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === 'ENOENT'
  );
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
