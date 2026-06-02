/**
 * Per-user (home-directory) claude-prove config — the project-root → default
 * contributor mapping. This is the "active contributor is implicit per project"
 * mechanism: a user records, once per project root, which contributor CT-UUID
 * they drive as, so callers need not pass it on every invocation.
 *
 * Location: `${XDG_CONFIG_HOME:-~/.config}/claude-prove/config.json`. The same
 * `homedir()` + XDG convention used by the binary upgrader and the CLAUDE.md
 * generator. This is a home-dir dotfile, NOT project DB state — it spans every
 * project on the machine, so it carries no schema migration and no store table.
 *
 * Shape:
 *   { "default_contributors": { "<absolute-project-root>": "<CT-UUID>" } }
 *
 * Decoupling invariant: the mapping stores the CT-UUID string verbatim. It is
 * NOT validated against any single project's `.prove/prove.db` registry here —
 * the config spans projects, so a CT-UUID minted in project A is meaningless to
 * project B's store. The caller resolves the returned CT-UUID against the
 * relevant project's registry later.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** On-disk config shape. Unrelated top-level keys are preserved on write. */
export interface UserConfig {
  default_contributors: Record<string, string>;
  // Forward-compatibility: any future top-level keys survive a round-trip.
  [key: string]: unknown;
}

/**
 * Resolve the config base directory (the parent of `claude-prove/`). Honors an
 * explicit `XDG_CONFIG_HOME`, then the process env `XDG_CONFIG_HOME`, else
 * `~/.config`. The explicit override is the test seam — tests pass a tmp dir so
 * they NEVER touch the developer's real `~/.config`.
 */
export function configBaseDir(override?: string): string {
  if (override !== undefined && override.length > 0) return override;
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg !== undefined && xdg.length > 0) return xdg;
  return join(homedir(), '.config');
}

/** Absolute path to the config file under the resolved base dir. */
export function configFilePath(baseOverride?: string): string {
  return join(configBaseDir(baseOverride), 'claude-prove', 'config.json');
}

/** A fresh, empty config. */
function emptyConfig(): UserConfig {
  return { default_contributors: {} };
}

/**
 * Read the user config. Tolerates an absent file (returns an empty config) and
 * throws a clear, path-anchored error on a malformed file — never silently
 * swallowing corruption, which would lose the user's project mappings.
 */
export function readUserConfig(baseOverride?: string): UserConfig {
  const path = configFilePath(baseOverride);
  if (!existsSync(path)) return emptyConfig();

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`failed to read user config at ${path}: ${msg}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`malformed user config at ${path}: ${msg}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`malformed user config at ${path}: expected a JSON object`);
  }

  const config = parsed as Record<string, unknown>;
  const map = config.default_contributors;
  if (map !== undefined && (typeof map !== 'object' || map === null || Array.isArray(map))) {
    throw new Error(
      `malformed user config at ${path}: 'default_contributors' must be an object of root → CT-UUID`,
    );
  }
  // Normalize the mapping to an always-present object so callers never branch
  // on its absence, while preserving every other top-level key verbatim.
  return { ...config, default_contributors: { ...((map as Record<string, string>) ?? {}) } };
}

/**
 * Resolve the default contributor CT-UUID mapped to `projectRoot`, or `null`
 * when the root is unmapped. Never throws on a miss — an unmapped root is the
 * sane fallback, not an error. The project root is resolved to an absolute path
 * so the lookup key is stable regardless of the caller's cwd.
 */
export function resolveDefaultContributor(
  projectRoot: string,
  baseOverride?: string,
): string | null {
  const config = readUserConfig(baseOverride);
  const key = resolve(projectRoot);
  const id = config.default_contributors[key];
  return id !== undefined && id.length > 0 ? id : null;
}

/**
 * Map `projectRoot` → `contributorId` in the user config, then write it back.
 * Creates the config dir if missing, preserves unrelated top-level keys, and
 * writes atomically (write a sibling tmp file, then `rename(2)` over the
 * destination) so a concurrent reader never observes a partial file. Returns
 * the resolved absolute project-root key that was written.
 */
export function setDefaultContributor(
  projectRoot: string,
  contributorId: string,
  baseOverride?: string,
): string {
  const config = readUserConfig(baseOverride);
  const key = resolve(projectRoot);
  config.default_contributors[key] = contributorId;
  writeUserConfig(config, baseOverride);
  return key;
}

/** Atomic write of the full config object. See `setDefaultContributor`. */
function writeUserConfig(config: UserConfig, baseOverride?: string): void {
  const path = configFilePath(baseOverride);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}
