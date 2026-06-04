# @claude-prove/review-ui

Monorepo home of the prove review UI. `packages/review-ui/server`
and `packages/review-ui/web` are leaf bun workspaces hoisted into the root
`node_modules`; `@claude-prove/store` (`bun:sqlite`) backs storage. The server
launches in-process under the native daemon (`claude-prove review-ui serve`) —
a detached loopback Bun process — not as a container.

## Dev flow (bun workspaces)

Install once from the repo root — never inside `packages/review-ui/` — so
bun can hoist shared deps (fastify, react, `@claude-prove/*`, …) into the
root `node_modules`:

```bash
bun install
```

Run server + web together with live reload:

```bash
cd packages/review-ui
bun run dev        # concurrently runs server (tsx watch) + web (vite)
```

Per-subpackage dev loops are also available:

```bash
cd packages/review-ui/server && bun run dev   # tsx watch src/index.ts
cd packages/review-ui/web    && bun run dev   # vite
```

Production build + serve:

```bash
cd packages/review-ui
bun run build      # server: tsc -p tsconfig.json; web: tsc -b && vite build
bun run start      # server: bun run src/index.ts (in-process under Bun)
```

The server runs under Bun in both dev and production — `start` executes the
TypeScript entry directly (`bun run src/index.ts`); `bun:sqlite` powers
storage. `build` (`tsc -p tsconfig.json`) produces the `dist/index.js` the
compiled `claude-prove` binary loads off the plugin root. The web side uses
`vite` + `@vitejs/plugin-react`.

Workspace imports resolve through bun's dep graph — the server pulls
`@claude-prove/store` for SQLite access without any nested `node_modules`
inside `packages/review-ui/server/`.

## Usage (`/prove:review-ui`)

The `/prove:review-ui` slash command is the supported user-facing entry
point. It drives the in-process daemon — `claude-prove review-ui serve` starts,
stops, queries, and restarts a detached loopback Bun server whose pidfile and
log live under `~/.claude-prove/review-ui/` — then opens the browser. No
container, registry pull, or bind-mount is involved; the server reads the repo
directly from disk.

## Web routes

The web shell uses `react-router-dom` with two top-level routes:

- `/acb/*` — existing ACB review flows (runs list, diff viewer, verdict
  controls)
- `/scrum` — phase-12 placeholder

## TypeScript

`packages/review-ui/tsconfig.json` is a composite project referenced by
the root `tsconfig.json`, but it intentionally includes only
`_placeholder.ts`. `server/` and `web/` keep their own non-composite
`tsconfig.json` files and are type-checked via their own build scripts.
Consolidating everything into the monorepo `tsc --build` graph is deferred.
