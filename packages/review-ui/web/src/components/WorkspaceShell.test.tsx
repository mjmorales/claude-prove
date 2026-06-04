/**
 * Shell tests for the workspace switcher + behind-schema banner/hook.
 *
 * IMPORTANT: `../test/setup` MUST be the first import — it registers happy-dom
 * globals so `window`/`document` exist before testing-library mounts.
 *
 * We deliberately do NOT unregister happy-dom in afterAll. Bun runs every test
 * file in one shared process; this file sorts before the final DOM test file,
 * which owns the teardown. Setup is idempotent on register.
 */
import "../test/setup";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  ActiveProjectProvider,
  type ProjectInfo,
  useActiveProject,
} from "../lib/active-project";
import { setActiveProjectKeyForRequests } from "../lib/fetch-utils";
import {
  BehindSchemaBanner,
  useWriteAffordancesDisabled,
} from "./BehindSchemaBanner";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import { GroupCard } from "./review/GroupCard";
import type { IntentGroupView } from "../lib/api";

const REPO_A: ProjectInfo = {
  id: "%2Fhome%2Fme%2Frepo-a",
  path: "/home/me/repo-a",
  name: "repo-a",
  last_seen: "2026-04-20T00:00:00.000Z",
  store: { schema_version: 12, behind: false },
};

const REPO_B_BEHIND: ProjectInfo = {
  id: "%2Fhome%2Fme%2Frepo-b",
  path: "/home/me/repo-b",
  name: "repo-b",
  last_seen: "2026-04-21T00:00:00.000Z",
  store: { schema_version: 9, behind: true },
};

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, staleTime: Infinity },
    },
  });
}

/** Seed the projects query so the switcher renders synchronously without an
 * async fetch round-trip. */
function clientWithProjects(projects: ProjectInfo[]): QueryClient {
  const qc = makeClient();
  qc.setQueryData(["projects"], { projects });
  return qc;
}

function resetEnv(): void {
  window.history.replaceState(null, "", "/");
  localStorage.clear();
  setActiveProjectKeyForRequests(null);
}

describe("WorkspaceSwitcher", () => {
  beforeEach(resetEnv);
  afterEach(cleanup);

  test("renders the stubbed project list when opened", () => {
    const qc = clientWithProjects([REPO_A, REPO_B_BEHIND]);
    const r = render(
      <QueryClientProvider client={qc}>
        <ActiveProjectProvider>
          <WorkspaceSwitcher />
        </ActiveProjectProvider>
      </QueryClientProvider>,
    );
    act(() => {
      r.getByRole("button", { name: /switch workspace/i }).click();
    });
    const options = r.getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      expect.stringContaining("repo-a"),
      expect.stringContaining("repo-b"),
    ]);
  });

  test("selecting a project calls setProjectKey with the DECODED path and re-highlights", () => {
    const qc = clientWithProjects([REPO_A, REPO_B_BEHIND]);
    let observedKey: string | null = "unset";
    function Probe() {
      observedKey = useActiveProject().projectKey;
      return null;
    }
    const r = render(
      <QueryClientProvider client={qc}>
        <ActiveProjectProvider>
          <Probe />
          <WorkspaceSwitcher />
        </ActiveProjectProvider>
      </QueryClientProvider>,
    );
    act(() => {
      r.getByRole("button", { name: /switch workspace/i }).click();
    });
    act(() => {
      // repo-b carries an encoded `id`; the switcher must broadcast its DECODED
      // `path`, never the encoded id, or the fetch funnel double-encodes.
      r.getByRole("option", { name: /repo-b/i }).click();
    });
    expect(observedKey).toBe("/home/me/repo-b");

    // Re-open: the active entry is now the selected one.
    act(() => {
      r.getByRole("button", { name: /switch workspace/i }).click();
    });
    const selected = r
      .getAllByRole("option")
      .filter((o) => o.getAttribute("aria-selected") === "true");
    expect(selected).toHaveLength(1);
    expect(selected[0]?.textContent).toContain("repo-b");
  });
});

describe("behind-schema banner + write-affordances hook", () => {
  beforeEach(resetEnv);
  afterEach(cleanup);

  function wrap(project: ProjectInfo | null) {
    return ({ children }: { children: ReactNode }) => (
      <ActiveProjectProvider project={project}>{children}</ActiveProjectProvider>
    );
  }

  test("a behind-schema project shows the banner and disables write affordances", () => {
    const r = render(
      <ActiveProjectProvider project={REPO_B_BEHIND}>
        <BehindSchemaBanner />
      </ActiveProjectProvider>,
    );
    const banner = r.getByRole("alert");
    expect(banner.textContent).toContain("repo-b");
    expect(banner.textContent?.toLowerCase()).toContain("read-only");

    const { result } = renderHook(() => useWriteAffordancesDisabled(), {
      wrapper: wrap(REPO_B_BEHIND),
    });
    expect(result.current).toBe(true);
  });

  test("an up-to-date project renders no banner and enables write affordances", () => {
    const r = render(
      <ActiveProjectProvider project={REPO_A}>
        <BehindSchemaBanner />
      </ActiveProjectProvider>,
    );
    expect(r.queryByRole("alert")).toBeNull();

    const { result } = renderHook(() => useWriteAffordancesDisabled(), {
      wrapper: wrap(REPO_A),
    });
    expect(result.current).toBe(false);
  });

  test("absent selection (startup-root default) renders no banner", () => {
    // localStorage cleared in beforeEach, so the provider seeds a null key and
    // no record — the startup-root default. No project means no banner.
    const r = render(
      <ActiveProjectProvider>
        <BehindSchemaBanner />
      </ActiveProjectProvider>,
    );
    expect(r.queryByRole("alert")).toBeNull();

    const { result } = renderHook(() => useWriteAffordancesDisabled(), {
      wrapper: wrap(null),
    });
    expect(result.current).toBe(false);
  });
});

const SAMPLE_GROUP: IntentGroupView = {
  id: "grp-1",
  title: "Add login",
  classification: "explicit",
  ambiguityTags: [],
  taskGrounding: "",
  files: [],
  fileRefs: [],
  annotations: [],
  commits: [],
};

/** Render the live verdict CTA strip under an active-project context. The CTAs
 * are the canonical ACB write controls — a behind-schema project must render
 * them disabled, a current-schema project must leave them clickable. */
function renderVerdictCtas(project: ProjectInfo | null) {
  return render(
    <ActiveProjectProvider project={project}>
      <GroupCard
        group={SAMPLE_GROUP}
        index={1}
        total={1}
        verdict="pending"
        note={null}
        slug="add-login"
        diffOpen={false}
        stampKey={0}
        endBase={null}
        endHead={null}
        onVerdict={() => {}}
        working={null}
        focused={false}
      />
    </ActiveProjectProvider>,
  );
}

describe("ACB write controls honor the schema-state gate", () => {
  beforeEach(resetEnv);
  afterEach(cleanup);

  test("a behind-schema project renders the verdict CTAs disabled", () => {
    const r = renderVerdictCtas(REPO_B_BEHIND);
    for (const label of ["Approve", "Reject", "Discuss", "Rework"]) {
      const btn = r.getByRole("button", { name: new RegExp(label) });
      expect((btn as HTMLButtonElement).disabled).toBe(true);
    }
  });

  test("a current-schema project leaves the verdict CTAs enabled", () => {
    const r = renderVerdictCtas(REPO_A);
    for (const label of ["Approve", "Reject", "Discuss", "Rework"]) {
      const btn = r.getByRole("button", { name: new RegExp(label) });
      expect((btn as HTMLButtonElement).disabled).toBe(false);
    }
  });
});
