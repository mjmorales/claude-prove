/**
 * Global-hygiene canary. Bun runs every test file in ONE shared process in
 * filesystem readdir order, so a DOM test file that leaks a patched global
 * (happy-dom registration, a `globalThis.fetch` stub, an `EventSource` stub)
 * silently corrupts whichever suite happens to run after it — failures then
 * appear on one platform only, because file order differs per filesystem.
 *
 * Every DOM test file owns `beforeAll(registerDom)` + `afterAll(unregisterDom)`
 * (see `setup.ts`), so BETWEEN any two test files the globals must be native.
 * Wherever bun's order places this file, these invariants must hold; a failure
 * here means some file that ran earlier leaked a global past its own afterAll.
 */
import { describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

describe("cross-file global hygiene", () => {
  test("happy-dom is not registered between test files", () => {
    expect(GlobalRegistrator.isRegistered).toBe(false);
    expect(typeof (globalThis as { document?: unknown }).document).toBe("undefined");
    expect(typeof (globalThis as { window?: unknown }).window).toBe("undefined");
  });

  test("no EventSource stub is installed between test files", () => {
    expect(typeof (globalThis as { EventSource?: unknown }).EventSource).toBe("undefined");
  });

  test("fetch is the real network implementation, not a leaked stub", async () => {
    // The native fetch REJECTS on a connection refusal; every fetch stub in
    // this repo resolves a synthetic Response (200 or 404) for any URL, so a
    // resolution here means a stub leaked. Port 1 on loopback is never bound.
    let resolved = false;
    try {
      await fetch("http://127.0.0.1:1/global-hygiene-probe");
      resolved = true;
    } catch {
      // expected: a connection-refused rejection from the real network stack
    }
    expect(resolved).toBe(false);
  });
});
