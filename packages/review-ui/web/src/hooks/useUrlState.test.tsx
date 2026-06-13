/**
 * useUrlState round-trips the diff `base` through the URL.
 *
 * Before this coverage `base` was dropped on serialize and hardcoded to 'main'
 * on restore, so a repo whose default branch is not 'main' (master, trunk, …)
 * showed an incorrect diff range after a refresh or on a shared link.
 *
 * happy-dom lifecycle: `../test/setup` MUST be the first import (see that file).
 */
import { registerDom, unregisterDom } from "../test/setup";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import { useUrlState } from "./useUrlState";
import { useSelection } from "../lib/store";

function Harness() {
  useUrlState();
  return null;
}

function resetEnv(): void {
  window.history.replaceState(null, "", "/");
  useSelection.setState({ slug: null, branch: null, base: null, reviewMode: false });
}

beforeAll(registerDom);
afterAll(unregisterDom);

describe("useUrlState base round-trip", () => {
  beforeEach(resetEnv);
  afterEach(cleanup);

  test("a non-main base is serialized into the URL", async () => {
    render(<Harness />);
    await act(async () => {
      useSelection.getState().selectRun("feature/x");
      useSelection.getState().selectBranch("orchestrator/x", "develop");
      // Let the store→URL subscription flush.
      await new Promise((r) => setTimeout(r, 0));
    });
    const params = new URLSearchParams(window.location.search);
    expect(params.get("branch")).toBe("orchestrator/x");
    expect(params.get("base")).toBe("develop");
  });

  test("the default 'main' base is omitted from the URL", async () => {
    render(<Harness />);
    await act(async () => {
      useSelection.getState().selectRun("feature/x");
      useSelection.getState().selectBranch("orchestrator/x", "main");
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(new URLSearchParams(window.location.search).has("base")).toBe(false);
  });

  test("a URL carrying ?base= restores that base on mount", () => {
    window.history.replaceState(null, "", "/?run=feature%2Fx&branch=orchestrator%2Fx&base=trunk");
    render(<Harness />);
    expect(useSelection.getState().base).toBe("trunk");
  });

  test("a URL with a branch but no ?base= restores the 'main' default", () => {
    window.history.replaceState(null, "", "/?run=feature%2Fx&branch=orchestrator%2Fx");
    render(<Harness />);
    expect(useSelection.getState().base).toBe("main");
  });
});
