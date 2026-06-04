/**
 * Tests for the task-detail transition controls: the single write affordance on
 * the scrum UI. They cover the POST wiring (correct endpoint + target status),
 * success-path query invalidation, the 422 service-message render, and the
 * behind-schema button disable.
 *
 * IMPORTANT: `../../../test/setup` MUST be the first import — it registers
 * happy-dom globals so `window`/`document` exist before testing-library mounts.
 *
 * This file sorts BEFORE `routes/scrum/tree.test.tsx` (`task/` < `tree`), which
 * owns the happy-dom teardown. It therefore deliberately does NOT unregister the
 * globals — doing so would tear `window` out from under the file that sorts
 * after it.
 */
import "../../../test/setup";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { ScrumTask, TaskLayer, TaskStatus } from "@claude-prove/cli/scrum/types";
import { ActiveProjectProvider, type ProjectInfo } from "../../../lib/active-project";
import { setActiveProjectKeyForRequests } from "../../../lib/fetch-utils";
import { ScrumTaskDetailView } from "./[id]";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function mkTask(over: Partial<ScrumTask> & Pick<ScrumTask, "id">): ScrumTask {
  return {
    id: over.id,
    title: over.title ?? `task ${over.id}`,
    description: null,
    status: (over.status ?? "in_progress") as TaskStatus,
    milestone_id: over.milestone_id ?? null,
    parent_id: over.parent_id ?? null,
    layer: (over.layer ?? null) as TaskLayer | null,
    acceptance: over.acceptance ?? null,
    bounds: null,
    terminal_reason: null,
    terminal_detail: null,
    created_by_agent: "scrum-master",
    created_at: "2026-04-20T00:00:00.000Z",
    last_event_at: "2026-04-20T00:00:00.000Z",
    last_modified_by: null,
    last_modified_at: null,
    worker_id: null,
    run_id: null,
    deleted_at: null,
    provenance: {
      created_by: "scrum-master",
      created_at: "2026-04-20T00:00:00.000Z",
      last_modified_by: null,
      last_modified_at: null,
      worker_id: null,
      run_id: null,
      schema_version: 12,
    },
  };
}

function taskDetailBody(task: ScrumTask) {
  return { task, tags: [], events: [], runs: [], decisions: [], blocked_by: [], blocking: [] };
}

const PROJECT_CURRENT: ProjectInfo = {
  id: "%2Fhome%2Fme%2Frepo",
  path: "/home/me/repo",
  name: "repo",
  last_seen: "2026-04-20T00:00:00.000Z",
  store: { schema_version: 12, behind: false },
};

const PROJECT_BEHIND: ProjectInfo = {
  id: "%2Fhome%2Fme%2Fbehind",
  path: "/home/me/behind",
  name: "behind",
  last_seen: "2026-04-20T00:00:00.000Z",
  store: { schema_version: 9, behind: true },
};

// ---------------------------------------------------------------------------
// Fetch mock — records requests so POST wiring can be asserted.
// ---------------------------------------------------------------------------

type FetchReply = { status: number; body: unknown };
type FetchStub = (url: string, init?: RequestInit) => FetchReply;

let fetchStub: FetchStub = () => ({ status: 404, body: { error: "not stubbed" } });
let postCalls: Array<{ url: string; body: unknown }> = [];

function installFetchMock() {
  postCalls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    if (init?.method === "POST") {
      postCalls.push({ url, body: init.body ? JSON.parse(init.body as string) : null });
    }
    const { status, body } = fetchStub(url, init);
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? "OK" : "ERR",
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response;
  }) as typeof fetch;
}

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, staleTime: Infinity },
    },
  });
}

function renderDetail(qc: QueryClient, taskId: string, project: ProjectInfo | null) {
  return render(
    <QueryClientProvider client={qc}>
      <ActiveProjectProvider project={project}>
        <MemoryRouter initialEntries={[`/scrum/task/${taskId}`]}>
          <Routes>
            <Route path="/scrum/task/:id" element={<ScrumTaskDetailView />} />
          </Routes>
        </MemoryRouter>
      </ActiveProjectProvider>
    </QueryClientProvider>,
  );
}

/** Seed the detail query so the view renders synchronously, scoped to projectKey. */
function seedDetail(qc: QueryClient, task: ScrumTask, projectKey: string | null) {
  qc.setQueryData(["scrum", "task", task.id, projectKey], taskDetailBody(task));
}

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

describe("ScrumTaskDetailView transition controls", () => {
  beforeEach(() => {
    // Reset URL + storage so the provider seeds a null projectKey — a prior DOM
    // test file leaves a `?project=` in window.location that would otherwise
    // make the seeded query key (keyed under null) a cache miss.
    window.history.replaceState(null, "", "/scrum/task/seed");
    localStorage.clear();
    setActiveProjectKeyForRequests(null);
    installFetchMock();
  });
  afterEach(cleanup);

  test("clicking a transition POSTs the target status to the task's status route", async () => {
    const task = mkTask({ id: "t1", status: "in_progress" });
    fetchStub = (url, init) => {
      // POST → transition response; GET (the post-invalidation refetch) → the
      // full detail envelope so the view re-renders cleanly.
      if (init?.method === "POST") return { status: 200, body: { task: { ...task, status: "review" } } };
      if (url.startsWith("/api/scrum/tasks/t1")) return { status: 200, body: taskDetailBody({ ...task, status: "review" }) };
      return { status: 404, body: { error: "not found" } };
    };

    const qc = makeClient();
    // No `?project=` in the route, so the provider's projectKey is null; the
    // detail query is keyed under null to match what the view reads.
    seedDetail(qc, task, null);
    const r = renderDetail(qc, "t1", PROJECT_CURRENT);

    // `in_progress` allows → review; that button must exist and POST on click.
    const btn = r.getByTestId("transition-review");
    await act(async () => {
      fireEvent.click(btn);
    });
    await flush();

    expect(postCalls).toHaveLength(1);
    expect(postCalls[0]!.url).toContain("/api/scrum/tasks/t1/status");
    expect(postCalls[0]!.body).toEqual({ status: "review" });
    r.unmount();
  });

  test("a successful transition invalidates the scrum query family", async () => {
    const task = mkTask({ id: "t2", status: "ready" });
    fetchStub = (url, init) => {
      if (init?.method === "POST") return { status: 200, body: { task: { ...task, status: "in_progress" } } };
      if (url.startsWith("/api/scrum/tasks/t2")) return { status: 200, body: taskDetailBody({ ...task, status: "in_progress" }) };
      return { status: 404, body: { error: "not found" } };
    };

    const qc = makeClient();
    // Seed two scrum-family entries: the detail this view reads, and a board
    // entry. Both must be invalidated by the success path. projectKey is null
    // (no `?project=` in the route).
    seedDetail(qc, task, null);
    qc.setQueryData(["scrum", "tasks", {}, null], { tasks: [task] });
    const r = renderDetail(qc, "t2", PROJECT_CURRENT);

    const btn = r.getByTestId("transition-in_progress");
    await act(async () => {
      fireEvent.click(btn);
    });
    await flush();

    // invalidateQueries({ queryKey: ["scrum"] }) marks every scrum entry stale.
    // The board query has no live observer here, so it stays invalidated and is
    // the clean proof the family-wide invalidation reached beyond the active
    // detail query (which the mounted view immediately refetches, clearing its
    // own invalidated flag).
    const boardState = qc.getQueryState(["scrum", "tasks", {}, null]);
    expect(boardState?.isInvalidated).toBe(true);
    r.unmount();
  });

  test("a 422 service rejection renders the message inline", async () => {
    const task = mkTask({ id: "t3", status: "ready" });
    fetchStub = (url, init) => {
      if (init?.method === "POST") {
        return {
          status: 422,
          body: { error: "updateTaskStatus: invalid transition 'ready' -> 'done' for task 't3'" },
        };
      }
      return { status: 200, body: taskDetailBody(task) };
    };

    const qc = makeClient();
    seedDetail(qc, task, null);
    const r = renderDetail(qc, "t3", PROJECT_CURRENT);

    const btn = r.getByTestId("transition-in_progress");
    await act(async () => {
      fireEvent.click(btn);
    });
    await flush();

    const err = r.getByTestId("transition-error");
    expect(err.textContent).toContain("invalid transition");
    // The behind-schema notice must NOT show for an ordinary 422.
    expect(r.queryByTestId("transition-schema-blocked")).toBeNull();
    r.unmount();
  });

  test("a behind-schema project renders the transition buttons disabled", async () => {
    const task = mkTask({ id: "t4", status: "in_progress" });
    fetchStub = () => ({ status: 200, body: taskDetailBody(task) });

    const qc = makeClient();
    seedDetail(qc, task, null);
    const r = renderDetail(qc, "t4", PROJECT_BEHIND);

    const btn = r.getByTestId("transition-review") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    // No POST is possible while writes are gated.
    await act(async () => {
      fireEvent.click(btn);
    });
    await flush();
    expect(postCalls).toHaveLength(0);
    r.unmount();
  });
});
