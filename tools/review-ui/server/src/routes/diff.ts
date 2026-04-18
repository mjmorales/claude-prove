import type { FastifyInstance } from "fastify";
import {
  diffFiles,
  diffUnified,
  workingDirDiff,
  resolveWorktreePath,
  branchesForRun,
  listWorktrees,
} from "../git.js";
import { readRunSummary } from "../runs.js";
import { parseRunKey } from "../parsers.js";

type DiffQuery = { base?: string; head?: string; slug?: string; branch?: string; pending?: string };
type FileQuery = DiffQuery & { path?: string };

export function registerDiffRoutes(app: FastifyInstance, repoRoot: string) {
  // Summary: files changed between base...head, optionally from a worktree cwd.
  app.get<{ Querystring: DiffQuery }>("/api/diff", async (req, reply) => {
    const base = req.query.base;
    const head = req.query.head;
    if (!base || !head) return reply.code(400).send({ error: "base and head required" });
    const cwd = await resolveCwdForBranch(repoRoot, req.query.slug, head);
    try {
      const files = await diffFiles(repoRoot, base, head, cwd);
      return { base, head, files };
    } catch (err) {
      return reply.code(400).send({ error: "unknown ref", detail: sanitizeGitError(err) });
    }
  });

  // Unified diff for a single file.
  app.get<{ Querystring: FileQuery }>("/api/diff/file", async (req, reply) => {
    const { base, head, path: filePath } = req.query;
    if (!base || !head || !filePath) {
      return reply.code(400).send({ error: "base, head, path required" });
    }
    const cwd = await resolveCwdForBranch(repoRoot, req.query.slug, head);
    try {
      const patch = await diffUnified(repoRoot, base, head, filePath, cwd);
      return { base, head, path: filePath, patch };
    } catch (err) {
      return reply.code(400).send({ error: "unknown ref", detail: sanitizeGitError(err) });
    }
  });

  // Pending (uncommitted) diff inside an active worktree. Defaults to the
  // orchestrator worktree; pass `branch` to target a sub-agent's worktree.
  app.get<{ Querystring: { slug?: string; path?: string; branch?: string } }>(
    "/api/diff/pending",
    async (req, reply) => {
      const { slug, path: filePath, branch } = req.query;
      if (!slug) return reply.code(400).send({ error: "slug required" });
      const key = parseRunKey(slug);
      if (!key) return reply.code(400).send({ error: "bad slug" });
      const summary = await readRunSummary(repoRoot, key.branch, key.slug);
      if (!summary) return reply.code(404).send({ error: "run not found" });

      let wt: string | null = null;
      if (branch && branch !== summary.orchestratorBranch) {
        const live = await listWorktrees(repoRoot);
        wt = live.find((w) => w.branch === branch)?.path ?? null;
      }
      if (!wt) wt = await resolveWorktreePath(repoRoot, summary.worktree);
      if (!wt) return { slug: key.composite, worktree: null, patch: "" };

      const patch = await workingDirDiff(wt, filePath);
      return {
        slug: key.composite,
        worktree: wt,
        branch: branch ?? summary.orchestratorBranch,
        path: filePath ?? null,
        patch,
      };
    },
  );
}

async function resolveCwdForBranch(
  repoRoot: string,
  compositeSlug: string | undefined,
  branch: string,
): Promise<string | undefined> {
  if (!compositeSlug) return undefined;
  const key = parseRunKey(compositeSlug);
  if (!key) return undefined;
  const branches = await branchesForRun(repoRoot, key.slug);
  const match = branches.find((b) => b.name === branch);
  return match?.worktreePath ?? undefined;
}

function sanitizeGitError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const line = msg.split("\n").find((l) => l.startsWith("fatal:")) ?? msg.split("\n")[0];
  return line.slice(0, 200);
}
