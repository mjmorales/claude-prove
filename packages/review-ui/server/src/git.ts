import { simpleGit, SimpleGit } from "simple-git";
import path from "node:path";
import fs from "node:fs/promises";
import fsSync from "node:fs";

export type BranchRef = {
  name: string;
  sha: string;
  isCurrent: boolean;
  isWorktree: boolean;
  worktreePath: string | null;
  upstream: string | null;
};

export type FileChange = {
  path: string;
  status: string;
  insertions: number;
  deletions: number;
  binary: boolean;
};

export type StatusSummary = {
  branch: string | null;
  ahead: number;
  behind: number;
  files: Array<{ path: string; index: string; workingDir: string }>;
  staged: string[];
  modified: string[];
  untracked: string[];
};

export function gitAt(cwd: string): SimpleGit {
  return simpleGit({ baseDir: cwd });
}

/**
 * Resolve the repo's default/baseline branch (the branch `origin/HEAD` points
 * at). Falls back to `"main"` when the symbolic ref is missing — which happens
 * for freshly cloned bare mirrors or when `git remote set-head` has never run.
 *
 * Memoized per repoRoot for the server process lifetime: the default branch
 * doesn't change between orchestrator runs, and the git invocation is cheap
 * but called on every /api/runs request.
 */
const baselineCache = new Map<string, string>();
export async function resolveBaselineBranch(repoRoot: string): Promise<string> {
  const cached = baselineCache.get(repoRoot);
  if (cached) return cached;
  let baseline = "main";
  try {
    const raw = await gitAt(repoRoot).raw(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    const name = raw.trim().replace(/^origin\//, "");
    if (name) baseline = name;
  } catch {
    /* fall back to "main" */
  }
  baselineCache.set(repoRoot, baseline);
  return baseline;
}

export async function listAllBranches(repoRoot: string): Promise<BranchRef[]> {
  const git = gitAt(repoRoot);
  const [raw, worktrees, currentRaw] = await Promise.all([
    git.raw(["for-each-ref", "--format=%(refname:short)%09%(objectname:short)", "refs/heads"]),
    listWorktrees(repoRoot),
    git.raw(["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => ""),
  ]);
  const current = currentRaw.trim();
  const wtByBranch = new Map<string, string>();
  for (const wt of worktrees) {
    if (wt.branch) wtByBranch.set(wt.branch, wt.path);
  }

  const refs: BranchRef[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const [name, sha] = line.split("\t");
    refs.push({
      name,
      sha,
      isCurrent: name === current,
      isWorktree: wtByBranch.has(name),
      worktreePath: wtByBranch.get(name) ?? null,
      upstream: null,
    });
  }
  refs.sort((a, b) => a.name.localeCompare(b.name));
  return refs;
}

type Worktree = { path: string; branch: string | null; head: string };

export async function listWorktrees(repoRoot: string): Promise<Worktree[]> {
  const git = gitAt(repoRoot);
  const raw = await git.raw(["worktree", "list", "--porcelain"]);
  const out: Worktree[] = [];
  let cur: Partial<Worktree> = {};
  for (const line of raw.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (cur.path) out.push({ path: cur.path, branch: cur.branch ?? null, head: cur.head ?? "" });
      cur = { path: line.slice("worktree ".length).trim() };
    } else if (line.startsWith("HEAD ")) {
      cur.head = line.slice("HEAD ".length).trim();
    } else if (line.startsWith("branch ")) {
      cur.branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
    } else if (line === "detached") {
      cur.branch = null;
    }
  }
  if (cur.path) out.push({ path: cur.path, branch: cur.branch ?? null, head: cur.head ?? "" });
  return out.map((w) => ({ ...w, path: remapWorktreePath(w.path, repoRoot) }));
}

/**
 * Rebase a worktree path onto the current `repoRoot`.
 *
 * Worktree metadata (`.git/worktrees/<name>/gitdir`) stores the absolute path
 * that was used when the worktree was created. When this server runs inside a
 * container (or on a different host) that records a bind-mounted repo, the
 * recorded path doesn't exist in the current filesystem. Any operation that
 * cd's into it (diff, status, intent-commit walks) will silently fail.
 *
 * Strategy:
 *   - If the recorded path already exists, keep it.
 *   - Else, look for the `.claude/worktrees/<tail>` suffix and rebase onto
 *     `<repoRoot>/.claude/worktrees/<tail>` when that exists. This matches the
 *     prove convention for orchestrator + task worktrees.
 *   - Otherwise return the original path so downstream code can fail loudly
 *     rather than silently masking a real misconfiguration.
 */
function remapWorktreePath(p: string, repoRoot: string): string {
  try {
    if (fsSync.existsSync(p)) return p;
  } catch {
    /* ignore */
  }
  const m = p.match(/\/\.claude\/worktrees\/(.+)$/);
  if (m) {
    const candidate = path.join(repoRoot, ".claude", "worktrees", m[1]);
    try {
      if (fsSync.existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return p;
}

export async function branchesForRun(repoRoot: string, slug: string): Promise<BranchRef[]> {
  const all = await listAllBranches(repoRoot);
  const orchestratorName = `orchestrator/${slug}`;
  const orch = all.find((b) => b.name === orchestratorName) ?? null;
  const ordered: BranchRef[] = [];
  if (!orch) return ordered;
  ordered.push(orch);

  // Sub-agent branches: prove names them `task/<slug>/<task-id>` (current convention)
  // or the legacy `worktree-agent-*` pattern. Plus task worktrees sit under
  // `.claude/worktrees/<slug>-task-*` — include any branch checked out there.
  const taskPrefix = `task/${slug}/`;
  const byName = new Map(all.map((b) => [b.name, b]));
  const attached = new Map<string, BranchRef>();

  for (const b of all) {
    if (b.name.startsWith(taskPrefix)) attached.set(b.name, b);
  }

  // Worktrees rooted under .claude/worktrees/<slug>-*, regardless of branch name.
  const wts = await listWorktrees(repoRoot);
  const wtSegment = `/.claude/worktrees/${slug}-`;
  for (const w of wts) {
    if (!w.branch || !w.path.includes(wtSegment)) continue;
    if (w.branch === orchestratorName) continue;
    const ref = byName.get(w.branch);
    if (ref) attached.set(w.branch, ref);
  }

  // Legacy fallback: worktree-agent-* that shares orchestrator-exclusive history.
  const git = gitAt(repoRoot);
  const baseline = await resolveBaselineBranch(repoRoot);
  for (const b of all) {
    if (attached.has(b.name)) continue;
    if (!b.name.startsWith("worktree-agent-")) continue;
    if (await sharesOrchestratorHistory(git, b.name, orch.name, baseline)) attached.set(b.name, b);
  }

  // Order: task branches sorted by id, then legacy agents.
  const sorted = [...attached.values()].sort((a, b) => {
    const aTask = a.name.startsWith(taskPrefix);
    const bTask = b.name.startsWith(taskPrefix);
    if (aTask !== bTask) return aTask ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true });
  });
  ordered.push(...sorted);
  return ordered;
}

/**
 * An agent branch "shares orchestrator history" when its merge-base with the
 * orchestrator is strictly newer than its merge-base with the repo baseline
 * (typically `main`) — i.e. it diverged from orchestrator-exclusive commits,
 * not from the shared trunk.
 *
 * `baseline` defaults to `resolveBaselineBranch(gitAt-of-cwd)` when omitted so
 * non-`main`-default repos work correctly. Callers that already know the
 * baseline should pass it through to avoid the extra lookup.
 */
export async function sharesOrchestratorHistory(
  git: SimpleGit,
  agent: string,
  orch: string,
  baseline?: string,
): Promise<boolean> {
  const safe = async (args: string[]): Promise<string> => {
    try {
      return (await git.raw(args)).trim();
    } catch {
      return "";
    }
  };
  const mbOrch = await safe(["merge-base", agent, orch]);
  if (!mbOrch) return false;
  const baseRef = baseline ?? (await resolveBaselineBranch(await gitCwd(git)));
  const mbBase = await safe(["merge-base", agent, baseRef]);
  if (mbOrch === mbBase) return false;
  if (!mbBase) return true;
  const ancestor = await git
    .raw(["merge-base", "--is-ancestor", mbBase, mbOrch])
    .then(() => true)
    .catch(() => false);
  return ancestor;
}

/** Extract the working directory that a `SimpleGit` instance was opened
 *  against. `simple-git` exposes this via `revparse --show-toplevel`. */
async function gitCwd(git: SimpleGit): Promise<string> {
  try {
    return (await git.raw(["rev-parse", "--show-toplevel"])).trim();
  } catch {
    return "";
  }
}

export async function diffFiles(
  repoRoot: string,
  base: string,
  head: string,
  headCwd?: string
): Promise<FileChange[]> {
  const cwd = headCwd ?? repoRoot;
  const git = gitAt(cwd);
  const numstat = await git.raw(["diff", "--numstat", `${base}...${head}`]);
  const nameStatus = await git.raw(["diff", "--name-status", `${base}...${head}`]);

  const statusByPath = new Map<string, string>();
  for (const line of nameStatus.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const status = parts[0];
    const p = parts[parts.length - 1];
    statusByPath.set(p, status);
  }

  const files: FileChange[] = [];
  for (const line of numstat.split("\n")) {
    if (!line.trim()) continue;
    const [insRaw, delRaw, ...rest] = line.split("\t");
    const p = rest.join("\t");
    const binary = insRaw === "-" && delRaw === "-";
    files.push({
      path: p,
      status: statusByPath.get(p) ?? "M",
      insertions: binary ? 0 : Number(insRaw),
      deletions: binary ? 0 : Number(delRaw),
      binary,
    });
  }
  return files;
}

export async function diffUnified(
  repoRoot: string,
  base: string,
  head: string,
  filePath: string,
  headCwd?: string
): Promise<string> {
  const cwd = headCwd ?? repoRoot;
  const git = gitAt(cwd);
  return git.raw(["diff", `${base}...${head}`, "--", filePath]);
}

export async function workingDirDiff(
  worktreePath: string,
  filePath?: string,
): Promise<string> {
  const git = gitAt(worktreePath);
  // Tracked diff (modified + staged).
  const args = ["diff", "HEAD"];
  if (filePath) args.push("--", filePath);
  const tracked = await git.raw(args).catch(() => "");

  // Untracked files: git diff ignores them. Emit synthetic add-all patches.
  const status = await git.raw(["status", "--porcelain=v1", "-uall"]).catch(() => "");
  const untracked: string[] = [];
  for (const line of status.split("\n")) {
    if (line.startsWith("?? ")) {
      const p = line.slice(3).replace(/^"(.*)"$/, "$1");
      if (!filePath || p === filePath) untracked.push(p);
    }
  }
  let synthetic = "";
  for (const p of untracked) {
    synthetic += await synthAddPatch(worktreePath, p);
  }
  return tracked + (synthetic ? "\n" + synthetic : "");
}

async function synthAddPatch(worktreePath: string, relPath: string): Promise<string> {
  const fsMod = await import("node:fs/promises");
  const pathMod = await import("node:path");
  const abs = pathMod.join(worktreePath, relPath);
  let content: string;
  try {
    const buf = await fsMod.readFile(abs);
    // Crude binary heuristic: NUL byte in first 8k.
    const head = buf.subarray(0, Math.min(buf.length, 8192));
    if (head.includes(0)) {
      return `diff --git a/${relPath} b/${relPath}\nnew file\nBinary files /dev/null and b/${relPath} differ\n`;
    }
    content = buf.toString("utf8");
  } catch {
    return "";
  }
  const lines = content.split("\n");
  // git emits a final empty token for files ending in \n; drop it to match standard patches.
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const count = lines.length;
  const body = lines.map((l) => `+${l}`).join("\n");
  return (
    `diff --git a/${relPath} b/${relPath}\n` +
    `new file mode 100644\n` +
    `--- /dev/null\n` +
    `+++ b/${relPath}\n` +
    `@@ -0,0 +1,${count} @@\n` +
    (body ? body + "\n" : "")
  );
}

const EMPTY_STATUS: StatusSummary = {
  branch: null,
  ahead: 0,
  behind: 0,
  files: [],
  staged: [],
  modified: [],
  untracked: [],
};

export async function workingDirStatus(worktreePath: string): Promise<StatusSummary> {
  const git = gitAt(worktreePath);
  try {
    const s = await git.status();
    return {
      branch: s.current,
      ahead: s.ahead,
      behind: s.behind,
      files: s.files.map((f) => ({ path: f.path, index: f.index, workingDir: f.working_dir })),
      staged: s.staged,
      modified: s.modified,
      untracked: s.not_added,
    };
  } catch (err: unknown) {
    // Stale / broken worktree: the `.git` file inside the worktree points at
    // a host-only gitdir (common when the repo was bind-mounted into a
    // container after the worktree was created). Reporting "no pending
    // changes" is the right behaviour — the worktree isn't usable here.
    const msg = err instanceof Error ? err.message : String(err);
    if (/not a git repository|gitdir|no such file or directory/i.test(msg)) {
      return EMPTY_STATUS;
    }
    throw err;
  }
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function resolveWorktreePath(repoRoot: string, declared: string | null): Promise<string | null> {
  if (!declared) return null;
  const abs = path.isAbsolute(declared) ? declared : path.join(repoRoot, declared);
  return (await exists(abs)) ? abs : null;
}
