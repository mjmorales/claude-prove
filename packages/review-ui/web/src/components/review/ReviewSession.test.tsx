/**
 * ACB review-session tests: project-scoped query keys, project-scoped verdict
 * POST + invalidation, and the distinct behind-schema 409 notice.
 *
 * IMPORTANT — happy-dom lifecycle. `../../test/setup` MUST be the first import
 * so happy-dom globals exist before testing-library mounts. Bun runs every test
 * file in one shared process and sorts by path; this file
 * (`components/review/ReviewSession.test.tsx`) sorts BEFORE
 * `routes/scrum/tree.test.tsx`, which is the alphabetically-last DOM file and
 * owns the final `afterAll` unregister. No other DOM file unregisters, so the
 * globals survive for every file ahead of the owner. `beforeAll` re-registers
 * defensively (idempotent via setup) in case an earlier file ever tears the
 * globals down. Do not import `screen` — its module-init binds `document.body`
 * too early under Bun's loader; use the `render()` return value instead.
 */
import "../../test/setup";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  ActiveProjectProvider,
  type ProjectInfo,
} from "../../lib/active-project";
import { setActiveProjectKeyForRequests } from "../../lib/fetch-utils";
import {
  isBehindSchemaError,
  type IntentsResponse,
  type GroupVerdictRecord,
} from "../../lib/api";
import { ReviewSession } from "./ReviewSession";
import { useSelection } from "../../lib/store";

const REPO: ProjectInfo = {
  id: "%2Fhome%2Fme%2Frepo-a",
  path: "/home/me/repo-a",
  name: "repo-a",
  last_seen: "2026-04-20T00:00:00.000Z",
  store: { schema_version: 12, behind: false },
};

const REPO_BEHIND: ProjectInfo = {
  id: "%2Fhome%2Fme%2Frepo-b",
  path: "/home/me/repo-b",
  name: "repo-b",
  last_seen: "2026-04-21T00:00:00.000Z",
  store: { schema_version: 9, behind: true },
};

const SLUG = "feature/login";

const INTENTS: IntentsResponse = {
  slug: SLUG,
  branches: ["orchestrator/login"],
  groups: [
    {
      id: "grp-1",
      title: "Add login",
      classification: "explicit",
      ambiguityTags: [],
      taskGrounding: "",
      files: ["src/auth.ts"],
      fileRefs: [],
      annotations: [],
      commits: [
        {
          sha: "abc123",
          shortSha: "abc123",
          branch: "orchestrator/login",
          subject: "feat: login",
          timestamp: "2026-06-01T00:00:00.000Z",
        },
      ],
    },
  ],
  negativeSpace: [],
  openQuestions: [],
  uncoveredFiles: [],
  orphanCommits: [],
  endBase: "base-sha",
  endHead: "head-sha",
};

const EMPTY_REVIEW = { slug: SLUG, verdicts: [] as GroupVerdictRecord[] };
const EMPTY_TASKS = { slug: SLUG, mode: "full" as const, tasks: [] };

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, staleTime: Infinity },
    },
  });
}

/** Seed the three review reads under the PROJECT-SCOPED keys the session uses,
 * so the queue renders synchronously with one ready intent and the verdict CTA
 * is reachable on first paint. */
function seedReviewCaches(qc: QueryClient, projectKey: string): void {
  qc.setQueryData(["intents", projectKey, SLUG], INTENTS);
  qc.setQueryData(["review", projectKey, SLUG], EMPTY_REVIEW);
  qc.setQueryData(["tasks", projectKey, SLUG], EMPTY_TASKS);
}

type FetchCall = { url: string; method: string; body: string | null };
let fetchCalls: FetchCall[] = [];
let postResponse: { status: number; body: unknown } = { status: 200, body: {} };

/** Record every fetch and reply with the configured POST response. Reads (GET)
 * resolve from the seeded cache, so they never hit here in the steady state. */
function installFetchMock(): void {
  fetchCalls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    const method = (init?.method ?? "GET").toUpperCase();
    fetchCalls.push({ url, method, body: (init?.body as string) ?? null });
    if (method === "POST") {
      const { status, body } = postResponse;
      return {
        ok: status >= 200 && status < 300,
        status,
        statusText: status === 200 ? "OK" : "ERR",
        json: async () => body,
        text: async () => JSON.stringify(body),
      } as Response;
    }
    return { ok: true, status: 200, statusText: "OK", json: async () => ({}) } as Response;
  }) as typeof fetch;
}

/** Drain pending microtasks/macrotasks so an awaited write handler (fetch →
 * .json() → invalidate) fully settles before assertions run. */
async function flushAsync(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function renderSession(project: ProjectInfo, qc: QueryClient) {
  return render(
    <QueryClientProvider client={qc}>
      <ActiveProjectProvider project={project}>
        <ReviewSession />
      </ActiveProjectProvider>
    </QueryClientProvider>,
  );
}

function resetEnv(): void {
  // Seed ?project= so the provider's projectKey resolves to REPO.path (the
  // funnel decodes once); the seeded caches above key off that same path.
  window.history.replaceState(null, "", `/?project=${REPO.id}`);
  localStorage.clear();
  setActiveProjectKeyForRequests(null);
  postResponse = { status: 200, body: {} };
  useSelection.setState({ slug: SLUG, reviewMode: true, activeIntentId: "grp-1" });
}

beforeAll(() => {
  // No earlier DOM file unregisters happy-dom, so globals normally survive into
  // this file; re-register defensively in case an earlier file tore them down.
  if (!GlobalRegistrator.isRegistered) {
    GlobalRegistrator.register({ url: "http://localhost/" });
  }
});

describe("ReviewSession project-scoped query keys", () => {
  beforeEach(() => {
    resetEnv();
    installFetchMock();
  });
  afterEach(cleanup);

  test("review reads key off [resource, projectKey, slug] so caches don't collide across projects", () => {
    const qc = makeClient();
    // Seed BOTH projects' review caches with the same composite slug but
    // distinct intent titles; the session must read its own project's entry.
    seedReviewCaches(qc, REPO.path);
    qc.setQueryData(["intents", REPO_BEHIND.path, SLUG], {
      ...INTENTS,
      groups: [{ ...INTENTS.groups[0], id: "grp-other", title: "Other project intent" }],
    });

    const r = renderSession(REPO, qc);
    // The active project (repo-a) renders its own intent, not repo-b's. The
    // title appears in both the queue list and the card heading, so assert on
    // presence (>=1) and the absence of the other project's intent entirely.
    expect(r.getAllByText("Add login").length).toBeGreaterThan(0);
    expect(r.queryAllByText("Other project intent")).toHaveLength(0);
    // Both per-project caches survive independently — distinct keys, no collision.
    expect(qc.getQueryData(["intents", REPO.path, SLUG])).toBeDefined();
    expect(qc.getQueryData(["intents", REPO_BEHIND.path, SLUG])).toBeDefined();
  });
});

describe("ReviewSession verdict write", () => {
  beforeEach(() => {
    resetEnv();
    installFetchMock();
  });
  afterEach(cleanup);

  test("a verdict POSTs to the project-scoped endpoint and success invalidates the project-namespaced review query", async () => {
    const qc = makeClient();
    seedReviewCaches(qc, REPO.path);

    // Capture the invalidation filter. Asserting the resulting `isInvalidated`
    // flag is racy: a mounted observer refetches on invalidate and the
    // successful refetch clears the flag before the assertion runs. The durable
    // contract is the KEY the handler invalidates, so record that instead.
    const invalidatedKeys: ReadonlyArray<unknown>[] = [];
    const realInvalidate = qc.invalidateQueries.bind(qc);
    qc.invalidateQueries = ((filters?: { queryKey?: ReadonlyArray<unknown> }) => {
      if (filters?.queryKey) invalidatedKeys.push(filters.queryKey);
      return realInvalidate(filters as never);
    }) as typeof qc.invalidateQueries;

    const r = renderSession(REPO, qc);

    const approve = r.getByRole("button", { name: /Approve/ });
    await act(async () => {
      approve.click();
      // Let the awaited postJSON (fetch → .json()) + invalidate microtasks
      // settle; several hops, so flush a few macrotasks to be safe.
      await flushAsync();
    });

    const post = fetchCalls.find((c) => c.method === "POST");
    expect(post).toBeDefined();
    // The fetch funnel injects ?project=<encoded path> on the verdict POST.
    expect(post!.url).toContain("/api/runs/");
    expect(post!.url).toContain("/verdict");
    expect(post!.url).toContain(`project=${REPO.id}`);

    // Success invalidates the project-namespaced review query — the key carries
    // projectKey + slug so the refetch re-pulls THIS project's verdicts.
    expect(invalidatedKeys).toContainEqual(["review", REPO.path, SLUG]);
  });
});

describe("ReviewSession behind-schema 409", () => {
  beforeEach(() => {
    resetEnv();
    installFetchMock();
  });
  afterEach(cleanup);

  test("a behind-schema 409 renders the distinct read-only notice, not a generic error", async () => {
    postResponse = {
      status: 409,
      body: {
        error: "store schema behind",
        project: "/home/me/repo-a",
        store: { schema_version: 9, behind: true },
      },
    };
    const qc = makeClient();
    seedReviewCaches(qc, REPO.path);
    // Use a NON-behind project record so the client gate leaves the CTA live
    // and the write reaches the wire — the server 409 is the floor under test.
    const r = renderSession(REPO, qc);

    const approve = r.getByRole("button", { name: /Approve/ });
    await act(async () => {
      approve.click();
      await flushAsync();
    });

    const notice = r.getByTestId("schema-blocked-notice");
    expect(notice.textContent?.toLowerCase()).toContain("read-only");
    expect(notice.textContent?.toLowerCase()).toContain("migrated");
    // The generic "Submit failed:" error line must NOT render for a 409.
    expect(r.queryByText(/Submit failed/i)).toBeNull();
  });
});

describe("isBehindSchemaError", () => {
  test("matches the postJSON-thrown 409 carrying the structured marker", () => {
    const err = new Error(
      '409 ERR: /api/runs/x/review/g/verdict — {"error":"store schema behind","project":"/r","store":{"schema_version":9,"behind":true}}',
    );
    expect(isBehindSchemaError(err)).toBe(true);
  });

  test("matches on the behind marker even without the error text", () => {
    const err = new Error('409 ERR: /api/x — {"store":{"behind":true}}');
    expect(isBehindSchemaError(err)).toBe(true);
  });

  test("does not match a non-409 status or a non-Error", () => {
    expect(isBehindSchemaError(new Error("404 ERR: /api/x — not found"))).toBe(false);
    expect(isBehindSchemaError(new Error("500 ERR: /api/x — store schema behind"))).toBe(false);
    expect(isBehindSchemaError("409 store schema behind")).toBe(false);
  });
});
