/**
 * Machine-global auto-registry of every prove project the user has touched.
 *
 * Location: `~/.claude-prove/projects.json` — a home-dir dotfile under the
 * directory prove owns for machine-global state (the same `~/.claude-prove`
 * anchor the stable-root symlink chain uses). This spans every project on the
 * machine, so it carries no schema migration and no store table; it is plain
 * JSON read and written atomically.
 *
 * Shape:
 *   { "projects": [ { "path": "<abs repo root>", "name": "<dir basename>",
 *                     "last_seen": "<ISO-8601>", "hidden"?: true } ] }
 *
 * Two write disciplines mirror the rest of the codebase:
 *   - Atomic tmp+rename writes so a concurrent reader never sees a partial file.
 *   - Home-dir resolution anchored at `STABLE_ROOT_DIR`, with an explicit
 *     base-dir override as the test seam so tests never touch the real
 *     `~/.claude-prove/` (the same pattern the per-user contributor config uses).
 *
 * `upsert` is the only mutation that bumps `last_seen`, and it is gated by a
 * new-or-stale check: an absent path or one whose `last_seen` is older than
 * 24h is (re)stamped; a fresh entry is left untouched so routine reads do not
 * churn the file on every invocation. A `.claude/worktrees/<slug>-task-<id>`
 * path is folded back to its MAIN repo root before registration, so sub-task
 * worktrees never appear as distinct projects.
 *
 * A corrupt or malformed file is treated as an empty registry, but only after
 * the bad bytes are copied aside to a timestamped `.bak` sibling — corruption
 * is preserved for forensics rather than silently overwritten.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';

/**
 * Directory prove owns in the user's home for machine-global state — the same
 * `~/.claude-prove` anchor the stable-root symlink chain uses. Mirrored here
 * rather than imported: `@claude-prove/store` is a leaf dependency and must not
 * take an edge on `@claude-prove/installer` (which would close a store →
 * installer → cli → store cycle).
 */
const STABLE_ROOT_DIR = '.claude-prove';

/** A single registered project. `hidden` entries are filtered from `list`. */
export interface ProjectEntry {
  /** Absolute repository root (main worktree root, never a sub-task worktree). */
  path: string;
  /** Display name — the basename of the repo root. */
  name: string;
  /** ISO-8601 timestamp of the most recent `upsert`. */
  last_seen: string;
  /** Manually hidden by `hide`; excluded from `list` but retained on disk. */
  hidden?: boolean;
}

/** On-disk registry shape. Unrelated top-level keys are preserved on write. */
export interface ProjectRegistry {
  projects: ProjectEntry[];
  // Forward-compatibility: any future top-level keys survive a round-trip.
  [key: string]: unknown;
}

/** Staleness window: an entry older than this is re-stamped by `upsert`. */
const STALE_MS = 24 * 60 * 60 * 1000;

/** Path segment marking a namespaced sub-task worktree checkout. */
const WORKTREE_SEGMENT = join('.claude', 'worktrees');

/**
 * Resolve the registry base directory (the parent of `projects.json`). Honors,
 * in order: an explicit override, then the process env `CLAUDE_PROVE_HOME`,
 * else `~/.claude-prove`. The explicit override is the direct test seam; the
 * env var redirects callers that cannot thread an override param — notably the
 * best-effort auto-upsert fired from git-root resolution, which tests point at
 * a tmp dir so they NEVER touch the developer's real `~/.claude-prove/`.
 */
export function registryBaseDir(override?: string): string {
  if (override !== undefined && override.length > 0) return override;
  const envHome = process.env.CLAUDE_PROVE_HOME;
  if (envHome !== undefined && envHome.length > 0) return envHome;
  return join(homedir(), STABLE_ROOT_DIR);
}

/** Absolute path to `projects.json` under the resolved base dir. */
export function registryFilePath(baseOverride?: string): string {
  return join(registryBaseDir(baseOverride), 'projects.json');
}

/** A fresh, empty registry. */
function emptyRegistry(): ProjectRegistry {
  return { projects: [] };
}

/**
 * Fold a `.claude/worktrees/<slug>-task-<id>` checkout path back to its main
 * repo root: the directory two levels above the worktrees dir. A path that is
 * not a sub-task worktree is returned resolved but otherwise unchanged. The
 * result is always absolute so the registry key is stable across cwds.
 */
export function canonicalProjectRoot(projectPath: string): string {
  const abs = resolve(projectPath);
  const marker = `${sep}${WORKTREE_SEGMENT}${sep}`;
  const idx = abs.indexOf(marker);
  // The worktrees dir lives directly under the main root's `.claude/`, so the
  // segment immediately preceding `${sep}.claude${sep}worktrees${sep}` IS the
  // main repo root.
  if (idx >= 0) return abs.slice(0, idx);
  return abs;
}

/**
 * Read the registry. Tolerates an absent file (returns an empty registry). On a
 * corrupt or malformed file, the bad bytes are first copied aside to a
 * timestamped `.bak` sibling, then an empty registry is returned — corruption
 * is preserved for inspection, never silently clobbered.
 */
export function read(baseOverride?: string): ProjectRegistry {
  const path = registryFilePath(baseOverride);
  if (!existsSync(path)) return emptyRegistry();

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return backupAndEmpty(path);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return backupAndEmpty(path);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return backupAndEmpty(path);
  }

  const config = parsed as Record<string, unknown>;
  const projects = config.projects;
  if (!Array.isArray(projects)) {
    return backupAndEmpty(path);
  }

  // Normalize `projects` to an always-present array of well-formed entries,
  // dropping any element missing the required string fields, while preserving
  // every other top-level key verbatim.
  const clean = projects.filter(isProjectEntry);
  return { ...config, projects: clean };
}

/** Type guard: a value is a well-formed `ProjectEntry`. */
function isProjectEntry(value: unknown): value is ProjectEntry {
  if (value === null || typeof value !== 'object') return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.path === 'string' && typeof e.name === 'string' && typeof e.last_seen === 'string'
  );
}

/**
 * Copy the corrupt file aside to a timestamped `.bak` sibling and return an
 * empty registry. Best-effort on the copy — if even the copy fails (e.g. the
 * source vanished), the empty value is still returned so a read never throws on
 * corruption.
 */
function backupAndEmpty(path: string): ProjectRegistry {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  try {
    copyFileSync(path, `${path}.${stamp}.bak`);
  } catch {
    // The aside-copy is forensic, not load-bearing; an empty registry is the
    // contract regardless of whether the backup landed.
  }
  return emptyRegistry();
}

/**
 * Return the visible projects (hidden entries excluded), most-recently-seen
 * first. A read-only view — never mutates the file.
 */
export function list(baseOverride?: string): ProjectEntry[] {
  return read(baseOverride)
    .projects.filter((p) => p.hidden !== true)
    .sort((a, b) => b.last_seen.localeCompare(a.last_seen));
}

/**
 * Register or refresh `projectPath`, gated by a new-or-stale check. The path is
 * first folded to its canonical main repo root. If the root is absent from the
 * registry, or its `last_seen` is older than 24h, `last_seen` is bumped to now
 * (and the entry created if absent); a fresh entry is left untouched so routine
 * reads do not churn the file. The only mutation that touches `last_seen`.
 * Returns the (possibly unchanged) entry for the canonical root.
 */
export function upsert(projectPath: string, baseOverride?: string): ProjectEntry {
  const root = canonicalProjectRoot(projectPath);
  const registry = read(baseOverride);
  const now = Date.now();
  const existing = registry.projects.find((p) => p.path === root);

  if (existing !== undefined && !isStale(existing.last_seen, now)) {
    return existing;
  }

  const stamped: ProjectEntry = existing
    ? { ...existing, name: basename(root), last_seen: new Date(now).toISOString() }
    : { path: root, name: basename(root), last_seen: new Date(now).toISOString() };

  const projects = existing
    ? registry.projects.map((p) => (p.path === root ? stamped : p))
    : [...registry.projects, stamped];

  write({ ...registry, projects }, baseOverride);
  return stamped;
}

/** True when `lastSeen` is unparseable or older than the staleness window. */
function isStale(lastSeen: string, nowMs: number): boolean {
  const seen = Date.parse(lastSeen);
  if (Number.isNaN(seen)) return true;
  return nowMs - seen >= STALE_MS;
}

/**
 * Drop entries whose canonical repo root or its `.prove/prove.db` no longer
 * exists on disk, then write the survivors back. Returns the pruned roots.
 * Idempotent — re-running with nothing to prune leaves the file untouched.
 */
export function prune(baseOverride?: string): string[] {
  const registry = read(baseOverride);
  const dropped: string[] = [];
  const survivors = registry.projects.filter((p) => {
    if (projectAlive(p.path)) return true;
    dropped.push(p.path);
    return false;
  });
  if (dropped.length > 0) {
    write({ ...registry, projects: survivors }, baseOverride);
  }
  return dropped;
}

/** A project is alive when its root and its `.prove/prove.db` both exist. */
function projectAlive(root: string): boolean {
  return existsSync(root) && existsSync(join(root, '.prove', 'prove.db'));
}

/**
 * Manually mark `projectPath`'s canonical root hidden (excluded from `list`,
 * retained on disk). A no-op when the root is not registered. Returns true when
 * an entry was flipped to hidden.
 */
export function hide(projectPath: string, baseOverride?: string): boolean {
  const root = canonicalProjectRoot(projectPath);
  const registry = read(baseOverride);
  let changed = false;
  const projects = registry.projects.map((p) => {
    if (p.path === root && p.hidden !== true) {
      changed = true;
      return { ...p, hidden: true };
    }
    return p;
  });
  if (changed) write({ ...registry, projects }, baseOverride);
  return changed;
}

/**
 * Manually remove `projectPath`'s canonical root from the registry entirely.
 * Returns true when an entry was removed.
 */
export function remove(projectPath: string, baseOverride?: string): boolean {
  const root = canonicalProjectRoot(projectPath);
  const registry = read(baseOverride);
  const projects = registry.projects.filter((p) => p.path !== root);
  const changed = projects.length !== registry.projects.length;
  if (changed) write({ ...registry, projects }, baseOverride);
  return changed;
}

/**
 * Manually add `projectPath`'s canonical root, stamping `last_seen` to now.
 * Unlike `upsert`, this bypasses the staleness gate and un-hides an existing
 * hidden entry — it is the explicit operator counterpart to `hide`/`remove`.
 * Returns the resulting entry.
 */
export function add(projectPath: string, baseOverride?: string): ProjectEntry {
  const root = canonicalProjectRoot(projectPath);
  const registry = read(baseOverride);
  const existing = registry.projects.find((p) => p.path === root);
  // A fresh entry, always un-hidden: `add` is the explicit re-surface verb.
  const stamped: ProjectEntry = {
    path: root,
    name: basename(root),
    last_seen: new Date().toISOString(),
  };

  const projects = existing
    ? registry.projects.map((p) => (p.path === root ? stamped : p))
    : [...registry.projects, stamped];
  write({ ...registry, projects }, baseOverride);
  return stamped;
}

/**
 * Atomic write of the full registry. Writes a sibling tmp file then `rename(2)`s
 * it over the destination, so a concurrent reader observes either the old file
 * or the new one — never a partial. Creates the base dir if missing.
 */
function write(registry: ProjectRegistry, baseOverride?: string): void {
  const path = registryFilePath(baseOverride);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}
