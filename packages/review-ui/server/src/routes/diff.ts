import path from "node:path";
import type { FastifyInstance } from "fastify";
import {
  diffFiles,
  diffUnified,
  workingDirDiff,
  resolveWorktreePath,
  listWorktrees,
} from "../git.js";
import { readRunSummary } from "../runs.js";
import { parseRunKey } from "../parsers.js";

type DiffQuery = { base?: string; head?: string; slug?: string; branch?: string; pending?: string };
type FileQuery = DiffQuery & { path?: string };

// Conservative git-ref allowlist. `base`/`head` are concatenated into a single
// `base...head` argv token and handed to `git` via spawn (no shell), so the
// risk is argument injection, not shell injection: a value beginning with `-`
// is interpreted as a git flag (e.g. `--output=...`). Reject anything outside
// the allowlist or with a leading dash before it reaches git.
const GIT_REF = /^[A-Za-z0-9_./@^~-]+$/;

function isBadRef(ref: string): boolean {
  return !GIT_REF.test(ref) || ref.startsWith("-");
}

// Relative-path guard for the `path` query param. Reject absolute paths,
// leading-dash flags, and anything normalizing outside the tree. Committed
// diffs already terminate option parsing with `--` and bound traversal via git
// pathspec; for working-dir reads `synthAddPatch` additionally relies on the
// porcelain-equality gate (git.ts) as a second line of defense.
function isBadPath(p: string): boolean {
  return path.isAbsolute(p) || p.startsWith("-") || path.normalize(p).split(path.sep)[0] === "..";
}

export function registerDiffRoutes(app: FastifyInstance, repoRoot: string) {
  // Summary: files changed between base...head, optionally from a worktree cwd.
  app.get<{ Querystring: DiffQuery }>("/api/diff", async (req, reply) => {
    const base = req.query.base;
    const head = req.query.head;
    if (!base || !head) return reply.code(400).send({ error: "base and head required" });
    if (isBadRef(base) || isBadRef(head)) return reply.code(400).send({ error: "bad ref" });
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
    if (isBadRef(base) || isBadRef(head)) return reply.code(400).send({ error: "bad ref" });
    if (isBadPath(filePath)) return reply.code(400).send({ error: "bad path" });
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
      if (filePath && isBadPath(filePath)) return reply.code(400).send({ error: "bad path" });
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

/**
 * Committed diffs resolve refs just fine from the main repoRoot — running
 * them from a worktree is a micro-optimization we can't afford because
 * bind-mounted worktree metadata often contains stale host paths
 * (`fatal: not a git repository`). Always use repoRoot for committed
 * diffs; keep worktree cwd for pending/working-dir diffs only.
 */
async function resolveCwdForBranch(
  _repoRoot: string,
  _compositeSlug: string | undefined,
  _branch: string,
): Promise<string | undefined> {
  return undefined;
}

function sanitizeGitError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const line = msg.split("\n").find((l) => l.startsWith("fatal:")) ?? msg.split("\n")[0];
  return line.slice(0, 200);
}
