import type { FastifyInstance } from "fastify";
import {
  branchesForRun,
  gitAt,
  listAllBranches,
  listWorktrees,
  resolveBaselineBranch,
  sharesOrchestratorHistory,
} from "../git.js";
import { parseRunKey } from "../parsers.js";

export function registerBranchRoutes(app: FastifyInstance, repoRoot: string) {
  app.get("/api/branches", async () => ({ branches: await listAllBranches(repoRoot) }));
  app.get("/api/worktrees", async () => ({ worktrees: await listWorktrees(repoRoot) }));

  app.get<{ Params: { slug: string } }>("/api/runs/:slug/branches", async (req, reply) => {
    const key = parseRunKey(req.params.slug);
    if (!key) return reply.code(400).send({ error: "bad slug" });
    const all = await listAllBranches(repoRoot);
    const attached = await branchesForRun(repoRoot, key.slug);
    const attachedNames = new Set(attached.map((b) => b.name));
    const orchestratorName = `orchestrator/${key.slug}`;
    const hasOrchestrator = all.some((b) => b.name === orchestratorName);

    // Candidates: worktree-agent-* or cross-slug task/ branches we didn't already
    // attach. A branch is an orphan of *this* run only when it shares history
    // with this orchestrator branch; otherwise it belongs to some other run.
    const candidates = all.filter(
      (b) =>
        !attachedNames.has(b.name) &&
        b.name !== orchestratorName &&
        (b.name.startsWith("worktree-agent-") ||
          (b.name.startsWith("task/") && !b.name.startsWith(`task/${key.slug}/`))),
    );
    const git = gitAt(repoRoot);
    const baseline = await resolveBaselineBranch(repoRoot);
    const orphanAgents = hasOrchestrator
      ? (
          await Promise.all(
            candidates.map(async (b) =>
              (await sharesOrchestratorHistory(git, b.name, orchestratorName, baseline)) ? b : null,
            ),
          )
        ).filter((b): b is (typeof candidates)[number] => b !== null)
      : [];
    return {
      orchestratorName,
      hasOrchestrator,
      branches: attached,
      orphanAgents,
    };
  });
}
