/**
 * Slug + branch + runs-root resolution for every `run-state` CLI action.
 *
 * Matches `tools/run_state/__main__.py::_resolve_paths` behavior exactly:
 *  1. runs_root  = --runs-root || $CLAUDE_PROJECT_DIR/.prove/runs || cwd/.prove/runs
 *  2. slug       = --slug || $PROVE_RUN_SLUG || _autodetectSlug()
 *  3. branch     = --branch || $PROVE_RUN_BRANCH || _autodetectBranch(runsRoot, slug)
 *
 * `_autodetectSlug` walks from cwd upward looking for `.prove-wt-slug.txt`
 * then `.prove/RUN_SLUG`, stopping at a `.git` entry (worktrees can have
 * `.git` as a file, not a dir — `existsSync` covers both).
 *
 * `_autodetectBranch` scans `<runsRoot>/<branch>/<slug>/` for `state.json`,
 * falling back to `plan.json`/`prd.json` so `init` can proceed before
 * `state.json` exists.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { RunPaths } from '../paths';

export interface RunSelection {
  runsRoot?: string;
  branch?: string;
  slug?: string;
}

export interface ResolvedRun {
  runsRoot: string;
  branch: string;
  slug: string;
  paths: RunPaths;
}

/** Exit code 2 per Python CLI semantics (schema/state invariant violation). */
export class ResolveError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 2) {
    super(message);
    this.name = 'ResolveError';
    this.exitCode = exitCode;
  }
}

export function defaultRunsRoot(): string {
  const project = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  return join(project, '.prove', 'runs');
}

export function resolvePaths(selection: RunSelection): ResolvedRun {
  const runsRoot = resolve(selection.runsRoot ?? defaultRunsRoot());
  const slug = selection.slug ?? process.env.PROVE_RUN_SLUG ?? autodetectSlug();
  if (!slug) {
    throw new ResolveError(
      'no run slug found. Expected .prove-wt-slug.txt in the worktree root ' +
        '(written by skills/orchestrator/scripts/manage-worktree.sh create) or PROVE_RUN_SLUG env var. ' +
        'Run `skills/orchestrator/scripts/manage-worktree.sh create <slug> <task-id>` or set the marker manually.',
    );
  }

  const branch = selection.branch ?? process.env.PROVE_RUN_BRANCH ?? autodetectBranch(runsRoot, slug);
  if (!branch) {
    throw new ResolveError(
      `slug '${slug}' is not registered under ${runsRoot}. ` +
        'Expected .prove/runs/<branch>/<slug>/ to exist. ' +
        'Run `prove run-state init --branch <b> --slug <s> --plan ...` first.',
    );
  }

  return {
    runsRoot,
    branch,
    slug,
    paths: RunPaths.forRun(runsRoot, branch, slug),
  };
}

/**
 * Walk from cwd upward looking for `.prove-wt-slug.txt` then
 * `.prove/RUN_SLUG`. Stop at the repo root (any ancestor with a `.git`
 * entry — dir OR file, for worktree support).
 */
function autodetectSlug(): string | undefined {
  let cur = resolve(process.cwd());
  // Iterate until dirname is a no-op (cur is root)
  // biome-ignore lint/suspicious/noConstantCondition: exit when parent === cur
  while (true) {
    const wtMarker = join(cur, '.prove-wt-slug.txt');
    if (isFile(wtMarker)) {
      const text = readFileSync(wtMarker, 'utf8').trim();
      if (text) return text;
    }
    const runMarker = join(cur, '.prove', 'RUN_SLUG');
    if (isFile(runMarker)) {
      const text = readFileSync(runMarker, 'utf8').trim();
      if (text) return text;
    }
    if (existsSync(join(cur, '.git'))) break; // repo root
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return undefined;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function autodetectBranch(runsRoot: string, slug: string): string | undefined {
  if (!existsSync(runsRoot)) return undefined;

  // Prefer directories with state.json; fall back to plan.json/prd.json.
  const primary = findSlugBranch(runsRoot, slug, 'state.json');
  if (primary) return primary;
  const planFallback = findSlugBranch(runsRoot, slug, 'plan.json');
  if (planFallback) return planFallback;
  return findSlugBranch(runsRoot, slug, 'prd.json');
}

function findSlugBranch(runsRoot: string, slug: string, marker: string): string | undefined {
  // Enumerate immediate children of runsRoot — Python uses glob(f"*/{slug}/{marker}");
  // mirror that with readdir + existsSync.
  let children: string[];
  try {
    children = readdirSyncSafe(runsRoot);
  } catch {
    return undefined;
  }
  for (const name of children) {
    const candidate = join(runsRoot, name, slug, marker);
    if (existsSync(candidate)) return name;
  }
  return undefined;
}

function readdirSyncSafe(path: string): string[] {
  return readdirSync(path);
}
