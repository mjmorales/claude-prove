/**
 * happy-dom lifecycle for DOM test files.
 *
 * Bun runs every test file in ONE shared process, in filesystem readdir order
 * — NOT sorted by path — so no file can know whether another DOM file runs
 * before or after it. Ordering conventions ("the last file owns teardown")
 * are unsound; each DOM test file owns its own lifecycle instead:
 *
 *   import { registerDom, unregisterDom } from "../test/setup";
 *   beforeAll(registerDom);
 *   afterAll(unregisterDom);
 *
 * This module MUST stay the first import of every DOM test file: importing it
 * registers happy-dom immediately, so module-init code in transitively loaded
 * libraries (e.g. @testing-library/react) sees `window`/`document` the first
 * time it loads. Registration is idempotent.
 *
 * `unregisterDom` restores the pre-DOM globals and pins `fetch` back to the
 * runtime-native implementation. Test files stub `globalThis.fetch` per test;
 * without the restore, whichever DOM file happened to run last would leak its
 * stub into every suite after it — a stub that answers (or 404s) every URL
 * silently corrupts any later test performing real HTTP.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// The runtime-native fetch, captured before the first happy-dom registration.
const nativeFetch = globalThis.fetch;

/** Register happy-dom globals (idempotent). Call from `beforeAll`. */
export function registerDom(): void {
  if (!GlobalRegistrator.isRegistered) {
    GlobalRegistrator.register({ url: "http://localhost/" });
  }
}

/**
 * Unregister happy-dom and restore the native `fetch`. Call from `afterAll`
 * so no DOM global — nor any fetch stub a test installed — outlives the file.
 */
export async function unregisterDom(): Promise<void> {
  if (GlobalRegistrator.isRegistered) {
    await GlobalRegistrator.unregister();
  }
  globalThis.fetch = nativeFetch;
}

registerDom();
