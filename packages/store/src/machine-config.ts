/**
 * Machine-global claude-prove config at `~/.claude-prove/config.json` — the
 * home-directory store for cross-project settings that span every repo on the
 * machine. Its first tenant is the project-root → default-contributor mapping
 * ("the active contributor is implicit per project"): a user records, once per
 * project root, which contributor CT-UUID they drive as, so callers need not
 * pass it on every invocation.
 *
 * Location: `~/.claude-prove/config.json`, the directory prove owns in the
 * user's home for machine-global state (the same root that anchors the stable
 * plugin-link chain). This is a home-dir dotfile, NOT project DB state — it
 * spans every project on the machine, so it carries no schema migration and no
 * store table.
 *
 * Shape:
 *   { "default_contributors": { "<absolute-project-root>": "<CT-UUID>" } }
 *
 * Decoupling invariant: the mapping stores the CT-UUID string verbatim. It is
 * NOT validated against any single project's `.prove/prove.db` registry here —
 * the config spans projects, so a CT-UUID minted in project A is meaningless to
 * project B's store. The caller resolves the returned CT-UUID against the
 * relevant project's registry later.
 *
 * Legacy compatibility: reads fall back per-key to the XDG location
 * `${XDG_CONFIG_HOME:-~/.config}/claude-prove/config.json` so an un-migrated
 * machine still resolves; all WRITES go to the `~/.claude-prove/config.json`
 * location only, so the map drifts toward the canonical home one key at a time
 * as values are re-set.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** Directory prove owns in the user's home for machine-global state. */
const STABLE_ROOT_DIR = '.claude-prove';

/**
 * Env override for the machine-config base dir. Primarily the seam that lets
 * test suites exercise handler-level code paths (which never thread an
 * explicit base) without touching the developer's real `~/.claude-prove/`;
 * doubles as an escape hatch for unusual home layouts.
 */
export const MACHINE_CONFIG_DIR_ENV_VAR = 'CLAUDE_PROVE_MACHINE_CONFIG_DIR';

/** Config filename under the machine-global root and the legacy XDG dir alike. */
const CONFIG_FILENAME = 'config.json';

/** On-disk config shape. Unrelated top-level keys are preserved on write. */
export interface MachineConfig {
  default_contributors: Record<string, string>;
  // Forward-compatibility: any future top-level keys survive a round-trip.
  [key: string]: unknown;
}

/**
 * Resolve the machine-config base directory (the `~/.claude-prove` root).
 * Precedence: explicit override param (direct-call test seam), then the
 * `CLAUDE_PROVE_MACHINE_CONFIG_DIR` env var (handler-level test seam — those
 * call sites never thread a base), then the home default.
 */
export function machineConfigBaseDir(override?: string): string {
  if (override !== undefined && override.length > 0) return override;
  const env = process.env[MACHINE_CONFIG_DIR_ENV_VAR];
  if (env !== undefined && env.length > 0) return env;
  return join(homedir(), STABLE_ROOT_DIR);
}

/** Absolute path to the machine config file under the resolved base dir. */
export function machineConfigFilePath(baseOverride?: string): string {
  return join(machineConfigBaseDir(baseOverride), CONFIG_FILENAME);
}

/**
 * Resolve the legacy XDG base dir (the parent of `claude-prove/`). Honors an
 * explicit override (test seam), then the process env `XDG_CONFIG_HOME`, else
 * `~/.config` — the XDG default.
 */
function legacyConfigBaseDir(override?: string): string {
  if (override !== undefined && override.length > 0) return override;
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg !== undefined && xdg.length > 0) return xdg;
  return join(homedir(), '.config');
}

/** Absolute path to the legacy XDG config file under the resolved base dir. */
function legacyConfigFilePath(baseOverride?: string): string {
  return join(legacyConfigBaseDir(baseOverride), 'claude-prove', CONFIG_FILENAME);
}

/** A fresh, empty config. */
function emptyConfig(): MachineConfig {
  return { default_contributors: {} };
}

/**
 * Parse raw config text into a normalized `MachineConfig`, or return `null` when
 * the text is not a JSON object with a well-formed `default_contributors` map.
 * Pure (no I/O) so both the new-location read and the legacy fallback share one
 * shape contract.
 */
function parseConfig(raw: string): MachineConfig | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const config = parsed as Record<string, unknown>;
  const map = config.default_contributors;
  if (map !== undefined && (typeof map !== 'object' || map === null || Array.isArray(map))) {
    return null;
  }
  // Normalize the mapping to an always-present object so callers never branch
  // on its absence, while preserving every other top-level key verbatim.
  return { ...config, default_contributors: { ...((map as Record<string, string>) ?? {}) } };
}

/**
 * Move a malformed config aside so a fresh empty config can take its place
 * without destroying the user's data. The corrupt file is renamed in place with
 * a `.corrupt-<timestamp>` suffix — never deleted — so the bad content stays
 * recoverable for inspection. A failed rename is swallowed: an unreadable backup
 * must not block the caller from proceeding with an empty config.
 */
function backupAside(path: string): void {
  const aside = `${path}.corrupt-${Date.now()}`;
  try {
    renameSync(path, aside);
  } catch {
    // Best-effort: if the rename fails the original is left untouched and the
    // caller still proceeds with an empty config rather than throwing.
  }
}

/**
 * Read the machine config. Tolerates an absent file (returns an empty config)
 * and, on a malformed file, backs the corrupt file aside (see `backupAside`)
 * then returns an empty config — corruption never throws here, because a
 * machine-global dotfile that one bad write corrupted must not wedge every
 * subsequent invocation.
 */
export function readMachineConfig(baseOverride?: string): MachineConfig {
  const path = machineConfigFilePath(baseOverride);
  if (!existsSync(path)) return emptyConfig();

  const raw = readFileSync(path, 'utf8');
  const config = parseConfig(raw);
  if (config === null) {
    backupAside(path);
    return emptyConfig();
  }
  return config;
}

/**
 * Read the legacy XDG config as a normalized `MachineConfig`. Independent of the
 * new-location reader so the fallback never depends on legacy-owning modules.
 * An absent or malformed legacy file is treated as empty — the legacy file is a
 * read-only fallback source, so it is never backed aside or repaired here.
 */
function readLegacyConfig(legacyBaseOverride?: string): MachineConfig {
  const path = legacyConfigFilePath(legacyBaseOverride);
  if (!existsSync(path)) return emptyConfig();
  const raw = readFileSync(path, 'utf8');
  return parseConfig(raw) ?? emptyConfig();
}

/**
 * Resolve the default contributor CT-UUID mapped to `projectRoot`, or `null`
 * when the root is unmapped in either location. Prefers the new
 * `~/.claude-prove/config.json` value and falls back to the legacy XDG location
 * per-key, so the new location shadows the legacy one when both carry the key.
 * Never throws on a miss — an unmapped root is the sane fallback, not an error.
 * The project root is resolved to an absolute path so the lookup key is stable
 * regardless of the caller's cwd.
 */
export function resolveDefaultContributor(
  projectRoot: string,
  baseOverride?: string,
  legacyBaseOverride?: string,
): string | null {
  const key = resolve(projectRoot);

  const current = readMachineConfig(baseOverride).default_contributors[key];
  if (current !== undefined && current.length > 0) return current;

  const legacy = readLegacyConfig(legacyBaseOverride).default_contributors[key];
  return legacy !== undefined && legacy.length > 0 ? legacy : null;
}

/**
 * Map `projectRoot` → `contributorId` in the machine config, then write it back
 * to the new `~/.claude-prove/config.json` location only. Reads the current
 * config first so unrelated keys survive, resolves the project root to an
 * absolute key, and writes atomically. Returns the resolved absolute
 * project-root key that was written.
 */
export function setDefaultContributor(
  projectRoot: string,
  contributorId: string,
  baseOverride?: string,
): string {
  const config = readMachineConfig(baseOverride);
  const key = resolve(projectRoot);
  config.default_contributors[key] = contributorId;
  writeMachineConfig(config, baseOverride);
  return key;
}

/**
 * Atomic write of the full config object to the new location: write a sibling
 * tmp file, then `rename(2)` over the destination, so a concurrent reader never
 * observes a partial file. Creates the config dir if missing.
 */
function writeMachineConfig(config: MachineConfig, baseOverride?: string): void {
  const path = machineConfigFilePath(baseOverride);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}
