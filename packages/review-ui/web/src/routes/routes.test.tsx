/**
 * Routing smoke tests. Covers the three cases called out in the task:
 *   1. `/` redirects into `/acb` and renders the ACB surface.
 *   2. `/scrum` renders the ScrumRoute placeholder.
 *   3. `/acb?run=chore%2Ffoo` hydrates the selection store via useUrlState.
 *
 * IMPORTANT: `../test/setup` MUST be the first import — it registers
 * happy-dom globals so that `document` / `window` exist by the time React +
 * testing-library mount. We intentionally DO NOT import `screen` from
 * `@testing-library/react`: its module-init captures `document.body` too
 * early under Bun's test loader and binds to an error-throwing stub. Instead
 * we use the `render()` return value, which constructs queries lazily via
 * `within(container.parentNode)`.
 *
 * We render a *miniature* router configuration rather than the real `<App/>`
 * so we don't have to mock every downstream API call the real ACB components
 * make. The thing we're validating is the route configuration's shape plus
 * the fact that `useUrlState` keeps working when mounted inside `/acb/*`.
 */
import "../test/setup";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter, Navigate, Route, Routes } from "react-router-dom";
import { useUrlState } from "../hooks/useUrlState";
import { useSelection } from "../lib/store";
import { ScrumRoute } from "./scrum";

/** Minimal ACB stub that proves `useUrlState` runs inside the route. */
function AcbStub() {
  useUrlState();
  const slug = useSelection((s) => s.slug);
  return <div data-testid="acb-surface">acb:{slug ?? "none"}</div>;
}

function AppStub() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/acb" replace />} />
      <Route path="/acb/*" element={<AcbStub />} />
      <Route path="/scrum" element={<ScrumRoute />} />
    </Routes>
  );
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
}

describe("App routes", () => {
  beforeEach(() => {
    resetSelection();
    // Clear any residual query string between tests — useUrlState reads
    // window.location.search on mount.
    window.history.replaceState(null, "", "/");
  });
  afterEach(() => {
    cleanup();
  });
  // Undo happy-dom globals after this file's tests finish. Bun runs all test
  // files in one process, so leaving `document`/`Blob`/etc. patched would
  // break downstream non-DOM tests (e.g. those that pass a Node Blob to
  // Bun.spawn as stdin).
  afterAll(async () => {
    if (GlobalRegistrator.isRegistered) {
      await GlobalRegistrator.unregister();
    }
  });

  test("/ redirects to /acb and renders the ACB surface", () => {
    const r = render(
      <MemoryRouter initialEntries={["/"]}>
        <AppStub />
      </MemoryRouter>,
    );
    expect(r.getByTestId("acb-surface")).toBeDefined();
  });

  test("/scrum renders the scrum placeholder with a link to the decision doc", () => {
    const r = render(
      <MemoryRouter initialEntries={["/scrum"]}>
        <AppStub />
      </MemoryRouter>,
    );
    expect(r.getByRole("heading", { name: /scrum dashboard/i })).toBeDefined();
    const link = r.getByRole("link", { name: /scrum architecture/i }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toContain("2026-04-21-scrum-architecture.md");
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
