/**
 * Routing smoke tests. Covers:
 *   1. `/` redirects into `/acb` and renders the ACB surface.
 *   2. `/scrum` redirects to `/scrum/now` and mounts the dashboard.
 *   3. `/scrum/board` mounts the board view.
 *   4. `/scrum/task/:id` with seeded fixture renders task detail.
 *   5. `/acb?run=chore%2Ffoo` hydrates the selection store via useUrlState.
 *
 * IMPORTANT: `../test/setup` MUST be the first import — it registers
 * happy-dom globals so that `document` / `window` exist by the time React +
 * testing-library mount. We intentionally DO NOT import `screen` from
 * `@testing-library/react`: its module-init captures `document.body` too
 * early under Bun's test loader and binds to an error-throwing stub. Instead
 * we use the `render()` return value, which constructs queries lazily via
 * `within(container.parentNode)`.
 *
 * happy-dom lifecycle: Bun runs every test file in one shared process in
 * filesystem-dependent (unsorted) order, so this file owns its own DOM window:
 * `beforeAll(registerDom)` + `afterAll(unregisterDom)`; the teardown also
 * restores the native `fetch` so stubs installed here never leak into suites
 * that run after this file.
 *
 * For scrum tests we swap in a fresh QueryClient per test and stub `fetch`
 * so the read-only API contract is exercised without a real server.
 */
import { registerDom, unregisterDom } from "../test/setup";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter, Navigate, Route, Routes } from "react-router-dom";
import { useUrlState } from "../hooks/useUrlState";
import { ActiveProjectProvider } from "../lib/active-project";
import { useSelection } from "../lib/store";
import { useScrumSelection } from "../lib/scrumStore";
import { ScrumRoute } from "./scrum";
import { bucketByStatus } from "./scrum/board";

/** Minimal ACB stub that proves `useUrlState` runs inside the route. */
function AcbStub() {
  useUrlState();
  const slug = useSelection((s) => s.slug);
  return <div data-testid="acb-surface">acb:{slug ?? "none"}</div>;
}

// Mirrors `App.tsx`, which mounts `ActiveProjectProvider` above the router so
// every scrum view can read the active project key. The scrum views thread that
// key into their query keys, so the provider is required for them to mount.
function AppStub() {
  return (
    <ActiveProjectProvider>
      <Routes>
        <Route path="/" element={<Navigate to="/acb" replace />} />
        <Route path="/acb/*" element={<AcbStub />} />
        <Route path="/scrum/*" element={<ScrumRoute />} />
      </Routes>
    </ActiveProjectProvider>
  );
}

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, staleTime: Infinity },
    },
  });
}

function resetSelection(): void {
  useSelection.setState({
    slug: null,
    branch: null,
    base: null,
    head: null,
    filePath: null,
    pendingMode: false,
    commitSha: null,
    structureTab: "branches",
    rightTab: "diff",
    docView: "PLAN",
    reviewMode: false,
    activeIntentId: null,
    reviewAutoAdvance: true,
  });
  useScrumSelection.setState({ taskId: null });
}

type FetchStub = (url: string) => { status: number; body: unknown };
let fetchStub: FetchStub = () => ({ status: 404, body: { error: "not stubbed" } });

function installFetchMock() {
  globalThis.fetch = (async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    const { status, body } = fetchStub(url);
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? "OK" : "ERR",
      json: async () => body,
    } as Response;
  }) as typeof fetch;
}

beforeAll(registerDom);
afterAll(unregisterDom);

describe("App routes", () => {
  beforeEach(() => {
    resetSelection();
    installFetchMock();
    // Clear any residual query string between tests — useUrlState reads
    // window.location.search on mount.
    window.history.replaceState(null, "", "/");
    // ActiveProjectProvider seeds its key from the URL then localStorage; clear
    // both so projectKey deterministically resolves to null (the startup-root
    // default), matching the `[..., null]` shape the seeded query keys use.
    localStorage.clear();
  });
  afterEach(() => {
    cleanup();
  });

  test("/ redirects to /acb and renders the ACB surface", () => {
    const r = render(
      <MemoryRouter initialEntries={["/"]}>
        <AppStub />
      </MemoryRouter>,
    );
    expect(r.getByTestId("acb-surface")).toBeDefined();
  });

  test("/scrum/now mounts the Now view", () => {
    fetchStub = (url) => {
      if (url.startsWith("/api/scrum/tasks")) return { status: 200, body: { tasks: [] } };
      if (url.startsWith("/api/scrum/events/recent"))
        return { status: 200, body: { events: [] } };
      return { status: 404, body: { error: "not found" } };
    };
    const qc = makeClient();
    const r = render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/scrum/now"]}>
          <AppStub />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(r.getByRole("heading", { name: /active tasks/i })).toBeDefined();
  });

  test("/scrum/board mounts the board view", () => {
    fetchStub = (url) => {
      if (url.startsWith("/api/scrum/tasks")) return { status: 200, body: { tasks: [] } };
      return { status: 404, body: { error: "not found" } };
    };
    const qc = makeClient();
    const r = render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/scrum/board"]}>
          <AppStub />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    // Nav is rendered by the layout — confirms the layout mounted.
    expect(r.getByRole("navigation", { name: /scrum views/i })).toBeDefined();
  });

  test("bucketByStatus routes an out-of-enum status into backlog, not a throw", () => {
    // status is `TEXT NOT NULL` server-side (no CHECK), so a value outside the
    // canonical enum can arrive. bucketByStatus must not throw on a push to an
    // undefined bucket (F-8-001) — route the unknown into backlog so it stays
    // visible rather than silently dropped.
    const mk = (id: string, status: string) =>
      ({ id, status } as unknown as Parameters<typeof bucketByStatus>[0][number]);
    const out = bucketByStatus([
      mk("known", "in_progress"),
      mk("rogue", "archived"),
    ]);
    expect(out.in_progress.map((t) => t.id)).toEqual(["known"]);
    expect(out.backlog.map((t) => t.id)).toEqual(["rogue"]);
  });

  test("/scrum/milestones computes rollups from a single tasks fetch", async () => {
    // F-8-004: one tasks query, grouped client-side — no per-milestone fan-out.
    const milestones = [
      {
        id: "m-alpha",
        title: "Alpha milestone",
        description: null,
        target_state: null,
        status: "active" as const,
        created_at: "2026-04-20T00:00:00.000Z",
      },
    ];
    const mkTask = (id: string, status: string) => ({
      id,
      title: `task ${id}`,
      description: null,
      status,
      milestone_id: "m-alpha",
      parent_id: null,
      layer: null,
      acceptance: null,
      bounds: null,
      created_by_agent: "scrum-master",
      created_at: "2026-04-20T00:00:00.000Z",
      last_event_at: "2026-04-20T00:00:00.000Z",
      deleted_at: null,
    });
    const milestoneIdHits: string[] = [];
    fetchStub = (url) => {
      if (url.startsWith("/api/scrum/milestones/")) {
        milestoneIdHits.push(url);
        return { status: 404, body: { error: "should not be called" } };
      }
      if (url.startsWith("/api/scrum/milestones"))
        return { status: 200, body: { milestones } };
      if (url.startsWith("/api/scrum/tasks"))
        return {
          status: 200,
          body: { tasks: [mkTask("t1", "done"), mkTask("t2", "in_progress")] },
        };
      return { status: 404, body: { error: "not found" } };
    };
    const qc = makeClient();
    // projectKey defaults to null (the startup-root default) under the bare
    // ActiveProjectProvider, so seed under the project-scoped key shape.
    qc.setQueryData(["scrum", "milestones", {}, null], { milestones });
    qc.setQueryData(["scrum", "tasks", {}, null], {
      tasks: [mkTask("t1", "done"), mkTask("t2", "in_progress")],
    });
    const r = render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/scrum/milestones"]}>
          <AppStub />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(r.getByRole("heading", { name: /alpha milestone/i })).toBeDefined();
    // The per-milestone rollup endpoint must NOT be hit (no N+1 fan-out).
    expect(milestoneIdHits).toHaveLength(0);
  });

  test("selectRun/selectBranch reset per-run review-session state", () => {
    // F-8-005: activeIntentId is per-run; reviewMode must not survive a run
    // switch and activeIntentId must not survive a branch switch.
    const sel = useSelection.getState;
    useSelection.setState({ reviewMode: true, activeIntentId: "intent-x" });
    sel().selectRun("feat%2Fother");
    expect(sel().reviewMode).toBe(false);
    expect(sel().activeIntentId).toBeNull();

    useSelection.setState({ reviewMode: true, activeIntentId: "intent-y" });
    sel().selectBranch("feat/branch", "main");
    expect(sel().activeIntentId).toBeNull();
    // Branch switch is within-run — reviewMode stays.
    expect(sel().reviewMode).toBe(true);
  });

  test("/scrum/task/:id renders task detail with seeded fixture", async () => {
    const fixture = {
      task: {
        id: "abc123",
        title: "Seeded task fixture",
        description: "Longer description body for the fixture.",
        status: "in_progress" as const,
        milestone_id: null,
        created_by_agent: "scrum-master",
        created_at: "2026-04-20T00:00:00.000Z",
        last_event_at: "2026-04-22T12:00:00.000Z",
        deleted_at: null,
      },
      tags: ["phase-12"],
      events: [
        {
          id: 1,
          task_id: "abc123",
          ts: "2026-04-20T00:00:00.000Z",
          kind: "task_created",
          agent: "scrum-master",
          payload: null,
        },
      ],
      runs: [],
      decisions: [],
      blocked_by: [],
      blocking: [],
    };
    fetchStub = (url) => {
      if (url.startsWith("/api/scrum/tasks/abc123"))
        return { status: 200, body: fixture };
      return { status: 404, body: { error: "not found" } };
    };
    const qc = makeClient();
    qc.setQueryData(["scrum", "task", "abc123", null], fixture);
    const r = render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/scrum/task/abc123"]}>
          <AppStub />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(r.getByRole("heading", { name: /seeded task fixture/i })).toBeDefined();
  });

  test("/acb?run=chore%2Ffoo hydrates the slug via useUrlState", async () => {
    // useUrlState reads window.location.search directly. MemoryRouter uses an
    // in-memory history and doesn't touch window.location, so arrange the URL
    // on the real location object before mount.
    window.history.replaceState(null, "", "/acb?run=chore%2Ffoo");
    const r = render(
      <MemoryRouter initialEntries={["/acb?run=chore%2Ffoo"]}>
        <AppStub />
      </MemoryRouter>,
    );
    // Confirm the ACB route mounted (proves /acb path matched).
    expect(r.getByTestId("acb-surface")).toBeDefined();
    // Allow the mount effect to run.
    await Promise.resolve();
    expect(useSelection.getState().slug).toBe("chore/foo");
  });
});
