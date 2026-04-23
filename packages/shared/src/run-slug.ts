/**
 * Run-slug resolution for ACB manifests and orchestrator-aware tools.
 *
 * Ported from `tools/acb/_slug.py`. A `run_slug` ties a manifest/commit to
 * a specific orchestrator run (`/prove:full-auto`, `/prove:autopilot`).
 * Consumers (orchestrator-review, ACB) query by slug to reconstruct
 * per-run activity.
 *
 * Discovery order (first match wins):
 *
 *  1. `PROVE_RUN_SLUG` environment variable — set by the orchestrator when
 *     spawning a worktree subagent.
 *  2. `<worktreeRoot>/.prove-wt-slug.txt` marker written by
 *     `manage-worktree.sh create`. Cheapest unambiguous lookup; pinned to
 *     the worktree itself.
 *  3. Scan `<mainWorktreeRoot>/.prove/runs/**\/plan.json` and match the
 *     task's `worktree.path` against the current worktree root (canonical
 *     paths via `realpathSync`).
 *  4. `<cwd || worktreeRoot || process.cwd()>/.prove/RUN_SLUG` manual
 *     escape-hatch marker.
 *  5. `null` — standalone commit outside an orchestrator run.
 *
 * File-read errors and empty contents fall through to the next tier.
 */

import type { Dirent } from 'node:fs';
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { mainWorktreeRoot, worktreeRoot } from './git';

const ENV_VAR = 'PROVE_RUN_SLUG';
const WT_SLUG_FILE = '.prove-wt-slug.txt';
const MARKER_REL = join('.prove', 'RUN_SLUG');
const RUNS_REL = join('.prove', 'runs');

/** Return the current run slug, or `null` if not inside an orchestrator run. */
export function resolveRunSlug(cwd?: string): string | null {
  const env = (process.env[ENV_VAR] ?? '').trim();
  if (env.length > 0) return env;

  const wt = worktreeRoot(cwd);
  const main = mainWorktreeRoot(cwd);

  if (wt !== null) {
    const wtMarker = join(wt, WT_SLUG_FILE);
    if (isFile(wtMarker)) {
      const text = readTrimmed(wtMarker);
      if (text !== null && text.length > 0) return text;
    }
  }

  if (main !== null && wt !== null) {
    const runsDir = join(main, RUNS_REL);
    const wtNorm = normalize(wt);
    if (isDir(runsDir)) {
      const slug = scanPlansForWorktree(runsDir, wtNorm);
      if (slug !== null) return slug;
    }
  }

  const root = cwd ?? wt ?? process.cwd();
  const marker = join(root, MARKER_REL);
  if (isFile(marker)) {
    const text = readTrimmed(marker);
    if (text === null) return null;
    if (text.length > 0) return text;
  }

  return null;
}

/** Scan `runsDir/**\/plan.json` and return the slug whose plan registers `wtNorm`. */
function scanPlansForWorktree(runsDir: string, wtNorm: string): string | null {
  for (const planPath of findPlanJson(runsDir)) {
    let raw: string;
    try {
      raw = readFileSync(planPath, 'utf8');
    } catch {
      continue;
    }
    let plan: unknown;
    try {
      plan = JSON.parse(raw);
    } catch {
      continue;
    }
    const tasks = extractTasks(plan);
    for (const task of tasks) {
      const wt = extractWorktreePath(task);
      if (wt && normalize(wt) === wtNorm) {
        // Slug = directory name containing plan.json.
        return basename(dirname(planPath));
      }
    }
  }
  return null;
}

/** Recursively yield every `plan.json` under `dir`. Equivalent to `Path.rglob("plan.json")`. */
function* findPlanJson(dir: string): Generator<string> {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' }) as Dirent[];
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* findPlanJson(full);
    } else if (entry.isFile() && entry.name === 'plan.json') {
      yield full;
    }
  }
}

function extractTasks(plan: unknown): unknown[] {
  if (plan === null || typeof plan !== 'object' || Array.isArray(plan)) return [];
  const tasks = (plan as { tasks?: unknown }).tasks;
  return Array.isArray(tasks) ? tasks : [];
}

function extractWorktreePath(task: unknown): string | null {
  if (task === null || typeof task !== 'object' || Array.isArray(task)) return null;
  const wt = (task as { worktree?: unknown }).worktree;
  if (wt === null || typeof wt !== 'object' || Array.isArray(wt)) return null;
  const path = (wt as { path?: unknown }).path;
  return typeof path === 'string' && path.length > 0 ? path : null;
}

/** Canonical path string for comparison across symlink/realpath variations. */
function normalize(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function readTrimmed(path: string): string | null {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return null;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
