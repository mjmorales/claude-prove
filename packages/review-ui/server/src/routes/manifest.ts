import type { FastifyInstance } from "fastify";
import {
  branchesForRun,
  diffFiles,
  resolveWorktreePath,
  workingDirDiff,
  type FileChange,
} from "../git.js";
import { readRunSummary } from "../runs.js";
import { parseRunKey } from "../parsers.js";

export type ManifestGroup = {
  id: string;
  kind: "orch-committed" | "orch-pending" | "task-committed" | "task-pending";
  label: string;
  branch: string;
  base: string | null; // null for pending groups
  head: string | null; // null for pending groups
  cwd: string | null;
  pending: boolean;
  insertions: number;
  deletions: number;
  files: FileChange[];
};

export function registerManifestRoute(app: FastifyInstance, repoRoot: string) {
  app.get<{ Params: { slug: string } }>("/api/runs/:slug/manifest", async (req, reply) => {
    const key = parseRunKey(req.params.slug);
    if (!key) return reply.code(400).send({ error: "bad slug" });
    const summary = await readRunSummary(repoRoot, key.branch, key.slug);
    if (!summary) return reply.code(404).send({ error: "run not found" });

    const base = (summary.baseline ?? "main").split("@")[0].trim() || "main";
    const branches = await branchesForRun(repoRoot, key.slug);
    const orch = branches.find((b) => b.name === summary.orchestratorBranch);
    if (!orch) return { slug: key.composite, base, groups: [] as ManifestGroup[] };

    const groups: ManifestGroup[] = [];

    // 1. Orchestrator committed diff (base..orchestrator)
    const orchCwd = orch.worktreePath ?? (await resolveWorktreePath(repoRoot, summary.worktree));
    const orchFiles = await safeDiffFiles(repoRoot, base, orch.name, orchCwd ?? undefined);
    groups.push({
      id: "orch-committed",
      kind: "orch-committed",
      label: "ORCHESTRATOR · COMMITTED",
      branch: orch.name,
      base,
      head: orch.name,
      cwd: orchCwd ?? null,
      pending: false,
      insertions: sum(orchFiles, "insertions"),
      deletions: sum(orchFiles, "deletions"),
      files: orchFiles,
    });

    // 2. Orchestrator pending (uncommitted in orch worktree)
    if (orchCwd) {
      const pendingPatch = await workingDirDiff(orchCwd).catch(() => "");
      const pendingFiles = extractFilesFromPatch(pendingPatch);
      if (pendingFiles.length > 0) {
        groups.push({
          id: "orch-pending",
          kind: "orch-pending",
          label: "ORCHESTRATOR · PENDING",
          branch: orch.name,
          base: null,
          head: null,
          cwd: orchCwd,
          pending: true,
          insertions: sum(pendingFiles, "insertions"),
          deletions: sum(pendingFiles, "deletions"),
          files: pendingFiles,
        });
      }
    }

    // 3. Each sub-agent task branch
    const agents = branches.filter((b) => b.name !== orch.name);
    for (const agent of agents) {
      const taskId = extractTaskId(agent.name, key.slug);
      const label = taskId ? `TASK ${taskId}` : agent.name;

      const agentCwd = agent.worktreePath ?? undefined;
      const agentFiles = await safeDiffFiles(repoRoot, base, agent.name, agentCwd);
      if (agentFiles.length > 0) {
        groups.push({
          id: `task-committed:${agent.name}`,
          kind: "task-committed",
          label: `${label} · COMMITTED`,
          branch: agent.name,
          base,
          head: agent.name,
          cwd: agentCwd ?? null,
          pending: false,
          insertions: sum(agentFiles, "insertions"),
          deletions: sum(agentFiles, "deletions"),
          files: agentFiles,
        });
      }

      if (agentCwd) {
        const pendingPatch = await workingDirDiff(agentCwd).catch(() => "");
        const pendingFiles = extractFilesFromPatch(pendingPatch);
        if (pendingFiles.length > 0) {
          groups.push({
            id: `task-pending:${agent.name}`,
            kind: "task-pending",
            label: `${label} · PENDING`,
            branch: agent.name,
            base: null,
            head: null,
            cwd: agentCwd,
            pending: true,
            insertions: sum(pendingFiles, "insertions"),
            deletions: sum(pendingFiles, "deletions"),
            files: pendingFiles,
          });
        }
      }
    }

    return { slug: key.composite, base, groups };
  });
}

async function safeDiffFiles(
  repoRoot: string,
  base: string,
  head: string,
  cwd?: string,
): Promise<FileChange[]> {
  try {
    return await diffFiles(repoRoot, base, head, cwd);
  } catch {
    return [];
  }
}

function sum(files: FileChange[], key: "insertions" | "deletions"): number {
  let n = 0;
  for (const f of files) n += f[key];
  return n;
}

function extractTaskId(branch: string, slug: string): string | null {
  const prefix = `task/${slug}/`;
  if (branch.startsWith(prefix)) return branch.slice(prefix.length);
  return null;
}

function extractFilesFromPatch(patch: string): FileChange[] {
  if (!patch.trim()) return [];
  const files: FileChange[] = [];
  const blocks = patch.split(/^diff --git /m).filter((b) => b.trim());
  for (const block of blocks) {
    const chunk = "diff --git " + block;
    const lines = chunk.split("\n");
    let oldPath: string | null = null;
    let newPath: string | null = null;
    let isBinary = false;
    let ins = 0;
    let del = 0;
    for (const ln of lines) {
      if (ln.startsWith("--- ")) oldPath = stripPathPrefix(ln.slice(4));
      else if (ln.startsWith("+++ ")) newPath = stripPathPrefix(ln.slice(4));
      else if (ln.startsWith("Binary files")) isBinary = true;
      else if (ln.startsWith("+") && !ln.startsWith("+++")) ins++;
      else if (ln.startsWith("-") && !ln.startsWith("---")) del++;
    }
    const filePath = newPath && newPath !== "/dev/null" ? newPath : oldPath;
    if (!filePath) continue;
    const status = isBinary
      ? "M"
      : oldPath === "/dev/null"
        ? "A"
        : newPath === "/dev/null"
          ? "D"
          : "M";
    files.push({ path: filePath, status, insertions: ins, deletions: del, binary: isBinary });
  }
  return files;
}

function stripPathPrefix(p: string): string {
  const t = p.trim();
  if (t === "/dev/null") return t;
  return t.replace(/^a\//, "").replace(/^b\//, "");
}
