import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { resolveRepoRoot } from "./repo.js";
import { registerRunRoutes } from "./routes/runs.js";
import { registerBranchRoutes } from "./routes/branches.js";
import { registerDiffRoutes } from "./routes/diff.js";
import { registerStatusRoutes } from "./routes/status.js";
import { registerEventsRoute } from "./routes/events.js";
import { registerProveRoutes } from "./routes/prove.js";
import { registerManifestRoute } from "./routes/manifest.js";
import { registerReviewRoutes } from "./routes/review.js";
import { registerScrumRoutes } from "./scrum.js";

const PORT = Number(process.env.PORT ?? 5174);
const HOST = process.env.HOST ?? "127.0.0.1";

/**
 * Locate the prebuilt web bundle. The server is typically deployed as:
 *   <package-root>/
 *     server/dist/index.js   <- this file
 *     web/dist/
 * so we walk up two directories from the compiled module.
 *
 * `WEB_ROOT` env overrides for non-standard layouts (e.g. local dev).
 */
function resolveWebRoot(): string | null {
  if (process.env.WEB_ROOT) {
    const p = path.resolve(process.env.WEB_ROOT);
    return fs.existsSync(p) ? p : null;
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../../web/dist"),
    path.resolve(here, "../web/dist"),
  ];
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

async function main() {
  const repoRoot = await resolveRepoRoot();
  const webRoot = resolveWebRoot();
  // Read the SPA shell once at startup so the async SPA-fallback handler
  // below doesn't block Fastify's event loop with `readFileSync` per 404.
  const indexHtml = webRoot
    ? fs.readFileSync(path.join(webRoot, "index.html"))
    : null;

  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
  await app.register(cors, { origin: true });

  app.get("/api/health", async () => ({ ok: true, repoRoot, webRoot }));

  registerRunRoutes(app, repoRoot);
  registerBranchRoutes(app, repoRoot);
  registerDiffRoutes(app, repoRoot);
  registerStatusRoutes(app, repoRoot);
  registerEventsRoute(app, repoRoot);
  registerProveRoutes(app, repoRoot);
  registerManifestRoute(app, repoRoot);
  registerReviewRoutes(app, repoRoot);
  registerScrumRoutes(app, repoRoot);

  if (webRoot) {
    await app.register(fastifyStatic, {
      root: webRoot,
      prefix: "/",
      index: ["index.html"],
      wildcard: false,
    });
    // SPA fallback: any non-API route falls through to index.html so client-side
    // routing works on deep links and refreshes. Uses the cached buffer read
    // at startup — no sync FS work per 404.
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) {
        reply.code(404).send({ error: "not_found" });
        return;
      }
      reply.type("text/html").send(indexHtml);
    });
  } else {
    app.log.warn("web bundle not found — running API-only. Set WEB_ROOT or build web/dist.");
  }

  await app.listen({ port: PORT, host: HOST });
  app.log.info(`review-ui listening on http://${HOST}:${PORT}`);
  app.log.info(`repo root: ${repoRoot}`);
  if (webRoot) app.log.info(`web root:  ${webRoot}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
