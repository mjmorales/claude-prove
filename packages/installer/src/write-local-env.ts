/**
 * Idempotent merge of the per-machine plugin-dir override into
 * `.claude/settings.local.json`.
 *
 * The file is Claude Code's local (auto-gitignored) settings layer; its
 * `env` block is injected into every hook command and Bash invocation of a
 * session. Writing `CLAUDE_PROVE_PLUGIN_DIR` there is how a contributor
 * points the portable `${CLAUDE_PROVE_PLUGIN_DIR:-...}` artifacts at their
 * own checkout without touching any git-tracked file.
 *
 * All keys outside `env.CLAUDE_PROVE_PLUGIN_DIR` are preserved byte-for-byte
 * at the JSON level. Writes go through a temp file + rename for atomicity.
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { PLUGIN_DIR_ENV_VAR } from './plugin-root';

export interface LocalSettingsFile {
  env?: Record<string, string>;
  [k: string]: unknown;
}

/** Thrown when settings.local.json exists but cannot be parsed as JSON. */
export class LocalSettingsParseError extends Error {
  public readonly path: string;
  public readonly parseError: Error;

  constructor(path: string, parseError: Error) {
    super(`Failed to parse local settings file at ${path}: ${parseError.message}`);
    this.name = 'LocalSettingsParseError';
    this.path = path;
    this.parseError = parseError;
  }
}

function readLocalSettings(path: string): LocalSettingsFile {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw new Error(`Failed to read local settings file at ${path}: ${(err as Error).message}`, {
      cause: err,
    });
  }
  try {
    return JSON.parse(raw) as LocalSettingsFile;
  } catch (err) {
    throw new LocalSettingsParseError(path, err as Error);
  }
}

/**
 * Merge `env.CLAUDE_PROVE_PLUGIN_DIR = pluginDir` into the local settings
 * file at `settingsPath`.
 *
 * Behavior:
 * - Missing file → scaffold `{ env: { CLAUDE_PROVE_PLUGIN_DIR: <dir> } }`.
 * - Existing file → only the one env key is added or rewritten; every other
 *   key (permissions, other env vars, unknown blocks) is preserved.
 * - Value already current → no write.
 *
 * Validates the parsed source before mutation; throws
 * `LocalSettingsParseError` on malformed JSON without writing anything.
 *
 * @returns `true` if the file was written, `false` if already in sync.
 */
export function writeLocalEnv(settingsPath: string, pluginDir: string): boolean {
  const settings = readLocalSettings(settingsPath);
  if (settings.env?.[PLUGIN_DIR_ENV_VAR] === pluginDir) return false;

  settings.env = { ...settings.env, [PLUGIN_DIR_ENV_VAR]: pluginDir };

  const serialized = `${JSON.stringify(settings, null, 2)}\n`;
  const tmp = `${settingsPath}.tmp.${process.pid}`;
  writeFileSync(tmp, serialized, 'utf8');
  renameSync(tmp, settingsPath);
  return true;
}
