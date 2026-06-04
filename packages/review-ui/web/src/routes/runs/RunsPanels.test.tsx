/**
 * Project-scoped runs/briefs/decisions panel tests.
 *
 * IMPORTANT — happy-dom lifecycle. `../../test/setup` MUST be the first import
 * so happy-dom globals exist before testing-library mounts. Bun runs every test
 * file in one shared process and sorts by path; this file sorts AFTER every
 * other DOM test file (`routes/routes.test.tsx` included — `rou` < `run`), so it
 * is the last DOM file and is the SOLE owner of the final `afterAll` that
 * unregisters happy-dom. No other DOM file unregisters, so the globals survive
 * for every file ahead of this one. `beforeAll` re-registers defensively
 * (idempotent via setup) so the mounts here hold even if an earlier file ever
 * tears the globals down. Do not import `screen` — its module-init binds
 * `document.body` too early under Bun's loader; use the `render()` return value
 * instead.
 */
import "../../test/setup";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { ActiveProjectProvider, type ProjectInfo } from "../../lib/active-project";
import { setActiveProjectKeyForRequests } from "../../lib/fetch-utils";
import { RunsListPanel } from "./RunsListPanel";
import { RunDocsPanel } from "./RunDocsPanel";
import { BriefPanel } from "./BriefPanel";
import { RunDecisionsPanel } from "./RunDecisionsPanel";
import { useRunsSelection } from "./store";
import { renderDoc } from "../../lib/run-doc-render";

const REPO: ProjectInfo = {
  id: "%2Fhome%2Fme%2Frepo",
  path: "/home/me/repo",
  name: "repo",
  last_seen: "2026-04-20T00:00:00.000Z",
  store: { schema_version: 12, behind: false },
};

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, staleTime: Infinity },
    },
  });
}

type FetchStub = (url: string) => { status: number; body: unknown };
let fetchStub: FetchStub = () => ({ status: 404, body: { error: "not stubbed" } });

function installFetchMock() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
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

/** Mount a panel inside an active-project context + a query client whose cache
 * is seeded so reads resolve synchronously on first render. */
function renderPanel(node: ReactNode, qc: QueryClient) {
  return render(
    <QueryClientProvider client={qc}>
      <ActiveProjectProvider project={REPO}>{node}</ActiveProjectProvider>
    </QueryClientProvider>,
  );
}

function resetEnv(): void {
  // Seed the ?project= param so the provider's projectKey resolves to REPO.path
  // (URLSearchParams decodes once). The panels key their queries off this
  // projectKey, so the seeded caches below must match it.
  window.history.replaceState(null, "", `/?project=${REPO.id}`);
  localStorage.clear();
  setActiveProjectKeyForRequests(null);
  useRunsSelection.setState({ slug: null, tab: "docs", docView: "PLAN" });
}

beforeAll(() => {
  // No earlier DOM file unregisters happy-dom, so globals normally survive into
  // this file; re-register defensively in case an earlier file ever tears them
  // down. Idempotent on an already-registered global.
  if (!GlobalRegistrator.isRegistered) {
    GlobalRegistrator.register({ url: "http://localhost/" });
  }
});

describe("RunsListPanel", () => {
  beforeEach(() => {
    resetEnv();
    installFetchMock();
  });
  afterEach(cleanup);

  test("renders the project-scoped run list and selects a run", () => {
    const runs = {
      runs: [
        {
          branch: "feature",
          slug: "s6-panels",
          composite: "feature/s6-panels",
          orchestratorBranch: "orchestrator/s6-panels",
          baseline: null,
          worktree: null,
          hasPlan: true,
          hasPrd: true,
          hasState: true,
          mode: "full" as const,
          title: "Panels",
          progress: {
            runStatus: "running" as const,
            currentTask: "1",
            currentStep: "1.1",
            startedAt: "2026-06-04T00:00:00.000Z",
            updatedAt: "2026-06-04T00:00:00.000Z",
            endedAt: "",
          },
          lastActivity: "2026-06-04T00:00:00.000Z",
        },
      ],
    };
    const qc = makeClient();
    // projectKey is the DECODED path; the runs list query key carries it.
    qc.setQueryData(["runs", REPO.path], runs);
    const r = renderPanel(<RunsListPanel />, qc);

    const btn = r.getByRole("button", { name: /s6-panels/i });
    expect(btn).toBeDefined();
    btn.click();
    expect(useRunsSelection.getState().slug).toBe("feature/s6-panels");
  });

  test("the runs query key includes the active project path", () => {
    // The fetch funnel injects ?project=<encoded path>; assert the key carries
    // the decoded path so a project switch invalidates this cache, not another's.
    const qc = makeClient();
    qc.setQueryData(["runs", REPO.path], { runs: [] });
    const r = renderPanel(<RunsListPanel />, qc);
    expect(r.getByText(/no runs yet/i)).toBeDefined();
    const cached = qc.getQueryData(["runs", REPO.path]) as { runs: unknown[] } | undefined;
    expect(cached?.runs).toEqual([]);
  });
});

describe("RunDocsPanel", () => {
  beforeEach(() => {
    resetEnv();
    installFetchMock();
    useRunsSelection.setState({ slug: "feature/s6-panels", tab: "docs", docView: "PLAN" });
  });
  afterEach(cleanup);

  test("renders the selected run's plan doc + validator rollup against project-scoped keys", () => {
    const planJson = JSON.stringify({
      mode: "full",
      tasks: [{ id: "1", title: "Browser", wave: 1, deps: [], steps: [] }],
    });
    const tasks = {
      slug: "feature/s6-panels",
      mode: "full" as const,
      tasks: [
        {
          id: "1",
          title: "Browser",
          wave: 1,
          deps: [],
          description: "",
          acceptanceCriteria: [],
          status: "completed" as const,
          startedAt: "",
          endedAt: "",
          review: { verdict: "approved" as const, notes: "", reviewer: "", reviewedAt: "" },
          worktree: null,
          steps: [
            {
              id: "1.1",
              title: "list",
              description: "",
              acceptanceCriteria: [],
              status: "completed" as const,
              startedAt: "",
              endedAt: "",
              commitSha: "abc",
              haltReason: "",
              validatorSummary: {
                build: "pass" as const,
                lint: "pass" as const,
                test: "fail" as const,
                custom: "pending" as const,
                llm: "pending" as const,
              },
            },
          ],
        },
      ],
    };
    const qc = makeClient();
    // Doc probes key off [doc, projectKey, slug, file]; tasks off [tasks, projectKey, slug].
    qc.setQueryData(["doc", REPO.path, "feature/s6-panels", "plan.json"], {
      path: "p",
      content: planJson,
    });
    qc.setQueryData(["doc", REPO.path, "feature/s6-panels", "prd.json"], null);
    qc.setQueryData(["doc", REPO.path, "feature/s6-panels", "state.json"], null);
    qc.setQueryData(["tasks", REPO.path, "feature/s6-panels"], tasks);

    const r = renderPanel(<RunDocsPanel />, qc);
    // Plan body rendered through the shared Markdown component.
    expect(r.getByText(/Task 1: Browser/i)).toBeDefined();
    // Validator rollup tallies a failing test phase.
    expect(r.getByText(/VALIDATORS/i)).toBeDefined();
  });
});

describe("BriefPanel", () => {
  beforeEach(() => {
    resetEnv();
    installFetchMock();
    useRunsSelection.setState({ slug: "feature/s6-panels", tab: "brief", docView: "PLAN" });
  });
  afterEach(cleanup);

  test("renders the PRD narrative markdown and states the brief endpoint gap", () => {
    const prdJson = JSON.stringify({
      title: "Panels brief",
      context: "Fill the runs/briefs/decisions slots.",
    });
    const qc = makeClient();
    qc.setQueryData(["doc", REPO.path, "feature/s6-panels", "prd.json"], {
      path: "p",
      content: prdJson,
    });
    const r = renderPanel(<BriefPanel />, qc);
    expect(r.getByText(/Panels brief/i)).toBeDefined();
    // The endpoint gap must be surfaced in the UI, not silently hidden.
    expect(r.getByText(/no synthesized reasoning brief/i)).toBeDefined();
  });
});

describe("RunDecisionsPanel", () => {
  beforeEach(() => {
    resetEnv();
    installFetchMock();
    useRunsSelection.setState({ slug: "feature/s6-panels", tab: "decisions", docView: "PLAN" });
  });
  afterEach(cleanup);

  test("renders the referenced + archive decision groups under project-scoped keys", () => {
    const decisions = {
      slug: "feature/s6-panels",
      referenced: [{ id: "d-1", title: "Use project-scoped keys", path: "p1", date: "2026-06-04" }],
      all: [
        { id: "d-1", title: "Use project-scoped keys", path: "p1", date: "2026-06-04" },
        { id: "d-2", title: "Document the brief gap", path: "p2", date: "2026-06-03" },
      ],
    };
    const qc = makeClient();
    qc.setQueryData(["decisions", REPO.path, "feature/s6-panels"], decisions);
    const r = renderPanel(<RunDecisionsPanel />, qc);
    expect(r.getByText(/REFERENCED BY RUN/i)).toBeDefined();
    expect(r.getByText(/Use project-scoped keys/i)).toBeDefined();
    expect(r.getByText(/Document the brief gap/i)).toBeDefined();
  });
});

describe("renderDoc", () => {
  test("renders a PRD title/context as markdown headings", () => {
    const out = renderDoc(JSON.stringify({ title: "T", context: "C" }), "PRD");
    expect(out).toContain("# T");
    expect(out).toContain("## Context");
  });

  test("falls back to a fenced block on unparseable JSON", () => {
    const out = renderDoc("not json", "STATE");
    expect(out).toContain("```");
    expect(out).toContain("not json");
  });
});

// This file is the last-sorting DOM test file; own the happy-dom teardown so
// later non-DOM tests in the shared Bun process don't inherit patched globals.
afterAll(async () => {
  if (GlobalRegistrator.isRegistered) {
    await GlobalRegistrator.unregister();
  }
});
