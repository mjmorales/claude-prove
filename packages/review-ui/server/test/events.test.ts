/**
 * Coverage for the per-project SSE multiplexer (`registerEventsRoute`):
 *
 *   (a) every emitted `event: change` payload carries the resolved ProjectRef
 *       id in a `project` field (the server-owned contract the web client demuxes
 *       on);
 *   (b) connecting with an unregistered/escaping `?project=` key is rejected with
 *       the structured `unknown project` 404 BEFORE the SSE head is written — no
 *       half-open stream;
 *   (c) two clients on ONE project share a single watcher (asserted via a counting
 *       watcher-factory seam), and both receive a project-scoped event from one
 *       synthetic fs change;
 *   (d) the shared watcher is torn down only when its LAST client disconnects;
 *   (e) clients on DIFFERENT projects get independently-scoped watchers and events.
 *
 * The watcher-factory seam (`WatcherFactory`) replaces chokidar with a stub that
 * counts creations and lets the test fire synthetic add/change/unlink events, so
 * no real filesystem watch is started. A real listening server + `fetch` SSE
 * reader is used because the connected handler never resolves (it holds the
 * stream open), so `app.inject` cannot model an established connection — only the
 * rejection path (b) returns a normal reply and is probed via `inject`.
 *
 * The registry `baseOverride` seam points every resolve at a tmp dir, so no test
 * touches the real `~/.claude-prove/`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { add as registryAdd } from "@claude-prove/store";
import Fastify, { type FastifyInstance } from "fastify";
import { makeProjectResolver, type ProjectResolver } from "../src/projects";
import {
  registerEventsRoute,
  type WatcherFactory,
  type WatcherHandle,
} from "../src/routes/events";

let baseDir: string;
let workspace: string;

/** A stub watcher: captures its listeners so a test can fire synthetic events. */
class StubWatcher implements WatcherHandle {
  readonly watchPaths: string[];
  closed = false;
  private listeners = new Map<string, (changedPath: string) => void>();

  constructor(watchPaths: string[]) {
    this.watchPaths = watchPaths;
  }

  on(event: string, listener: (changedPath: string) => void): this {
    this.listeners.set(event, listener);
    return this;
  }

  close(): void {
    this.closed = true;
  }

  /** Drive a synthetic fs event through the route's registered handler. */
  emit(event: "add" | "change" | "unlink", changedPath: string): void {
    this.listeners.get(event)?.(changedPath);
  }
}

/** A factory that records every watcher it builds — the sharing assertion seam. */
function makeCountingFactory(): { factory: WatcherFactory; created: StubWatcher[] } {
  const created: StubWatcher[] = [];
  const factory: WatcherFactory = (watchPaths) => {
    const w = new StubWatcher(watchPaths);
    created.push(w);
    return w;
  };
  return { factory, created };
}

/** Tmp root with a `.prove/prove.db`, registered in the tmp-dir registry. */
function registerLiveProject(name: string): string {
  const root = join(workspace, name);
  mkdirSync(join(root, ".prove"), { recursive: true });
  writeFileSync(join(root, ".prove", "prove.db"), "");
  registryAdd(root, baseDir);
  return root;
}

/**
 * Build a bare Fastify app with ONLY the events route, wired to a tmp-registry
 * resolver and the injected watcher factory, then start listening on an ephemeral
 * port. Returns the app and its base URL.
 */
async function startEventsApp(
  startupRoot: string,
  factory: WatcherFactory,
): Promise<{ app: FastifyInstance; baseUrl: string; resolver: ProjectResolver }> {
  const app = Fastify({ logger: false });
  const resolver = makeProjectResolver(startupRoot, baseDir);
  registerEventsRoute(app, resolver, factory);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (addr === null || typeof addr === "string") throw new Error("no bound port");
  return { app, baseUrl: `http://127.0.0.1:${addr.port}`, resolver };
}

/**
 * Open an SSE connection and return a reader that yields decoded text chunks plus
 * an abort handle. The connection stays open until `abort()` (which the server
 * sees as a client disconnect, driving cleanup).
 */
async function openSse(
  baseUrl: string,
  query: string,
): Promise<{ next: () => Promise<string>; abort: () => void; response: Response }> {
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}/api/events${query}`, {
    signal: controller.signal,
    headers: { accept: "text/event-stream" },
  });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  return {
    response,
    abort: () => controller.abort(),
    next: async () => {
      const { value, done } = await reader.read();
      if (done) return "";
      return decoder.decode(value, { stream: true });
    },
  };
}

/** Read SSE chunks until a `data:` payload arrives, then parse it as JSON. */
async function readChangePayload(
  next: () => Promise<string>,
): Promise<{ kind: string; path: string; project: string }> {
  let buffer = "";
  for (let i = 0; i < 50; i++) {
    buffer += await next();
    const dataLine = buffer.split("\n").find((line) => line.startsWith("data:"));
    if (dataLine) return JSON.parse(dataLine.slice("data:".length).trim());
  }
  throw new Error("no data payload received");
}

/** Spin the event loop until `predicate` holds or the budget is exhausted. */
async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), "prove-events-base-"));
  workspace = mkdtempSync(join(tmpdir(), "prove-events-ws-"));
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

describe("per-project SSE watcher multiplexing", () => {
  test("(a) change payloads carry the resolved ProjectRef id in `project`", async () => {
    const alpha = registerLiveProject("alpha");
    const { factory, created } = makeCountingFactory();
    const { app, baseUrl } = await startEventsApp(alpha, factory);
    try {
      const sse = await openSse(baseUrl, `?project=${encodeURIComponent(alpha)}`);
      await waitFor(() => created.length === 1, "watcher created");

      const changed = join(alpha, ".prove/runs/main/add-login/state.json");
      created[0]!.emit("add", changed);

      const payload = await readChangePayload(sse.next);
      expect(payload.kind).toBe("add");
      // Path is project-relative to the resolved root.
      expect(payload.path).toBe(".prove/runs/main/add-login/state.json");
      // `project` is the URL-encoded resolved root — the ProjectRef id contract.
      expect(payload.project).toBe(encodeURIComponent(alpha));

      sse.abort();
    } finally {
      await app.close();
    }
  });

  test("(b) an unregistered key is rejected with `unknown project` 404 before the stream", async () => {
    const alpha = registerLiveProject("alpha");
    const { factory, created } = makeCountingFactory();
    // `inject` models the rejection path: the resolver replies 404 and the
    // handler returns the reply WITHOUT writing the SSE head, so no stream opens.
    const app = Fastify({ logger: false });
    registerEventsRoute(app, makeProjectResolver(alpha, baseDir), factory);
    await app.ready();
    try {
      const decoded = join(workspace, "not-registered");
      const res = await app.inject({
        method: "GET",
        url: `/api/events?project=${encodeURIComponent(decoded)}`,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: "unknown project", project: decoded });
      // No watcher was ever built for a rejected connection.
      expect(created.length).toBe(0);
    } finally {
      await app.close();
    }
  });

  test("(c) two clients on one project share a single watcher and both receive events", async () => {
    const alpha = registerLiveProject("alpha");
    const { factory, created } = makeCountingFactory();
    const { app, baseUrl } = await startEventsApp(alpha, factory);
    try {
      const key = `?project=${encodeURIComponent(alpha)}`;
      const clientA = await openSse(baseUrl, key);
      const clientB = await openSse(baseUrl, key);
      // Exactly one watcher backs both clients on the same project.
      await waitFor(() => created.length === 1, "single shared watcher");
      expect(created.length).toBe(1);

      const changed = join(alpha, ".prove/runs/main/x/plan.json");
      created[0]!.emit("change", changed);

      const a = await readChangePayload(clientA.next);
      const b = await readChangePayload(clientB.next);
      expect(a.project).toBe(encodeURIComponent(alpha));
      expect(b.project).toBe(encodeURIComponent(alpha));
      expect(a.path).toBe(".prove/runs/main/x/plan.json");
      expect(b.path).toBe(".prove/runs/main/x/plan.json");

      clientA.abort();
      clientB.abort();
    } finally {
      await app.close();
    }
  });

  test("(d) the shared watcher is torn down only on the LAST client disconnect", async () => {
    const alpha = registerLiveProject("alpha");
    const { factory, created } = makeCountingFactory();
    const { app, baseUrl } = await startEventsApp(alpha, factory);
    try {
      const key = `?project=${encodeURIComponent(alpha)}`;
      const clientA = await openSse(baseUrl, key);
      const clientB = await openSse(baseUrl, key);
      await waitFor(() => created.length === 1, "single shared watcher");
      const watcher = created[0]!;

      // First disconnect: ref-count drops but the watcher stays open for B.
      clientA.abort();
      await waitFor(() => watcher.closed === false, "watcher still open after one leaves");
      // Give the server a beat to process the disconnect, then assert it stayed open.
      await new Promise((r) => setTimeout(r, 50));
      expect(watcher.closed).toBe(false);

      // Last disconnect: the watcher is closed and the entry evicted.
      clientB.abort();
      await waitFor(() => watcher.closed === true, "watcher closed on last leave");
      expect(watcher.closed).toBe(true);
    } finally {
      await app.close();
    }
  });

  test("(e) clients on different projects get independently-scoped watchers and events", async () => {
    const alpha = registerLiveProject("alpha");
    const beta = registerLiveProject("beta");
    const { factory, created } = makeCountingFactory();
    const { app, baseUrl } = await startEventsApp(alpha, factory);
    try {
      const clientAlpha = await openSse(baseUrl, `?project=${encodeURIComponent(alpha)}`);
      const clientBeta = await openSse(baseUrl, `?project=${encodeURIComponent(beta)}`);
      // Distinct roots → distinct watchers, no sharing across projects.
      await waitFor(() => created.length === 2, "one watcher per project");
      expect(created.length).toBe(2);

      const alphaWatcher = created.find((w) => w.watchPaths[0]!.startsWith(alpha))!;
      const betaWatcher = created.find((w) => w.watchPaths[0]!.startsWith(beta))!;
      expect(alphaWatcher).toBeDefined();
      expect(betaWatcher).toBeDefined();

      // An event on beta's watcher reaches only the beta client, scoped to beta.
      betaWatcher.emit("unlink", join(beta, ".prove/runs/main/y/state.json"));
      const payload = await readChangePayload(clientBeta.next);
      expect(payload.kind).toBe("unlink");
      expect(payload.project).toBe(encodeURIComponent(beta));
      expect(payload.path).toBe(".prove/runs/main/y/state.json");

      clientAlpha.abort();
      clientBeta.abort();
    } finally {
      await app.close();
    }
  });
});
