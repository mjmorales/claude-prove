import type { FastifyInstance, FastifyReply } from "fastify";
import chokidar from "chokidar";
import path from "node:path";

export function registerEventsRoute(app: FastifyInstance, repoRoot: string) {
  app.get("/api/events", async (_req, reply) => {
    const res = reply.raw;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(`: connected\n\n`);

    const watchPaths = [
      path.join(repoRoot, ".prove/runs"),
      path.join(repoRoot, ".git/refs"),
      path.join(repoRoot, ".git/HEAD"),
      path.join(repoRoot, ".git/worktrees"),
    ];

    const watcher = chokidar.watch(watchPaths, {
      ignoreInitial: true,
      ignored: (p: string) => p.includes("/node_modules/") || p.endsWith(".lock"),
      persistent: true,
    });

    const sendEvent = (kind: string, file: string) => {
      const rel = path.relative(repoRoot, file);
      res.write(`event: change\ndata: ${JSON.stringify({ kind, path: rel })}\n\n`);
    };

    watcher.on("add", (f: string) => sendEvent("add", f));
    watcher.on("change", (f: string) => sendEvent("change", f));
    watcher.on("unlink", (f: string) => sendEvent("unlink", f));

    const heartbeat = setInterval(() => res.write(`: hb\n\n`), 15000);

    const close = () => {
      clearInterval(heartbeat);
      watcher.close();
    };
    (reply as unknown as { raw: { on: (e: string, cb: () => void) => void } }).raw.on("close", close);

    // Keep handler open.
    return new Promise<void>(() => {});
  });
}
