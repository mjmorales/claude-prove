/**
 * Per-project SSE routing tests for `useEventStream` + the shared `sseBus`.
 *
 * Covers:
 *   1. The active project's key routes the EventSource to its `?project=` URL,
 *      and a null key routes to the bare stream.
 *   2. An active-project event invalidates the matching query groups.
 *   3. An event for a different project is dropped without invalidating.
 *   4. With a null active key, every event on the unparameterized stream is
 *      accepted (the null-key blanket-acceptance policy).
 *   5. Changing the active key reconnects to the new `?project=` URL and tears
 *      the old EventSource down.
 *
 * IMPORTANT: `../test/setup` MUST be the first import — it registers happy-dom
 * globals so `window` exists before testing-library mounts. happy-dom does NOT
 * supply `EventSource`, so a controllable stub is installed on `globalThis`;
 * the stub records its URL and lets the test drive synthetic `change` events.
 *
 * The active key is seeded the way the shell seeds it — through the `?project=`
 * URL param read by `seedProjectKey` — so the hook's first effect already holds
 * the intended key. Reconnection is driven by capturing the provider's
 * `setProjectKey` and flipping it inside `act`, which mirrors the live selector.
 *
 * We deliberately do NOT unregister happy-dom in afterAll. Bun runs every test
 * file in one shared process; the alphabetically-last DOM test file owns the
 * teardown, and this file sorts before it. Setup is idempotent on register.
 */
import "../test/setup";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  ActiveProjectProvider,
  pathToProjectId,
  useActiveProject,
} from "../lib/active-project";
import { setActiveProjectKey } from "./sseBus";
import { useEventStream } from "./useEvents";

/**
 * Minimal EventSource stub. Records the URL it was constructed with, exposes
 * the active `change` listener so a test can fire synthetic payloads, and
 * tracks `close()` so reconnection can be asserted. Every instance is appended
 * to `instances`, newest last.
 */
class StubEventSource {
  static instances: StubEventSource[] = [];
  url: string;
  closed = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  private changeListener: ((evt: MessageEvent) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    StubEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (evt: MessageEvent) => void): void {
    if (type === "change") this.changeListener = listener;
  }

  close(): void {
    this.closed = true;
  }

  /** Drive a synthetic `change` event through the registered listener. */
  emitChange(payload: { kind: string; path: string; project?: string }): void {
    this.changeListener?.({ data: JSON.stringify(payload) } as MessageEvent);
  }
}

function installEventSourceStub(): void {
  StubEventSource.instances = [];
  (globalThis as unknown as { EventSource: unknown }).EventSource =
    StubEventSource as unknown;
}

/** The single live stub — the bus is a singleton, so exactly one is open. */
function liveSource(): StubEventSource {
  const open = StubEventSource.instances.filter((s) => !s.closed);
  expect(open).toHaveLength(1);
  return open[open.length - 1]!;
}

/** Seed the active key via the URL the way `seedProjectKey` reads it, so the
 * hook's first effect connects against the intended stream. The argument is the
 * DECODED registry path (the form the bus contract expects); it is encoded into
 * the `?project=` URL so `URLSearchParams.get` decodes it back to that path. */
function seedKey(path: string | null): void {
  if (path === null) window.history.replaceState(null, "", "/");
  else window.history.replaceState(null, "", `/?project=${pathToProjectId(path)}`);
}

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
}

/** Spy on invalidateQueries, collecting the first key of every invalidated
 * group so a test can assert which groups fired. */
function spyInvalidations(qc: QueryClient): string[] {
  const seen: string[] = [];
  const original = qc.invalidateQueries.bind(qc);
  qc.invalidateQueries = ((filters?: { queryKey?: unknown[] }) => {
    const key = filters?.queryKey?.[0];
    if (typeof key === "string") seen.push(key);
    return original(filters as Parameters<typeof original>[0]);
  }) as typeof qc.invalidateQueries;
  return seen;
}

/** Captures the provider's `setProjectKey` into the supplied ref so a test can
 * flip the active project after mount, the way the live selector does. */
function makeWrapper(qc: QueryClient, captureSetKey?: SetKeyRef) {
  function Capture() {
    const { setProjectKey } = useActiveProject();
    if (captureSetKey) captureSetKey.current = setProjectKey;
    return null;
  }
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <ActiveProjectProvider>
        <Capture />
        {children}
      </ActiveProjectProvider>
    </QueryClientProvider>
  );
}

type SetKeyRef = { current: (key: string | null) => void };

// Decoded registry paths — the form the bus and `setProjectKey` contract on.
// `pathToProjectId` derives the encoded `?project=` / `project`-field form.
const PROJECT_A = "/home/me/repo-a";
const PROJECT_B = "/home/me/repo-b";
const PROJECT_A_ID = pathToProjectId(PROJECT_A);
const PROJECT_B_ID = pathToProjectId(PROJECT_B);

describe("useEventStream per-project routing", () => {
  beforeEach(() => {
    installEventSourceStub();
    window.history.replaceState(null, "", "/");
    localStorage.clear();
    // The bus holds the active key at module scope; reset it so a key set by a
    // prior test cannot bleed into this one's first connect.
    setActiveProjectKey(null);
  });
  afterEach(cleanup);

  test("connects to the active project's parameterized stream", () => {
    seedKey(PROJECT_A);
    renderHook(() => useEventStream(), { wrapper: makeWrapper(makeClient()) });
    expect(liveSource().url).toBe(`/api/events?project=${PROJECT_A_ID}`);
  });

  test("connects to the bare stream when no project key is active", () => {
    seedKey(null);
    renderHook(() => useEventStream(), { wrapper: makeWrapper(makeClient()) });
    expect(liveSource().url).toBe("/api/events");
  });

  test("active-project event invalidates the matching query groups", () => {
    seedKey(PROJECT_A);
    const qc = makeClient();
    const seen = spyInvalidations(qc);
    renderHook(() => useEventStream(), { wrapper: makeWrapper(qc) });
    act(() => {
      // `.git/HEAD` selects the git group; `runs`/`branches` are among its keys.
      // The server stamps the encoded id, not the decoded path.
      liveSource().emitChange({ kind: "change", path: ".git/HEAD", project: PROJECT_A_ID });
    });
    expect(seen).toContain("runs");
    expect(seen).toContain("branches");
  });

  test("other-project event is dropped without invalidating", () => {
    seedKey(PROJECT_A);
    const qc = makeClient();
    const seen = spyInvalidations(qc);
    renderHook(() => useEventStream(), { wrapper: makeWrapper(qc) });
    act(() => {
      liveSource().emitChange({ kind: "change", path: ".git/HEAD", project: PROJECT_B_ID });
    });
    expect(seen).toHaveLength(0);
  });

  test("null active key accepts every event on the bare stream", () => {
    seedKey(null);
    const qc = makeClient();
    const seen = spyInvalidations(qc);
    renderHook(() => useEventStream(), { wrapper: makeWrapper(qc) });
    act(() => {
      // No `project` field (bare stream) — accepted under the null-key policy.
      liveSource().emitChange({ kind: "change", path: ".git/HEAD" });
    });
    expect(seen).toContain("runs");
  });

  test("changing the active key reconnects to the new URL and closes the old source", () => {
    seedKey(PROJECT_A);
    const qc = makeClient();
    const setKey: SetKeyRef = { current: () => {} };
    renderHook(() => useEventStream(), { wrapper: makeWrapper(qc, setKey) });
    const first = liveSource();
    expect(first.url).toBe(`/api/events?project=${PROJECT_A_ID}`);

    // The selector hands `setProjectKey` the DECODED path, never the encoded id.
    act(() => setKey.current(PROJECT_B));
    const second = liveSource();
    expect(first.closed).toBe(true);
    expect(second).not.toBe(first);
    expect(second.url).toBe(`/api/events?project=${PROJECT_B_ID}`);
  });

  test("literal-% decoded path routes without throwing and demuxes on the encoded id", () => {
    // The bus receives the DECODED registry path; a literal `%` (e.g.
    // `/repos/100%done`) is the trap that a decode-then-encode would crash on
    // with `URIError`. The path must encode exactly once into the stream URL and
    // into the `project` field the demux compares against.
    const decoded = "/repos/100%done";
    const encoded = pathToProjectId(decoded); // "%2Frepos%2F100%25done"
    expect(encoded).toBe("%2Frepos%2F100%25done");
    // `seedKey` encodes the decoded path into the URL, which `URLSearchParams`
    // decodes once back to it — so the active key is the decoded path the bus
    // contract expects.
    seedKey(decoded);
    const qc = makeClient();
    const seen = spyInvalidations(qc);
    // Building the stream URL must not throw on the literal `%`.
    renderHook(() => useEventStream(), { wrapper: makeWrapper(qc) });
    expect(liveSource().url).toBe(`/api/events?project=${encoded}`);

    act(() => {
      // An event stamped with the encoded form of the active path invalidates.
      liveSource().emitChange({ kind: "change", path: ".git/HEAD", project: encoded });
    });
    expect(seen).toContain("runs");

    seen.length = 0;
    act(() => {
      // A different project's event is still dropped.
      liveSource().emitChange({ kind: "change", path: ".git/HEAD", project: PROJECT_B_ID });
    });
    expect(seen).toHaveLength(0);
  });
});
