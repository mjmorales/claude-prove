/**
 * Tests for the layered task-tree panel: pure `parent_id` assembly, milestone
 * grouping, acceptance-criteria rendering, and project-scoped query keys.
 *
 * IMPORTANT: `../../test/setup` MUST be the first import — it registers
 * happy-dom globals so `window`/`document` exist before testing-library mounts.
 *
 * This file is the alphabetically-last DOM test file in the suite, so it OWNS
 * the happy-dom teardown: its `afterAll` unregisters the globals after every
 * DOM test has run. Earlier DOM test files deliberately skip the unregister so
 * they don't tear `window` out from under files that sort after them.
 */
import "../../test/setup";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type {
  AcceptanceCriterion,
  ScrumMilestone,
  ScrumTask,
  TaskLayer,
  TaskStatus,
} from "@claude-prove/cli/scrum/types";
import { ActiveProjectProvider } from "../../lib/active-project";
import { setActiveProjectKeyForRequests } from "../../lib/fetch-utils";
import { ScrumBoardView } from "./board";
import { ScrumTreeView } from "./tree";
import { buildMilestoneTrees, UNASSIGNED_GROUP_ID } from "./tree-assembly";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function mkTask(over: Partial<ScrumTask> & Pick<ScrumTask, "id">): ScrumTask {
  return {
    id: over.id,
    title: over.title ?? `task ${over.id}`,
    description: null,
    status: (over.status ?? "ready") as TaskStatus,
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

function mkMilestone(id: string, title: string): ScrumMilestone {
  return {
    id,
    title,
    description: null,
    target_state: null,
    status: "active",
    initiative: null,
    created_at: "2026-04-20T00:00:00.000Z",
    closed_at: null,
  };
}

function mkCriterion(over: Partial<AcceptanceCriterion> & Pick<AcceptanceCriterion, "id" | "text">): AcceptanceCriterion {
  return {
    id: over.id,
    text: over.text,
    verifies_by: over.verifies_by ?? "bash",
    check: over.check ?? "true",
    status: over.status ?? "active",
    idempotent: over.idempotent ?? true,
    gate: over.gate,
    verification: over.verification,
    superseded_by: over.superseded_by ?? null,
    reason: over.reason ?? null,
    inherited_from: over.inherited_from ?? null,
  };
}

// ---------------------------------------------------------------------------
// Pure assembly
// ---------------------------------------------------------------------------

describe("buildMilestoneTrees", () => {
  test("nests epic → story → task via parent_id within one milestone", () => {
    const tasks = [
      mkTask({ id: "story-1", layer: "story", parent_id: "epic-1", milestone_id: "m1" }),
      mkTask({ id: "epic-1", layer: "epic", parent_id: null, milestone_id: "m1" }),
      mkTask({ id: "task-1", layer: "task", parent_id: "story-1", milestone_id: "m1" }),
    ];
    const groups = buildMilestoneTrees(tasks, [mkMilestone("m1", "Alpha")]);
    expect(groups).toHaveLength(1);
    const [g] = groups;
    expect(g.milestone?.id).toBe("m1");
    expect(g.taskCount).toBe(3);

    // One root (the epic), the story under it, the task under the story.
    expect(g.roots.map((n) => n.task.id)).toEqual(["epic-1"]);
    const epic = g.roots[0]!;
    expect(epic.depth).toBe(0);
    expect(epic.children.map((n) => n.task.id)).toEqual(["story-1"]);
    const story = epic.children[0]!;
    expect(story.depth).toBe(1);
    expect(story.children.map((n) => n.task.id)).toEqual(["task-1"]);
    expect(story.children[0]!.depth).toBe(2);
  });

  test("groups tasks by milestone and buckets milestone-less tasks under unassigned", () => {
    const tasks = [
      mkTask({ id: "a", milestone_id: "m1" }),
      mkTask({ id: "b", milestone_id: "m2" }),
      mkTask({ id: "c", milestone_id: null }),
    ];
    const groups = buildMilestoneTrees(tasks, [
      mkMilestone("m1", "Alpha"),
      mkMilestone("m2", "Beta"),
    ]);
    // Known milestones first (in milestones-list order), unassigned bucket last.
    expect(groups.map((g) => g.milestone?.id ?? UNASSIGNED_GROUP_ID)).toEqual([
      "m1",
      "m2",
      UNASSIGNED_GROUP_ID,
    ]);
    const unassigned = groups.find((g) => g.milestone === null)!;
    expect(unassigned.roots.map((n) => n.task.id)).toEqual(["c"]);
  });

  test("a cross-milestone parent edge promotes the child to a root, never drops it", () => {
    // child names a parent in a DIFFERENT milestone group — it must surface as a
    // root of its own group rather than vanish.
    const tasks = [
      mkTask({ id: "parent", milestone_id: "m1" }),
      mkTask({ id: "child", parent_id: "parent", milestone_id: "m2" }),
    ];
    const groups = buildMilestoneTrees(tasks, [
      mkMilestone("m1", "Alpha"),
      mkMilestone("m2", "Beta"),
    ]);
    const beta = groups.find((g) => g.milestone?.id === "m2")!;
    expect(beta.roots.map((n) => n.task.id)).toEqual(["child"]);
    expect(beta.taskCount).toBe(1);
  });

  test("an empty known milestone is still rendered as a zero-task group", () => {
    const groups = buildMilestoneTrees([], [mkMilestone("m1", "Alpha")]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.taskCount).toBe(0);
    expect(groups[0]!.roots).toEqual([]);
  });

  test("a dangling-milestone task folds into unassigned without clobbering a genuinely-unassigned task", () => {
    // `dangling` points at a milestone absent from the milestones list (deleted/
    // unknown); `loose` carries no milestone at all. Both must land in the one
    // unassigned bucket — neither overwrites the other, neither vanishes.
    const tasks = [
      mkTask({ id: "dangling", milestone_id: "gone" }),
      mkTask({ id: "loose", milestone_id: null }),
    ];
    const groups = buildMilestoneTrees(tasks, [mkMilestone("m1", "Alpha")]);

    // One known (empty) milestone group + exactly one unassigned group — not two
    // colliding null-keyed groups.
    const unassignedGroups = groups.filter((g) => g.milestone === null);
    expect(unassignedGroups).toHaveLength(1);
    const unassigned = unassignedGroups[0]!;
    expect(unassigned.taskCount).toBe(2);
    expect(unassigned.roots.map((n) => n.task.id).sort()).toEqual(["dangling", "loose"]);
  });
});

// ---------------------------------------------------------------------------
// Rendering + project-scoped query keys
// ---------------------------------------------------------------------------

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, staleTime: Infinity },
    },
  });
}

type FetchStub = (url: string) => { status: number; body: unknown };
let fetchStub: FetchStub = () => ({ status: 404, body: { error: "not stubbed" } });
let fetchCalls: string[] = [];

function installFetchMock() {
  fetchCalls = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    fetchCalls.push(url);
    const { status, body } = fetchStub(url);
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? "OK" : "ERR",
      json: async () => body,
    } as Response;
  }) as typeof fetch;
}

function renderTree(qc: QueryClient) {
  return render(
    <QueryClientProvider client={qc}>
      <ActiveProjectProvider>
        <MemoryRouter initialEntries={["/scrum/tree"]}>
          <ScrumTreeView />
        </MemoryRouter>
      </ActiveProjectProvider>
    </QueryClientProvider>,
  );
}

function renderBoard(qc: QueryClient) {
  return render(
    <QueryClientProvider client={qc}>
      <ActiveProjectProvider>
        <MemoryRouter initialEntries={["/scrum/board"]}>
          <ScrumBoardView />
        </MemoryRouter>
      </ActiveProjectProvider>
    </QueryClientProvider>,
  );
}

// A representative legacy view (the board) must carry the active projectKey in
// its query key so a workspace switch caches under a fresh, non-colliding key —
// the same project-scoping the tree view applies. Cache distinctness across two
// keys is the assertion (matching the tree view's pattern); this describe does
// NOT own the happy-dom teardown — the `ScrumTreeView` block (which sorts last)
// owns the unregister.
describe("ScrumBoardView project-scoped query key", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/scrum/board");
    localStorage.clear();
    setActiveProjectKeyForRequests(null);
    installFetchMock();
  });
  afterEach(cleanup);

  test("board tasks cache under the active projectKey, distinct from another project's key", async () => {
    const tasks = [mkTask({ id: "a", title: "Repo A task", milestone_id: "m1" })];
    fetchStub = (url) =>
      url.startsWith("/api/scrum/tasks")
        ? { status: 200, body: { tasks } }
        : { status: 404, body: { error: "not found" } };

    window.history.replaceState(null, "", "/scrum/board?project=%2Fhome%2Fme%2Frepo-a");
    const qc = makeClient();
    const r = renderBoard(qc);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // The board's key is `["scrum","tasks",{},projectKey]`, scoped to repo-a.
    expect(qc.getQueryData(["scrum", "tasks", {}, "/home/me/repo-a"])).toBeDefined();
    // A different project's key is absent — distinct keys never collide.
    expect(qc.getQueryData(["scrum", "tasks", {}, "/home/me/repo-b"])).toBeUndefined();
    r.unmount();
  });
});

describe("ScrumTreeView", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/scrum/tree");
    localStorage.clear();
    setActiveProjectKeyForRequests(null);
    installFetchMock();
  });
  afterEach(cleanup);
  // This file sorts last among the DOM test files, so it owns the happy-dom
  // teardown — leaving the globals patched would break downstream non-DOM tests.
  afterAll(async () => {
    if (GlobalRegistrator.isRegistered) {
      await GlobalRegistrator.unregister();
    }
  });

  test("renders milestone groups with the nested containment tree", () => {
    const milestones = [mkMilestone("m1", "Alpha milestone")];
    const tasks = [
      mkTask({ id: "epic-1", title: "Login epic", layer: "epic", milestone_id: "m1" }),
      mkTask({ id: "story-1", title: "OAuth story", layer: "story", parent_id: "epic-1", milestone_id: "m1" }),
    ];
    fetchStub = (url) => {
      if (url.startsWith("/api/scrum/tasks")) return { status: 200, body: { tasks } };
      if (url.startsWith("/api/scrum/milestones")) return { status: 200, body: { milestones } };
      return { status: 404, body: { error: "not found" } };
    };
    const qc = makeClient();
    qc.setQueryData(["scrum", "tasks", "tree", null], { tasks });
    qc.setQueryData(["scrum", "milestones", "tree", null], { milestones });

    const r = renderTree(qc);
    expect(r.getByRole("heading", { name: /alpha milestone/i })).toBeDefined();
    expect(r.getByRole("button", { name: /login epic/i })).toBeDefined();
    expect(r.getByRole("button", { name: /oauth story/i })).toBeDefined();
  });

  test("expanding a task surfaces its active acceptance criteria, hiding superseded ones", () => {
    const milestones = [mkMilestone("m1", "Alpha")];
    const tasks = [
      mkTask({
        id: "story-1",
        title: "Story with AC",
        layer: "story",
        milestone_id: "m1",
        acceptance: {
          criteria: [
            mkCriterion({ id: "ac-1", text: "Build compiles clean", verifies_by: "bash" }),
            mkCriterion({
              id: "ac-old",
              text: "Retired criterion",
              status: "superseded",
            }),
          ],
        },
      }),
    ];
    fetchStub = (url) => {
      if (url.startsWith("/api/scrum/tasks")) return { status: 200, body: { tasks } };
      if (url.startsWith("/api/scrum/milestones")) return { status: 200, body: { milestones } };
      return { status: 404, body: { error: "not found" } };
    };
    const qc = makeClient();
    qc.setQueryData(["scrum", "tasks", "tree", null], { tasks });
    qc.setQueryData(["scrum", "milestones", "tree", null], { milestones });

    const r = renderTree(qc);
    // depth-0 node auto-expands, so the active criterion is shown immediately
    // and the superseded one is filtered out.
    expect(r.getByText(/build compiles clean/i)).toBeDefined();
    expect(r.queryByText(/retired criterion/i)).toBeNull();
  });

  test("query keys carry the active projectKey; switching the workspace caches under a fresh, non-colliding key", async () => {
    const milestones = [mkMilestone("m1", "Alpha")];
    const tasksA = [mkTask({ id: "a", title: "Repo A task", milestone_id: "m1" })];
    const tasksB = [mkTask({ id: "b", title: "Repo B task", milestone_id: "m1" })];
    fetchStub = (url) => {
      if (url.startsWith("/api/scrum/milestones")) return { status: 200, body: { milestones } };
      // The decoded projectKey lands as `%2Fhome%2Fme%2Frepo-<x>` on the wire,
      // so the `repo-a`/`repo-b` substring still distinguishes the two.
      if (url.startsWith("/api/scrum/tasks")) {
        const tasks = url.includes("repo-b") ? tasksB : tasksA;
        return { status: 200, body: { tasks } };
      }
      return { status: 404, body: { error: "not found" } };
    };

    // Repo A: seed its key via the URL so the provider broadcasts it, and run a
    // tasks fetch under it. Assert the query is cached under repo-a's key.
    window.history.replaceState(null, "", "/scrum/tree?project=%2Fhome%2Fme%2Frepo-a");
    const qcA = makeClient();
    const rA = renderTree(qcA);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(qcA.getQueryData(["scrum", "tasks", "tree", "/home/me/repo-a"])).toBeDefined();
    const repoAFetched = fetchCalls.some((u) => u.startsWith("/api/scrum/tasks"));
    expect(repoAFetched).toBe(true);
    rA.unmount();

    // Repo B: a distinct projectKey. Its tasks cache under repo-b's key — a key
    // distinct from repo-a's, so the per-project caches never collide.
    fetchCalls = [];
    setActiveProjectKeyForRequests("/home/me/repo-b");
    window.history.replaceState(null, "", "/scrum/tree?project=%2Fhome%2Fme%2Frepo-b");
    const qcB = makeClient();
    const rB = renderTree(qcB);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(qcB.getQueryData(["scrum", "tasks", "tree", "/home/me/repo-b"])).toBeDefined();
    // repo-a's key is absent from repo-b's client — distinct keys, no collision.
    expect(qcB.getQueryData(["scrum", "tasks", "tree", "/home/me/repo-a"])).toBeUndefined();
    expect(fetchCalls.some((u) => u.startsWith("/api/scrum/tasks") && u.includes("repo-b"))).toBe(true);
    rB.unmount();
  });
});
