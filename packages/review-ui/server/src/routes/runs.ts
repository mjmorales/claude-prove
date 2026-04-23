import type { FastifyInstance } from "fastify";
import fs from "node:fs/promises";
import path from "node:path";
import { listRuns, readRunSummary } from "../runs.js";
import { parseRunKey, runDir } from "../parsers.js";

export function registerRunRoutes(app: FastifyInstance, repoRoot: string) {
  app.get("/api/runs", async () => ({ runs: await listRuns(repoRoot) }));

  // :slug is the composite key `<branch>/<slug>` URL-encoded by the client.
  // Fastify decodes the path param, so we receive the literal `branch/slug`.
  app.get<{ Params: { slug: string } }>("/api/runs/:slug", async (req, reply) => {
    const key = parseRunKey(req.params.slug);
    if (!key) return reply.code(400).send({ error: "bad slug — expected <branch>/<slug>" });
    const summary = await readRunSummary(repoRoot, key.branch, key.slug);
    if (!summary) return reply.code(404).send({ error: "run not found" });
    return summary;
  });

  // Serve raw JSON artifacts. The allowlist covers the files prove v0.34.2
  // actually writes under .prove/runs/<branch>/<slug>/; reports/<step>.json
  // is served via a dedicated route.
  app.get<{ Params: { slug: string; file: string } }>(
    "/api/runs/:slug/doc/:file",
    async (req, reply) => {
      const key = parseRunKey(req.params.slug);
      if (!key) return reply.code(400).send({ error: "bad slug" });
      const { file } = req.params;
      const allowed = new Set(["plan.json", "prd.json", "state.json"]);
      if (!allowed.has(file)) return reply.code(400).send({ error: "bad file" });
      const p = path.join(runDir(repoRoot, key.branch, key.slug), file);
      const content = await fs.readFile(p, "utf8").catch(() => null);
      if (content === null) return reply.code(404).send({ error: "not found" });
      return { path: p, content };
    },
  );

  app.get<{ Params: { slug: string; stepId: string } }>(
    "/api/runs/:slug/reports/:stepId",
    async (req, reply) => {
      const key = parseRunKey(req.params.slug);
      if (!key) return reply.code(400).send({ error: "bad slug" });
      const { stepId } = req.params;
      if (!/^[\w.\-]+$/.test(stepId)) return reply.code(400).send({ error: "bad step id" });
      const p = path.join(runDir(repoRoot, key.branch, key.slug), "reports", `${stepId}.json`);
      const content = await fs.readFile(p, "utf8").catch(() => null);
      if (content === null) return reply.code(404).send({ error: "not found" });
      return { path: p, content };
    },
  );
}
