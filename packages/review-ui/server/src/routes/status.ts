import type { FastifyInstance } from "fastify";
import { workingDirStatus, resolveWorktreePath } from "../git.js";
import { readRunSummary } from "../runs.js";
import { parseRunKey } from "../parsers.js";

export function registerStatusRoutes(app: FastifyInstance, repoRoot: string) {
  app.get<{ Params: { slug: string } }>("/api/runs/:slug/status", async (req, reply) => {
    const key = parseRunKey(req.params.slug);
    if (!key) return reply.code(400).send({ error: "bad slug" });
    const summary = await readRunSummary(repoRoot, key.branch, key.slug);
    if (!summary) return reply.code(404).send({ error: "run not found" });
    const wt = await resolveWorktreePath(repoRoot, summary.worktree);
    if (!wt) return { slug: key.composite, worktree: null, status: null };
    const status = await workingDirStatus(wt);
    return { slug: key.composite, worktree: wt, status };
  });
}
