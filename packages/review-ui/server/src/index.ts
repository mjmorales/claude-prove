import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { materializeEmbeddedWebRoot } from "./embedded-assets.js";
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
 * Locate web assets baked into the compiled binary. Returns the on-disk cache
 * dir the embedded bundle was materialized into (see `embedded-assets.ts`), or
 * null when not running from a compiled binary — in which case `resolveWebRoot`
 * falls through to the plugin-dir / WEB_ROOT tiers.
 *
 * The default `materializeEmbeddedWebRoot`; the parameter is an injectable seam
 * so tests can drive the tier ordering without an actual compiled binary.
 */
export type EmbeddedWebRootAccessor = () => string | null;

/**
 * Locate the prebuilt web bundle in three-tier precedence order:
 *   1. Embedded assets baked into the binary (`embeddedAccessor`).
 *   2. The plugin-dir bundle at `<CLAUDE_PROVE_PLUGIN_DIR>/packages/review-ui/web/dist`,
 *      the layout a plugin install ships.
 *   3. `WEB_ROOT` env override for non-standard layouts (e.g. local dev).
 *
 * Returns null when no tier resolves to an existing directory, leaving the
 * server to run API-only.
 *
 * Intentionally does NOT walk up from the compiled module location: under a
 * binary or npx/Docker deploy that path is a cache, not the asset root.
 *
 * `embeddedAccessor` defaults to the real materializer; tests inject a stub to
 * exercise the embedded tier (which outranks WEB_ROOT) without a compiled binary.
 */
export function resolveWebRoot(
  embeddedAccessor: EmbeddedWebRootAccessor = () => materializeEmbeddedWebRoot(),
): string | null {
  const embedded = embeddedAccessor();
  if (embedded && fs.existsSync(embedded)) return embedded;

  const pluginDir = process.env.CLAUDE_PROVE_PLUGIN_DIR;
  if (pluginDir) {
    const p = path.resolve(pluginDir, "packages/review-ui/web/dist");
    if (fs.existsSync(p)) return p;
  }

  if (process.env.WEB_ROOT) {
    const p = path.resolve(process.env.WEB_ROOT);
    if (fs.existsSync(p)) return p;
  }

  return null;
}

interface AppOptions {
  repoRoot: string;
  webRoot: string | null;
}

/**
 * Build the configured Fastify instance WITHOUT listening — registers CORS,
 * every route module, the static/SPA-fallback handler, and `/api/health`.
 * Importable so the CLI can mount the same app in-process.
 */
export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const { repoRoot, webRoot } = opts;
  // Read the SPA shell once at build time so the async SPA-fallback handler
  // below doesn't block Fastify's event loop with `readFileSync` per 404.
  const indexHtml = webRoot
    ? fs.readFileSync(path.join(webRoot, "index.html"))
    : null;

  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
  // Restrict CORS to the same-origin SPA only. Reflecting all origins
  // (`origin: true`) would let any page the operator visits drive credentialed
  // cross-origin GETs against this loopback server, turning the git-executing
  // endpoints into a CSRF-reachable surface (no CSRF token, all reads are GET).
  await app.register(cors, {
    origin: [`http://${HOST}:${PORT}`, `http://localhost:${PORT}`],
  });

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
    // at build time — no sync FS work per 404.
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

  return app;
}

interface StartOptions {
  host: string;
  port: number;
  repoRoot: string;
  webRoot: string | null;
}

/**
 * Build and listen. Resolves once the socket is bound so callers (CLI or the
 * run-as-script path) can await readiness and inspect the bound coordinates.
 */
export async function startServer(
  opts: StartOptions,
): Promise<{ app: FastifyInstance; host: string; port: number }> {
  const { host, port, repoRoot, webRoot } = opts;
  const app = await buildApp({ repoRoot, webRoot });
  await app.listen({ port, host });
  app.log.info(`review-ui listening on http://${host}:${port}`);
  app.log.info(`repo root: ${repoRoot}`);
  if (webRoot) app.log.info(`web root:  ${webRoot}`);
  return { app, host, port };
}

/**
 * True when this module is the process entrypoint (`node dist/index.js` /
 * `tsx src/index.ts`), false when imported. Compares the resolved module path
 * against argv[1] so importing the module triggers no listen/exit side effect.
 */
function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  const repoRoot = await resolveRepoRoot();
  const webRoot = resolveWebRoot();
  try {
    await startServer({ host: HOST, port: PORT, repoRoot, webRoot });
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
