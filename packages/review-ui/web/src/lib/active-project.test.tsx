/**
 * Active-project context tests. Covers the key-seeding precedence
 * (URL > localStorage > null), persistence on set, and consumer propagation.
 *
 * IMPORTANT: `../test/setup` MUST be the first import — it registers happy-dom
 * globals so `window`/`localStorage` exist before testing-library mounts.
 *
 * We deliberately do NOT unregister happy-dom in afterAll. Bun runs every test
 * file in one shared process; unregistering here would tear `window` out from
 * under the other DOM test files still pending in the same run. Setup is
 * idempotent on register, so the final DOM test file owns the teardown.
 */
import "../test/setup";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  ActiveProjectProvider,
  useActiveProject,
  type ProjectInfo,
} from "./active-project";

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
