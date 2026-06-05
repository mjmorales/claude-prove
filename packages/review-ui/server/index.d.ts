/**
 * Public type surface of `@claude-prove/review-ui-server` as the CLI consumes
 * it. The CLI imports this package only through a runtime dynamic `import()`
 * (so `bun build --compile` bundles the server into the binary), and resolves
 * the result against its own local `ServerModule` interface via a cast — it
 * never needs the server's full implementation types.
 *
 * The `exports` map points tsc's `types` condition here while pointing bun's
 * runtime/compile condition at `src/index.ts`. That keeps the server's source
 * OUT of the CLI's strict tsconfig program (the server type-checks under its
 * own looser config), avoiding a cross-package strictness leak, while the
 * runtime/bundle still loads the real module.
 *
 * Declares only the two entry points the CLI calls. Keep this in sync with
 * `src/index.ts`'s `startServer`/`resolveWebRoot` signatures.
 */

import type { FastifyInstance } from "fastify";

export interface StartOptions {
  host: string;
  port: number;
  repoRoot: string;
  webRoot: string | null;
  registryBaseOverride?: string;
}

export declare function startServer(
  opts: StartOptions,
): Promise<{ app: FastifyInstance; host: string; port: number }>;

export declare function resolveWebRoot(
  embeddedAccessor?: () => string | null,
): string | null;

export declare function buildApp(opts: {
  repoRoot: string;
  webRoot: string | null;
  registryBaseOverride?: string;
}): Promise<FastifyInstance>;
