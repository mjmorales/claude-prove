/**
 * `claude-prove install latest` — resolve the definitive source-of-truth for
 * where the prove plugin lives on disk and what version the remote release
 * channel is currently shipping.
 *
 * Emits a single JSON object on stdout:
 *
 *   {
 *     "local":  { "id", "version", "installPath", "scope" } | null,
 *     "remote": { "tagName", "version", "url" }            | null,
 *     "upToDate": boolean | null
 *   }
 *
 * `local` comes from `claude plugin list --json`, filtered to `prove@prove`
 * and sorted by semver (newest wins). If multiple entries share the newest
 * version, we prefer the most recently updated one so stale project-scope
 * caches never win over a fresh user-scope install. This guarantees the
 * `/prove:update` skill always targets the cache directory the user is
 * actually running against.
 *
 * `remote` comes from the GitHub Releases API (`/releases/latest`). It is
 * an optional field — the command succeeds even when the network call
 * fails (offline, rate-limited, etc.) so callers can still act on `local`.
 *
 * `upToDate` is `true` when both fields resolve and semver-compare equal,
 * `false` when they differ, and `null` when either side is unknown.
 *
 * Env overrides (for tests; undocumented in user-facing help):
 *   - PROVE_PLUGIN_LIST_CMD  : shell command substituted for
 *                              `claude plugin list --json`. Must emit the
 *                              same JSON shape.
 *   - PROVE_GH_API_BASE      : base URL for the releases API. Defaults to
 *                              `https://api.github.com`.
 *
 * Exit codes:
 *   0 — JSON emitted (even when fields are null)
 *   1 — catastrophic failure (e.g., JSON.stringify threw). The command
 *       never exits 1 solely because one lookup failed.
 */

import { spawnSync } from 'node:child_process';

const DEFAULT_GH_API_BASE = 'https://api.github.com';
const RELEASES_PATH = '/repos/mjmorales/claude-prove/releases/latest';
const PLUGIN_ID = 'prove@prove';
const REMOTE_TIMEOUT_MS = 5000;

export interface LatestFlags {
  /** Skip the GitHub API call. Useful in offline environments and tests. */
  offline?: boolean;
}

interface LocalPlugin {
  id: string;
  version: string;
  installPath: string;
  scope: string;
}

interface RemoteRelease {
  tagName: string;
  version: string;
  url: string;
}

interface LatestOutput {
  local: LocalPlugin | null;
  remote: RemoteRelease | null;
  upToDate: boolean | null;
  errors: { local?: string; remote?: string };
}

export async function runLatest(flags: LatestFlags): Promise<number> {
  const errors: LatestOutput['errors'] = {};

  const localResult = resolveLocal();
  if (localResult.error) errors.local = localResult.error;

  let remoteResult: { value: RemoteRelease | null; error?: string } = { value: null };
  if (!flags.offline) {
    remoteResult = await resolveRemote();
    if (remoteResult.error) errors.remote = remoteResult.error;
  }

  const out: LatestOutput = {
    local: localResult.value,
    remote: remoteResult.value,
    upToDate: compareVersions(localResult.value?.version, remoteResult.value?.version),
    errors,
  };

  try {
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`claude-prove install latest: ${errMessage(err)}\n`);
    return 1;
  }
}

/**
 * Shell out to `claude plugin list --json` (or the override command) and
 * pick the prove@prove entry with the highest semver. Ties broken by
 * `lastUpdated` recency so the freshest cache wins.
 */
function resolveLocal(): { value: LocalPlugin | null; error?: string } {
  const cmd = process.env.PROVE_PLUGIN_LIST_CMD ?? 'claude plugin list --json';
  const result = spawnSync(cmd, { shell: true, encoding: 'utf8' });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    return {
      value: null,
      error: `\`${cmd}\` exited ${result.status ?? -1}${detail ? `: ${detail}` : ''}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (err) {
    return { value: null, error: `failed to parse plugin list JSON: ${errMessage(err)}` };
  }

  if (!Array.isArray(parsed)) {
    return { value: null, error: 'plugin list output was not a JSON array' };
  }

  const candidates: LocalPlugin[] = [];
  for (const entry of parsed) {
    if (!isPluginListEntry(entry)) continue;
    if (entry.id !== PLUGIN_ID) continue;
    candidates.push({
      id: entry.id,
      version: entry.version,
      installPath: entry.installPath,
      scope: entry.scope,
    });
  }

  if (candidates.length === 0) {
    return { value: null, error: `no ${PLUGIN_ID} entry in plugin list` };
  }

  candidates.sort((a, b) => {
    const byVersion = compareSemver(b.version, a.version);
    if (byVersion !== 0) return byVersion;
    // Tie-break on installPath (deterministic; recency isn't exposed in this
    // shape). Callers can still override via CLAUDE_PLUGIN_ROOT.
    return a.installPath.localeCompare(b.installPath);
  });

  return { value: candidates[0] ?? null };
}

/**
 * Hit the GitHub Releases API for the latest tag. Tolerant of network
 * failures and rate-limit 403s — returns `{ value: null, error }` rather
 * than throwing.
 */
async function resolveRemote(): Promise<{ value: RemoteRelease | null; error?: string }> {
  const base = process.env.PROVE_GH_API_BASE ?? DEFAULT_GH_API_BASE;
  const url = `${base}${RELEASES_PATH}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REMOTE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'claude-prove-cli',
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      return { value: null, error: `${url} -> ${res.status} ${res.statusText}` };
    }
    const body = (await res.json()) as { tag_name?: unknown; html_url?: unknown };
    const tagName = typeof body.tag_name === 'string' ? body.tag_name : undefined;
    if (!tagName) {
      return { value: null, error: 'releases API response missing tag_name' };
    }
    const htmlUrl = typeof body.html_url === 'string' ? body.html_url : `${url}`;
    return {
      value: {
        tagName,
        version: tagName.replace(/^v/, ''),
        url: htmlUrl,
      },
    };
  } catch (err) {
    return { value: null, error: errMessage(err) };
  } finally {
    clearTimeout(timeout);
  }
}

function isPluginListEntry(
  entry: unknown,
): entry is { id: string; version: string; installPath: string; scope: string } {
  if (typeof entry !== 'object' || entry === null) return false;
  const e = entry as Record<string, unknown>;
  return (
    typeof e.id === 'string' &&
    typeof e.version === 'string' &&
    typeof e.installPath === 'string' &&
    typeof e.scope === 'string'
  );
}

function compareVersions(local: string | undefined, remote: string | undefined): boolean | null {
  if (!local || !remote) return null;
  return compareSemver(local, remote) === 0;
}

/** Returns positive if a > b, negative if a < b, 0 if equal. Non-semver sorts last. */
function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa && !pb) return a.localeCompare(b);
  if (!pa) return -1;
  if (!pb) return 1;
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function parseSemver(v: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
