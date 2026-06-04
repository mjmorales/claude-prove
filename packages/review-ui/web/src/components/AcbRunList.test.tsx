/**
 * Project-scoped ACB-surface run-list tests.
 *
 * Proves the workspace-switch refetch behavior: RunList (the ACB sidebar list)
 * keys its runs query off `["runs", projectKey]`, so a `?project=` switch
 * resolves a DIFFERENT cache entry rather than serving the prior project's runs.
 * A flat `["runs"]` key would collapse both projects into one entry, so the
 * fetch funnel's per-request `?project=` injection would never fire a refetch.
 *
 * IMPORTANT — happy-dom lifecycle. `../test/setup` MUST be the first import so
 * happy-dom globals exist before testing-library mounts. Bun runs every test
 * file in one shared process and sorts by path; a later DOM file owns the final
 * `afterAll` that unregisters happy-dom, so `beforeAll` re-registers defensively
 * (idempotent via setup). Do not import `screen` — its module-init binds
 * `document.body` too early under Bun's loader; use the `render()` return value.
 */
import "../test/setup";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { ActiveProjectProvider, type ProjectInfo } from "../lib/active-project";
import { setActiveProjectKeyForRequests } from "../lib/fetch-utils";
import { RunList } from "./RunList";
import { useSelection } from "../lib/store";
import type { RunSummary } from "../lib/api";

const REPO_A: ProjectInfo = {
  id: "%2Fhome%2Fme%2Frepo-a",
  path: "/home/me/repo-a",
  name: "repo-a",
  last_seen: "2026-04-20T00:00:00.000Z",
  store: { schema_version: 12, behind: false },
};

const REPO_B: ProjectInfo = {
  id: "%2Fhome%2Fme%2Frepo-b",
  path: "/home/me/repo-b",
  name: "repo-b",
  last_seen: "2026-04-20T00:00:00.000Z",
  store: { schema_version: 12, behind: false },
};

function makeRun(branch: string, slug: string): RunSummary {
  return {
    branch,
    slug,
    composite: `${branch}/${slug}`,
    orchestratorBranch: `orchestrator/${slug}`,
    baseline: null,
    worktree: null,
    hasPlan: true,
    hasPrd: true,
    hasState: true,
    mode: "full",
    title: slug,
    progress: {
      runStatus: "running",
      currentTask: "1",
      currentStep: "1.1",
      startedAt: "2026-06-04T00:00:00.000Z",
      updatedAt: "2026-06-04T00:00:00.000Z",
      endedAt: "",
    },
    lastActivity: "2026-06-04T00:00:00.000Z",
  };
}

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, staleTime: Infinity },
    },
  });
}

/** A fetch mock so a cache miss resolves to an empty list rather than a real
 * network call — keeps the "distinct entry" assertions about the seeded caches,
 * not about an accidental fetch. */
function installFetchMock() {
  globalThis.fetch = (async (_input: RequestInfo | URL) =>
    ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ runs: [] }),
    }) as Response) as unknown as typeof fetch;
}

/** Mount RunList inside the active-project context for `project` + a query
 * client whose cache is seeded so reads resolve synchronously on first render. */
function renderRunList(project: ProjectInfo, qc: QueryClient) {
  return render(
    <QueryClientProvider client={qc}>
      <ActiveProjectProvider project={project}>
        <RunList />
      </ActiveProjectProvider>
    </QueryClientProvider>,
  );
}

/** Point the provider's seeded projectKey at `project` via the ?project= param
 * (URLSearchParams decodes once, so projectKey resolves to `project.path`). */
function seedActiveProject(project: ProjectInfo): void {
  window.history.replaceState(null, "", `/?project=${project.id}`);
  localStorage.clear();
  setActiveProjectKeyForRequests(null);
  useSelection.setState({ slug: null });
}

beforeAll(() => {
  if (!GlobalRegistrator.isRegistered) {
    GlobalRegistrator.register({ url: "http://localhost/" });
  }
});

describe("RunList — ACB surface", () => {
  beforeEach(() => {
    installFetchMock();
  });
  afterEach(cleanup);

  test("reads the runs cache under the active project path key", () => {
    seedActiveProject(REPO_A);
    const qc = makeClient();
    qc.setQueryData(["runs", REPO_A.path], { runs: [makeRun("feature", "alpha")] });

    const r = renderRunList(REPO_A, qc);
    expect(r.getByText("alpha")).toBeDefined();
  });

  test("two projectKeys produce distinct cache entries — the switch-refetch proof", () => {
    const qc = makeClient();
    // Each project's runs live under its own [runs, projectKey] entry; a flat
    // ["runs"] key would collapse both into one and serve the wrong project.
    qc.setQueryData(["runs", REPO_A.path], { runs: [makeRun("feature", "alpha")] });
    qc.setQueryData(["runs", REPO_B.path], { runs: [makeRun("feature", "beta")] });

    seedActiveProject(REPO_A);
    const a = renderRunList(REPO_A, qc);
    expect(a.getByText("alpha")).toBeDefined();
    expect(a.queryByText("beta")).toBeNull();
    cleanup();

    seedActiveProject(REPO_B);
    const b = renderRunList(REPO_B, qc);
    expect(b.getByText("beta")).toBeDefined();
    expect(b.queryByText("alpha")).toBeNull();

    // Both caches survive independently — the proof that a switch lands on a
    // separate entry rather than overwriting a shared flat key.
    const cachedA = qc.getQueryData(["runs", REPO_A.path]) as { runs: RunSummary[] };
    const cachedB = qc.getQueryData(["runs", REPO_B.path]) as { runs: RunSummary[] };
    expect(cachedA.runs[0].slug).toBe("alpha");
    expect(cachedB.runs[0].slug).toBe("beta");
  });
});
