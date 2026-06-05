/**
 * Tests for the detached-child server loader and boot guards.
 *
 * The load-bearing invariant: `loadServerModule()` reaches the review-ui server
 * through ONE string-literal dynamic import, so `bun build --compile` bundles
 * the server (and fastify) into the binary and a marketplace install — which
 * ships sources only, no `server/dist`, no `node_modules` — boots without
 * `Cannot find module` / `Cannot find package`. These tests run under `bun`
 * (the dev shape), where the same literal resolves off the source tree; the
 * happy-path test therefore proves the specifier resolves to the real server
 * module exposing both consumed entry points, and the error-path tests prove
 * the env-validation floor the parent's health poll depends on.
 */

import { describe, expect, test } from 'bun:test';
import {
  CHILD_PORT_ENV,
  CHILD_REPO_ROOT_ENV,
  CHILD_WEB_ROOT_ENV,
  loadServerModule,
  serveChild,
} from './serve-child';

describe('serve-child — server module loader', () => {
  test('loadServerModule resolves the real server module with both entry points', async () => {
    // Proves the string-literal specifier resolves to the server source: the CLI
    // consumes `startServer` (child boot) and `resolveWebRoot` (parent web-root
    // resolution), so both must be present and callable. (The server's own test
    // suite covers `resolveWebRoot`'s three-tier precedence in depth.)
    const mod = await loadServerModule();
    expect(typeof mod.startServer).toBe('function');
    expect(typeof mod.resolveWebRoot).toBe('function');
  });

  test('loadServerModule returns the same module instance on repeat load', async () => {
    // The literal dynamic import is module-cached, so the parent's web-root
    // resolution and the child's boot share one server instance rather than
    // re-evaluating the module (and its side-effect-free top level) twice.
    const a = await loadServerModule();
    const b = await loadServerModule();
    expect(a).toBe(b);
  });
});

describe('serve-child — boot env validation', () => {
  test('serveChild rejects when the repo-root env is unset', async () => {
    const env: NodeJS.ProcessEnv = {
      [CHILD_PORT_ENV]: '5174',
      [CHILD_WEB_ROOT_ENV]: '',
    };
    await expect(serveChild(env)).rejects.toThrow(CHILD_REPO_ROOT_ENV);
  });

  test('serveChild rejects when the port env is not a positive integer', async () => {
    const env: NodeJS.ProcessEnv = {
      [CHILD_REPO_ROOT_ENV]: '/tmp/some/repo',
      [CHILD_PORT_ENV]: 'not-a-port',
      [CHILD_WEB_ROOT_ENV]: '',
    };
    await expect(serveChild(env)).rejects.toThrow(CHILD_PORT_ENV);
  });
});
