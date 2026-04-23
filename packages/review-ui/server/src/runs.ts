import fs from "node:fs/promises";
import path from "node:path";
import { listAllBranches, listWorktrees } from "./git.js";
import { listManifestsForSlug } from "./acb.js";
import {
  extractRunProgress,
  readJson,
  runDir,
  type PlanJson,
  type PrdJson,
  type RunProgress,
  type StateJson,
} from "./parsers.js";

export type RunSummary = {
  branch: string;
  slug: string;
  composite: string;
  orchestratorBranch: string;
  baseline: string | null;
  worktree: string | null;
  hasPlan: boolean;
  hasPrd: boolean;
  hasState: boolean;
  mode: "simple" | "full" | null;
  title: string | null;
  progress: RunProgress;
  /** ISO timestamp of the most recent file activity inside the run dir. */
  lastActivity: string | null;
};

const RUNS_DIR = ".prove/runs";

export async function listRuns(repoRoot: string): Promise<RunSummary[]> {
  const root = path.join(repoRoot, RUNS_DIR);
  const branches = await listSubdirs(root);

  const [allBranches, worktrees] = await Promise.all([
    listAllBranches(repoRoot).catch(() => []),
    listWorktrees(repoRoot).catch(() => []),
  ]);
  const branchNames = new Set(allBranches.map((b) => b.name));
  const worktreeBranches = new Set(
    worktrees.map((w) => w.branch).filter((b): b is string => Boolean(b)),
  );

  const out: RunSummary[] = [];
  for (const branchNs of branches) {
    const branchDir = path.join(root, branchNs);
    const slugs = await listSubdirs(branchDir);
    for (const slug of slugs) {
      const runPath = path.join(branchDir, slug);
      const stateExists = await fileExists(path.join(runPath, "state.json"));
      if (!stateExists) continue;

      // Surface the run if either the orchestrator branch is live OR its
      // manifests are still in the ACB store. Post-merge / post-cleanup
      // runs stay reviewable as long as their manifests survive.
      const orchName = `orchestrator/${slug}`;
      const live = branchNames.has(orchName) || worktreeBranches.has(orchName);
      const hasManifests = live || slugHasManifests(repoRoot, slug);
      if (!live && !hasManifests) continue;

      const summary = await readRunSummary(repoRoot, branchNs, slug);
      if (summary) out.push(summary);
    }
  }

  out.sort((a, b) => {
    const at = a.lastActivity ?? "";
    const bt = b.lastActivity ?? "";
    if (at !== bt) return bt.localeCompare(at);
    return a.composite.localeCompare(b.composite);
  });
  return out;
}

export async function readRunSummary(
  repoRoot: string,
  branch: string,
  slug: string,
): Promise<RunSummary | null> {
  const dir = runDir(repoRoot, branch, slug);
  const planPath = path.join(dir, "plan.json");
  const prdPath = path.join(dir, "prd.json");
  const statePath = path.join(dir, "state.json");

  const [plan, prd, state, mtime] = await Promise.all([
    readJson<PlanJson>(planPath),
    readJson<PrdJson>(prdPath),
    readJson<StateJson>(statePath),
    latestMtime(dir),
  ]);

  const hasPlan = plan !== null;
  const hasPrd = prd !== null;
  const hasState = state !== null;
  const orchestratorBranch = `orchestrator/${slug}`;

  // plan.json does not carry a baseline field today. Default to "main"; UI
  // diff views use git merge-base against the orch branch when needed.
  const baseline: string | null = "main";

  // Worktree path: live git worktree wins over any declared path.
  let worktree: string | null = null;
  const wts = await listWorktrees(repoRoot).catch(() => []);
  const match = wts.find((w) => w.branch === orchestratorBranch);
  if (match) worktree = match.path;

  const branches = await listAllBranches(repoRoot).catch(() => []);
  const branchExists = branches.some((b) => b.name === orchestratorBranch);
  const hasEvidence = hasPlan || hasPrd || hasState || worktree !== null || branchExists;
  if (!hasEvidence) return null;

  return {
    branch,
    slug,
    composite: `${branch}/${slug}`,
    orchestratorBranch,
    baseline,
    worktree,
    hasPlan,
    hasPrd,
    hasState,
    mode: plan?.mode ?? null,
    title: prd?.title ?? null,
    progress: extractRunProgress(state),
    lastActivity: mtime ? mtime.toISOString() : null,
  };
}

/**
 * Cheap existence check against the ACB store: does this run slug have any
 * committed manifests? Used to keep merged/cleaned runs reviewable after
 * their git branches are gone.
 */
function slugHasManifests(repoRoot: string, slug: string): boolean {
  try {
    return listManifestsForSlug(repoRoot, slug).length > 0;
  } catch {
    return false;
  }
}

async function listSubdirs(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const st = await fs.stat(path.join(dir, name)).catch(() => null);
    if (st?.isDirectory()) out.push(name);
  }
  return out;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    return st.isFile();
  } catch {
    return false;
  }
}

async function latestMtime(dir: string): Promise<Date | null> {
  let latest: Date | null = null;
  async function walk(d: string): Promise<void> {
    let entries: string[] = [];
    try {
      entries = await fs.readdir(d);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = path.join(d, name);
      const st = await fs.stat(full).catch(() => null);
      if (!st) continue;
      if (st.isDirectory()) {
        await walk(full);
      } else if (!latest || st.mtime > latest) {
        latest = st.mtime;
      }
    }
  }
  await walk(dir);
  if (!latest) {
    const st = await fs.stat(dir).catch(() => null);
    if (st) latest = st.mtime;
  }
  return latest;
}
