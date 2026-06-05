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
 * `@claude-prove/cli` — a static import here would be a build cycle. The child
 * therefore reaches the server through a runtime dynamic `import()` of the
 * server entry module resolved off the plugin root, keeping the CLI free of any
 * compile-time edge to the server package.
 *
 * Binds 127.0.0.1 ONLY: the review UI executes git against the operator's repo,
 * so the listener must never be reachable off the loopback interface.
 */

import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { detectMode, runningFromCompiledBinary } from '@claude-prove/installer/detect-mode';
import { resolvePluginRoot } from '@claude-prove/installer/plugin-root';

/** Env keys the parent sets on the detached child; read here verbatim. */
export const CHILD_REPO_ROOT_ENV = 'PROVE_REVIEW_UI_REPO_ROOT';
export const CHILD_PORT_ENV = 'PROVE_REVIEW_UI_PORT';
export const CHILD_WEB_ROOT_ENV = 'PROVE_REVIEW_UI_WEB_ROOT';

/** The child always binds loopback — never an externally reachable interface. */
const CHILD_HOST = '127.0.0.1';

/** Shape of the server entry module the child dynamically imports. */
interface ServerModule {
  startServer(opts: {
    host: string;
    port: number;
    repoRoot: string;
    webRoot: string | null;
  }): Promise<unknown>;
}

/**
 * Resolve the server entry module path.
 *
 * Dev mode loads the TypeScript source resolved RELATIVE TO THIS MODULE's own
 * location (`.../packages/cli/src/topics/review-ui/` → `.../packages/review-ui/
 * server/src/index.ts`), not off the plugin root. That guarantees the CLI and
 * the server come from the same checkout even when `CLAUDE_PROVE_PLUGIN_DIR`
 * points at a different working tree — a static import would couple their
 * builds (the server depends on the CLI), so the runtime path must.
 *
 * Compiled mode loads the built `dist/index.js` off the plugin root, because a
 * Bun standalone binary bundles the CLI from a virtual filesystem and cannot
 * resolve a sibling source tree relative to its own bundled module URL.
 */
export function serverEntryPath(pluginRoot: string): string {
  if (detectMode(pluginRoot) === 'dev') {
    const here = fileURLToPath(import.meta.url);
    // serve-child.ts → review-ui → topics → src → cli → packages (five up).
    const packagesDir = resolve(here, '..', '..', '..', '..', '..');
    return join(packagesDir, 'review-ui', 'server', 'src', 'index.ts');
  }
  return join(pluginRoot, 'packages', 'review-ui', 'server', 'dist', 'index.js');
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

  const entry = serverEntryPath(resolvePluginRoot());
  const mod = (await import(pathToFileURL(entry).href)) as ServerModule;
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
