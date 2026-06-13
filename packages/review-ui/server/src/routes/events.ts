import type { FastifyInstance } from "fastify";
import chokidar from "chokidar";
import path from "node:path";
import type { ProjectResolver } from "../projects.js";

/**
 * The fs-watching dependency the SSE route needs, narrowed to the two methods
 * the multiplexer actually drives. chokidar's `FSWatcher` satisfies it, and a
 * test stub can satisfy it without spinning up real filesystem watches — the
 * seam that lets a test count watcher creations and drive synthetic fs events.
 */
export interface WatcherHandle {
  on(event: string, listener: (changedPath: string) => void): unknown;
  close(): Promise<void> | void;
}

/**
 * Construct a watcher over the given absolute paths. The default builds a
 * chokidar watcher; tests inject a counting/controllable stub to assert that
 * multiple SSE clients on one project reuse a single watcher.
 */
export type WatcherFactory = (watchPaths: string[]) => WatcherHandle;

/** An fs change, normalized to a project-relative path before fan-out. */
type FsEvent = { kind: "add" | "change" | "unlink"; relativePath: string };

/** Per-client sink: the route registers one of these to receive fan-out. */
type Subscriber = (event: FsEvent) => void;

/**
 * A single watcher shared by every client scoped to one project root, plus the
 * live subscriber set it fans out to. Ref-counting is implicit in `subscribers`
 * size: the entry is created on the first subscribe and torn down (watcher
 * closed, entry evicted) when the last subscriber leaves. Sharing is keyed by
 * resolved root so two roots that happen to share a basename never collide.
 */
interface SharedWatcher {
  watcher: WatcherHandle;
  subscribers: Set<Subscriber>;
}

/**
 * The watch surface for a project: its run artifacts plus the git refs whose
 * mutation the UI reflects (branch switches, new worktrees), derived per
 * resolved root.
 */
function watchPathsFor(projectRoot: string): string[] {
  return [
    path.join(projectRoot, ".prove/runs"),
    path.join(projectRoot, ".git/refs"),
    path.join(projectRoot, ".git/HEAD"),
    path.join(projectRoot, ".git/worktrees"),
  ];
}

/** The default chokidar-backed factory; ignores node_modules and lockfiles. */
function defaultWatcherFactory(watchPaths: string[]): WatcherHandle {
  return chokidar.watch(watchPaths, {
    ignoreInitial: true,
    ignored: (p: string) => p.includes("/node_modules/") || p.endsWith(".lock"),
    persistent: true,
  });
}

export function registerEventsRoute(
  app: FastifyInstance,
  resolveProject: ProjectResolver,
  watcherFactory: WatcherFactory = defaultWatcherFactory,
) {
  // The shared-watcher registry, scoped to this app instance (not module-global)
  // so concurrent test apps never cross-contaminate each other's watchers. Keyed
  // by resolved project root; a fresh Map per registration is the isolation seam.
  const sharedByRoot = new Map<string, SharedWatcher>();

  // Attach `subscriber` to the project's shared watcher, creating the watcher on
  // the first subscriber for that root. Returns an idempotent unsubscribe that
  // tears the watcher down once its last subscriber leaves.
  const subscribe = (projectRoot: string, subscriber: Subscriber): (() => void) => {
    let shared = sharedByRoot.get(projectRoot);
    if (!shared) {
      const watcher = watcherFactory(watchPathsFor(projectRoot));
      shared = { watcher, subscribers: new Set() };
      sharedByRoot.set(projectRoot, shared);

      // Fan one fs event out to every current subscriber. Path is made
      // project-relative once here, not per subscriber, since all share the root.
      const fanOut = (kind: FsEvent["kind"]) => (changedPath: string) => {
        const relativePath = path.relative(projectRoot, changedPath);
        for (const sink of shared!.subscribers) sink({ kind, relativePath });
      };
      watcher.on("add", fanOut("add"));
      watcher.on("change", fanOut("change"));
      watcher.on("unlink", fanOut("unlink"));
    }

    const entry = shared;
    entry.subscribers.add(subscriber);

    let released = false;
    return () => {
      // Idempotent: a client's `close` may fire more than once; only the first
      // call counts against the ref-count, and only the true last leaver closes.
      if (released) return;
      released = true;
      entry.subscribers.delete(subscriber);
      if (entry.subscribers.size === 0) {
        sharedByRoot.delete(projectRoot);
        // Surface a teardown rejection: in a long-lived daemon a silent
        // close() failure would otherwise leave a leaked watcher invisible.
        void Promise.resolve(entry.watcher.close()).catch((err) =>
          app.log.warn({ err, projectRoot }, "review-ui watcher close failed"),
        );
      }
    };
  };

  app.get("/api/events", async (req, reply) => {
    // Resolve the project for THIS connection before any stream output. On an
    // absent key the resolver yields the startup root; on an unregistered or
    // escaping key it has already sent the structured 404 and returns null —
    // bail before writing the SSE head so the rejection is a clean HTTP error,
    // not a half-open stream.
    const projectRoot = resolveProject(req, reply);
    if (projectRoot === null) return reply;

    // The resolved ProjectRef id the server stamps on every data event: the
    // URL-encoded registered root, the same lossless key the client sends back
    // as `?project=`. The web client consumes this to demux multiplexed streams.
    const projectId = encodeURIComponent(projectRoot);

    const res = reply.raw;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(`: connected\n\n`);

    // Resource-cleanup handshake:
    //   - `closed` guards against double-cleanup (some clients hang up mid-setup;
    //     `close` then fires before/while subscription+heartbeat are initialized).
    //   - `cleanup` tolerates partially-initialized state by null-checking each
    //     handle before releasing it.
    let closed = false;
    let unsubscribe: (() => void) | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;

    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      if (unsubscribe) unsubscribe();
    };

    // Attach the close listeners first so a premature disconnect still hits
    // `cleanup` and turns subsequent setup into a no-op via `closed`. A client
    // disconnect surfaces as `close` on the response stream in some runtimes and
    // on the request stream in others; listen on BOTH and let whichever fires
    // first drive cleanup (it is idempotent via `closed`), so the watcher
    // ref-count is released regardless of which end signals the hangup.
    const onClose = (raw: { on: (e: string, cb: () => void) => void } | undefined) => {
      raw?.on("close", cleanup);
    };
    onClose((reply as unknown as { raw?: { on: (e: string, cb: () => void) => void } }).raw);
    onClose((req as unknown as { raw?: { on: (e: string, cb: () => void) => void } }).raw);

    const sendEvent = (event: FsEvent) => {
      if (closed) return;
      res.write(
        `event: change\ndata: ${JSON.stringify({
          kind: event.kind,
          path: event.relativePath,
          project: projectId,
        })}\n\n`,
      );
    };

    if (!closed) {
      // Join (or create) the project's shared watcher. Multiple clients on one
      // project reuse a single watcher; this client's `sendEvent` is its sink.
      unsubscribe = subscribe(projectRoot, sendEvent);

      // Heartbeat stays project-less: a bare SSE comment carries no payload, so
      // there is no `project` field to stamp. Clients treat `: hb` as liveness
      // only and key event demuxing off the `project` field on `event: change`.
      heartbeat = setInterval(() => {
        if (closed) return;
        res.write(`: hb\n\n`);
      }, 15000);
    }

    // If the client disconnected between attaching the listener and now, release
    // what we just allocated (cleanup is idempotent via `closed`).
    if (closed) cleanup();

    // Keep handler open.
    return new Promise<void>(() => {});
  });
}
