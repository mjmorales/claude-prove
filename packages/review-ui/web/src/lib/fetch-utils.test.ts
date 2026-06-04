/**
 * Project-key injection tests for the single fetch funnel. Stubs the global
 * `fetch` and captures the URL each helper resolves, asserting that the active
 * key set via `setActiveProjectKeyForRequests` lands on both an api.ts and a
 * scrumApi.ts URL — the proof that injection is single-sourced in fetch-utils
 * and not repeated per-route.
 *
 * No happy-dom: these tests only need a stubbed `fetch`, so they stay DOM-free
 * and own none of the shared-process happy-dom teardown the *.test.tsx files
 * coordinate (the alphabetically-last DOM test file owns unregister).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { api } from "./api";
import { getJSON, setActiveProjectKeyForRequests } from "./fetch-utils";
import { scrumApi } from "./scrumApi";

let lastUrl = "";
const originalFetch = globalThis.fetch;

function stubFetch(): void {
  globalThis.fetch = ((input: string | URL | Request) => {
    lastUrl = typeof input === "string" ? input : input.toString();
    return Promise.resolve(
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    );
  }) as typeof fetch;
}

describe("project-key injection in the fetch funnel", () => {
  beforeEach(() => {
    lastUrl = "";
    stubFetch();
    setActiveProjectKeyForRequests(null);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    setActiveProjectKeyForRequests(null);
  });

  test("appends the active key to an api.ts URL", async () => {
    // The provider broadcasts the decoded path (URLSearchParams.get decodes the
    // `?project=` seed once); the funnel re-encodes it on the way out.
    setActiveProjectKeyForRequests("/home/me/repo");
    await api.runs();
    expect(lastUrl).toBe("/api/runs?project=%2Fhome%2Fme%2Frepo");
  });

  test("appends the active key to a scrumApi.ts URL", async () => {
    setActiveProjectKeyForRequests("repo-key");
    await scrumApi.alerts();
    expect(lastUrl).toBe("/api/scrum/alerts?project=repo-key");
  });

  test("null key appends no project param", async () => {
    setActiveProjectKeyForRequests(null);
    await api.runs();
    expect(lastUrl).toBe("/api/runs");
  });

  test("merges the project param into a pre-existing query string", async () => {
    setActiveProjectKeyForRequests("repo-key");
    await scrumApi.recentEvents(5);
    expect(lastUrl).toBe("/api/scrum/events/recent?limit=5&project=repo-key");
  });

  test("does not double-append when a caller already passed a project param", async () => {
    setActiveProjectKeyForRequests("active-key");
    // A caller-passed `project` param wins — the funnel leaves the URL untouched
    // rather than appending the active key a second time.
    await getJSON("/api/runs?project=caller-key");
    expect(lastUrl).toBe("/api/runs?project=caller-key");
  });

  test("api.projects hits /api/projects", async () => {
    setActiveProjectKeyForRequests(null);
    await api.projects();
    expect(lastUrl).toBe("/api/projects");
  });
});
