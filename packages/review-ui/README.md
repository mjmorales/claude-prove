# @claude-prove/review-ui

Monorepo home of the prove review UI (phase 11). `packages/review-ui/server`
and `packages/review-ui/web` are leaf bun workspaces hoisted into the root
`node_modules`; `@claude-prove/store` (`bun:sqlite`) replaces the former
`better-sqlite3` dependency; the Docker image runs on `oven/bun:1-alpine`
under the unchanged name `ghcr.io/mjmorales/claude-prove/review-ui`.

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
bun run start      # server: node dist/index.js
```

The server `dev`/`build`/`start` scripts still shell out to `tsx`, `tsc`,
and `node` — bun drives the workspace and `bun:sqlite` powers storage, but
the inner TypeScript toolchain is untouched. The web side uses
`vite` + `@vitejs/plugin-react` unchanged.

Workspace imports resolve through bun's dep graph — the server pulls
`@claude-prove/store` for SQLite access without any nested `node_modules`
inside `packages/review-ui/server/`.

## Docker usage (`/prove:review-ui`)

The `/prove:review-ui` slash command is the supported user-facing entry
point. It pulls `ghcr.io/mjmorales/claude-prove/review-ui` from GHCR, runs
it as a detached `prove-review` container, bind-mounts the repo at
`/repo`, waits for `/api/health`, and opens the browser. Config resolution
flows through `claude-prove review-ui config --cwd <repo-root> | jq`, so the
slash command has no `python3` dependency.

Config keys (first non-empty wins):

1. CLI flag (`--port`, `--image`, `--tag`)
2. Env var (`PROVE_REVIEW_PORT`, `PROVE_REVIEW_IMAGE`, `PROVE_REVIEW_TAG`)
3. `.claude/.prove.json` → `tools.acb.config.review_ui_{port,image,tag}`
4. Hardcoded defaults: `5174`, `ghcr.io/mjmorales/claude-prove/review-ui`,
   `latest`

`claude-prove review-ui config` emits all three keys as one JSON line, filling
any missing value with the hardcoded default — the shell resolution in
`/prove:review-ui` therefore drops one fallback layer.

Image build context is `packages/review-ui/` (see
`.github/workflows/review-ui-image.yml`). The Dockerfile base is
`oven/bun:1-alpine`; image size landed at ~110MB (down from ~322MB on
`node:20-alpine`).

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
Consolidating everything into the monorepo `tsc --build` graph is a
later-phase concern.

## Phase 11 task log

- Task 1: scaffold `packages/review-ui`, copy sources verbatim from
  `tools/review-ui`.
- Task 2: `claude-prove review-ui config` subcommand added.
- Task 3: server ported to `@claude-prove/store`; `group_verdicts`
  absorbed into the acb domain as `acb_group_verdicts` (migration v2
  with idempotent backfill from legacy bare tables).
- Task 4: `react-router-dom` + `/acb` and `/scrum` routes.
- Task 5: Dockerfile switched to `oven/bun:1-alpine`, build context
  repointed to `packages/review-ui/`.
- Task 6: `/prove:review-ui` rewritten to use `claude-prove review-ui config |
  jq`; `python3` dependency dropped.
- Task 7: `.github/workflows/review-ui-image.yml` path filter + build
  context updated.
- Task 8: `tools/review-ui/` deleted — `packages/review-ui/` is the sole
  home.
- Task 9: v0.43.0 release bump (this entry).
