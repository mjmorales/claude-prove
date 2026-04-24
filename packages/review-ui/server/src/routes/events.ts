import type { FastifyInstance, FastifyReply } from "fastify";
import type { FSWatcher } from "chokidar";
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

    // Resource-cleanup handshake:
    //   - `closed` guards against double-cleanup (some clients hang up mid-setup;
    //     `close` then fires before/while watcher+heartbeat are initialized).
    //   - `cleanup` tolerates partially-initialized state by null-checking each
    //     handle before releasing it.
    let closed = false;
    let watcher: FSWatcher | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;

    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      if (watcher) void watcher.close();
    };

    // Attach the close listener first so a premature disconnect still hits
    // `cleanup` and turns subsequent setup into a no-op via `closed`.
    (reply as unknown as { raw: { on: (e: string, cb: () => void) => void } }).raw.on(
      "close",
      cleanup,
    );

    const sendEvent = (kind: string, file: string) => {
      if (closed) return;
      const rel = path.relative(repoRoot, file);
      res.write(`event: change\ndata: ${JSON.stringify({ kind, path: rel })}\n\n`);
    };

    if (!closed) {
      watcher = chokidar.watch(watchPaths, {
        ignoreInitial: true,
        ignored: (p: string) => p.includes("/node_modules/") || p.endsWith(".lock"),
        persistent: true,
      });
      watcher.on("add", (f: string) => sendEvent("add", f));
      watcher.on("change", (f: string) => sendEvent("change", f));
      watcher.on("unlink", (f: string) => sendEvent("unlink", f));

      heartbeat = setInterval(() => {
        if (closed) return;
        res.write(`: hb\n\n`);
      }, 15000);
    }

    // If the client disconnected between attaching the listener and now,
    // release what we just allocated (cleanup is idempotent via `closed`).
    if (closed) cleanup();

    // Keep handler open.
    return new Promise<void>(() => {});
  });
}
