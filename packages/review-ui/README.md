# @claude-prove/review-ui

Review UI absorbed into the monorepo (phase 11). Task 3 rewired the server
onto `@claude-prove/store` (`bun:sqlite`) and flattened the workspace graph.
Subsequent phase-11 waves added `react-router-dom` to the web, swapped the
Dockerfile to a Bun base, and retired the legacy standalone copy under
`tools/` — `packages/review-ui/` is now the canonical home.

## Workspace shape: flattened (task 3 change)

`packages/review-ui/server` and `packages/review-ui/web` are leaf Bun
workspaces (declared in the root `package.json`'s `workspaces` list).
This replaces the task-1 nested-npm layout — the nested `workspaces` array
is gone, and Bun now hoists every dep (fastify, react, `@claude-prove/*`, …)
into the root `node_modules`.

Install + run from the repo root:

```
bun install
cd packages/review-ui
bun run dev       # concurrently runs server + web
bun run build     # builds both
bun run start     # serves production build
```

Workspace imports resolve via Bun's dep graph — the server pulls
`@claude-prove/cli/acb/store` (for the unified SQLite store) without any
`node_modules` inside `packages/review-ui/server/`.

## TypeScript

`packages/review-ui/tsconfig.json` is a composite project referenced by the
root `tsconfig.json`. It intentionally includes only `_placeholder.ts` —
server/web keep their own non-composite `tsconfig.json` files and are
type-checked via their own build scripts. Consolidating the build into the
monorepo `tsc --build` graph is a later-wave concern.

## Migration status

- Task 1: scaffold packages/review-ui, copy sources verbatim.
- Task 2: web sources landed.
- Task 3: server ported to `@claude-prove/store`; `group_verdicts`
  absorbed into the acb domain as `acb_group_verdicts` (migration v2 with
  idempotent backfill from legacy bare tables).
- Later waves: react-router, Bun Dockerfile, retirement of the legacy
  standalone copy under `tools/` (task 8).
