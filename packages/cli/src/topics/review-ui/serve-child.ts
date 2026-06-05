/**
 * Detached-child entry that boots the review-ui Fastify server in-process.
 *
 * The parent CLI process spawns this body (either `bun <thisFile>` in dev or
 * the compiled binary re-invoked with the hidden `review-ui serve __child`
 * flag). It never inherits ambient resolution: the parent threads every input
 * — repo root, port, and the already-resolved web root — through env vars it
 * sets explicitly, because a detached child does NOT inherit
 * `CLAUDE_PROVE_PLUGIN_DIR` (that lives in the Claude Code session's
 * `.claude/settings.local.json` env block, which only the parent reads). So
 * the child trusts the values it is handed rather than re-resolving them.
 *
 * The server lives in `@claude-prove/review-ui-server`, which itself depends on
 * `@claude-prove/cli`. A STATIC top-level import would create a tsc build cycle
 * (CLI → server → CLI). The child therefore reaches the server through a single
 * runtime dynamic `import()` of the STRING-LITERAL package specifier
 * `@claude-prove/review-ui-server`. The literal is the load-bearing detail:
 * `bun build --compile` statically traces literal dynamic-import specifiers and
 * bakes the resolved module — plus its whole transitive dependency tree
 * (fastify, @fastify/*, simple-git, chokidar) — into the compiled binary's
 * virtual filesystem. The package's `exports` map points at its source entry,
 * so the same specifier resolves to the server source under `bun run`/`tsx`
 * from a checkout and to the bundled graph inside a compiled binary. One
 * specifier serves both shapes: no plugin-dir path arithmetic, no
 * `server/dist/index.js` that a sources-only marketplace clone never ships, and
 * no bare `require('fastify')` against a clone that has no `node_modules`.
 *
 * Binds 127.0.0.1 ONLY: the review UI executes git against the operator's repo,
 * so the listener must never be reachable off the loopback interface.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runningFromCompiledBinary } from '@claude-prove/installer/detect-mode';

/** Env keys the parent sets on the detached child; read here verbatim. */
export const CHILD_REPO_ROOT_ENV = 'PROVE_REVIEW_UI_REPO_ROOT';
export const CHILD_PORT_ENV = 'PROVE_REVIEW_UI_PORT';
export const CHILD_WEB_ROOT_ENV = 'PROVE_REVIEW_UI_WEB_ROOT';

/** The child always binds loopback — never an externally reachable interface. */
const CHILD_HOST = '127.0.0.1';

/**
 * Shape of the server entry module both the child boot path and the parent's
 * web-root resolution consume. Declared locally (and cast at the import site)
 * so the CLI's tsc graph carries no hard type edge to the server package —
 * which would reintroduce the CLI → server → CLI cycle the dynamic import
 * exists to avoid.
 */
export interface ServerModule {
  startServer(opts: {
    host: string;
    port: number;
    repoRoot: string;
    webRoot: string | null;
  }): Promise<unknown>;
  resolveWebRoot(): string | null;
}

/**
 * Load the review-ui server entry module.
 *
 * The specifier MUST stay a string literal: `bun build --compile` only traces
 * and bundles literal dynamic-import targets, so a computed path would leave the
 * server (and fastify) out of the binary and the marketplace install would fail
 * with `Cannot find module` / `Cannot find package 'fastify'`. Using the package
 * name (resolved to source via the server package's `exports` map) keeps the
 * CLI's strict tsconfig from pulling the server source into its own program —
 * the package boundary type-checks the server under its own config — while bun
 * resolves the identical specifier to the bundled graph in a compiled binary.
 *
 * Wraps the import so a missing/broken bundle surfaces an actionable error
 * (e.g. a binary compiled without the server traced in) instead of a raw
 * module-resolution stack.
 */
export async function loadServerModule(): Promise<ServerModule> {
  try {
    return (await import('@claude-prove/review-ui-server')) as unknown as ServerModule;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const shape = runningFromCompiledBinary()
      ? 'this compiled binary was built without the review-ui server bundled in'
      : 'the review-ui server source is not present in this checkout';
    throw new Error(`review-ui serve: cannot load the embedded server (${shape}): ${detail}`);
  }
}

/**
 * Boot the server from the explicitly-threaded env. Returns once the socket is
 * bound; the process then stays alive serving the long-lived listener. Throws
 * on a missing repo root or unparseable port so the parent's health poll fails
 * fast and surfaces the recorded log.
 */
export async function serveChild(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const repoRoot = env[CHILD_REPO_ROOT_ENV];
  if (!repoRoot) {
    throw new Error(`${CHILD_REPO_ROOT_ENV} is required but unset`);
  }
  const port = Number.parseInt(env[CHILD_PORT_ENV] ?? '', 10);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`${CHILD_PORT_ENV} must be a positive integer, got '${env[CHILD_PORT_ENV]}'`);
  }
  // Empty string is the explicit "API-only, no web root" signal the parent
  // sends when resolveWebRoot() returned null — distinct from a real path.
  const webRootRaw = env[CHILD_WEB_ROOT_ENV];
  const webRoot = webRootRaw && webRootRaw.length > 0 ? webRootRaw : null;

  const mod = await loadServerModule();
  await mod.startServer({ host: CHILD_HOST, port, repoRoot, webRoot });
}

/**
 * True when this module is the process entrypoint — i.e. the dev-mode parent
 * spawned `bun <this file>`. Importing the module (the compiled-mode topic
 * dispatch path) triggers no boot side effect.
 *
 * A compiled binary must short-circuit to false BEFORE the path comparison: a
 * Bun standalone executable maps argv[1] AND every bundled module's
 * `import.meta.url` to the same bunfs virtual entry, so the identity check is
 * vacuously true for every invocation of the binary — `claude-prove --version`
 * included — and the boot throws on the missing child env. The compiled child
 * never enters here anyway; the parent re-invokes the binary with the hidden
 * `review-ui serve __child` token, which dispatches to `serveChild()` through
 * the topic.
 */
function isMain(): boolean {
  if (runningFromCompiledBinary()) return false;
  const entry = process.argv[1];
  if (!entry) return false;
  return resolve(entry) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  serveChild().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
