/**
 * Active-project context tests. Covers the key-seeding precedence
 * (URL > localStorage > null), persistence on set, and consumer propagation.
 *
 * IMPORTANT: `../test/setup` MUST be the first import — it registers happy-dom
 * globals so `window`/`localStorage` exist before testing-library's module
 * init. Bun runs every test file in one shared process in filesystem-dependent
 * (unsorted) order, so this file owns its own DOM window:
 * `beforeAll(registerDom)` + `afterAll(unregisterDom)`; the teardown also
 * restores the native `fetch` so stubs installed here never leak into suites
 * that run after this file.
 */
import { registerDom, unregisterDom } from "../test/setup";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  ActiveProjectProvider,
  pathToProjectId,
  projectIdToPath,
  useActiveProject,
  type ProjectInfo,
} from "./active-project";
import { api } from "./api";
import { setActiveProjectKeyForRequests } from "./fetch-utils";

const STORAGE_KEY = "prove-review.active-project.v1";

function resetEnv(): void {
  window.history.replaceState(null, "", "/");
  localStorage.clear();
}

function wrap(project?: ProjectInfo | null) {
  return ({ children }: { children: ReactNode }) => (
    <ActiveProjectProvider project={project ?? null}>{children}</ActiveProjectProvider>
  );
}

beforeAll(registerDom);
afterAll(unregisterDom);

describe("ActiveProjectProvider", () => {
  beforeEach(resetEnv);
  afterEach(cleanup);

  test("defaults projectKey to null with no URL param and no storage", () => {
    const { result } = renderHook(() => useActiveProject(), { wrapper: wrap() });
    expect(result.current.projectKey).toBeNull();
    expect(result.current.project).toBeNull();
  });

  test("seeds projectKey from the ?project= URL param", () => {
    // URLSearchParams.get decodes once, so the percent-encoded `?project=` id
    // surfaces as the raw path key the data routes match against.
    window.history.replaceState(null, "", "/?project=%2Fhome%2Fme%2Frepo");
    const { result } = renderHook(() => useActiveProject(), { wrapper: wrap() });
    expect(result.current.projectKey).toBe("/home/me/repo");
  });

  test("seeds projectKey from localStorage when no URL param", () => {
    localStorage.setItem(STORAGE_KEY, "stored-key");
    const { result } = renderHook(() => useActiveProject(), { wrapper: wrap() });
    expect(result.current.projectKey).toBe("stored-key");
  });

  test("URL param wins over localStorage", () => {
    localStorage.setItem(STORAGE_KEY, "stored-key");
    window.history.replaceState(null, "", "/?project=url-key");
    const { result } = renderHook(() => useActiveProject(), { wrapper: wrap() });
    expect(result.current.projectKey).toBe("url-key");
  });

  test("setProjectKey updates consumers and persists to localStorage", () => {
    const { result } = renderHook(() => useActiveProject(), { wrapper: wrap() });
    act(() => result.current.setProjectKey("picked-key"));
    expect(result.current.projectKey).toBe("picked-key");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("picked-key");
  });

  test("setProjectKey(null) clears the persisted key", () => {
    localStorage.setItem(STORAGE_KEY, "stored-key");
    const { result } = renderHook(() => useActiveProject(), { wrapper: wrap() });
    expect(result.current.projectKey).toBe("stored-key");
    act(() => result.current.setProjectKey(null));
    expect(result.current.projectKey).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  test("exposes the externally-supplied project record", () => {
    const record: ProjectInfo = {
      id: "%2Fhome%2Fme%2Frepo",
      path: "/home/me/repo",
      name: "repo",
      last_seen: "2026-04-20T00:00:00.000Z",
      store: { schema_version: 12, behind: false },
    };
    const { result } = renderHook(() => useActiveProject(), { wrapper: wrap(record) });
    expect(result.current.project).toEqual(record);
  });

  test("useActiveProject throws outside the provider", () => {
    expect(() => renderHook(() => useActiveProject())).toThrow(
      /must be used within an ActiveProjectProvider/,
    );
  });
});

describe("decoded-path ↔ encoded-id chokepoint", () => {
  test("pathToProjectId / projectIdToPath round-trip a literal-% path", () => {
    // A path containing a literal `%` is the canonical encode/decode trap: a
    // missing or doubled conversion mangles it. The pair must be exact inverses.
    const path = "/home/me/100%-repo";
    const id = pathToProjectId(path);
    expect(id).toBe("%2Fhome%2Fme%2F100%25-repo");
    expect(projectIdToPath(id)).toBe(path);
  });
});

describe("projectKey wire-encoding contract", () => {
  let lastUrl = "";
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    resetEnv();
    lastUrl = "";
    globalThis.fetch = ((input: string | URL | Request) => {
      lastUrl = typeof input === "string" ? input : input.toString();
      return Promise.resolve(
        new Response('{"runs":[]}', { status: 200, headers: { "content-type": "application/json" } }),
      );
    }) as typeof fetch;
    setActiveProjectKeyForRequests(null);
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
    setActiveProjectKeyForRequests(null);
  });

  test("setProjectKey(decoded path) → wire URL carries the encoded-once form", async () => {
    // The provider broadcasts the DECODED path it was handed; the fetch funnel
    // encodes it exactly once. Feeding the decoded path (NOT ProjectInfo.id)
    // is what keeps the `?project=` param single-encoded.
    const { result } = renderHook(() => useActiveProject(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <ActiveProjectProvider>{children}</ActiveProjectProvider>
      ),
    });
    act(() => result.current.setProjectKey("/home/me/repo"));
    await api.runs();
    expect(lastUrl).toBe("/api/runs?project=%2Fhome%2Fme%2Frepo");
  });
});
