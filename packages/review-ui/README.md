# @claude-prove/review-ui

Review UI scaffolded into the monorepo (phase 11, task 1). This is a **verbatim
copy** of `tools/review-ui/` at the time of scaffolding — no runtime or library
changes. Subsequent phase-11 waves port the server to `@claude-prove/store`,
add `react-router-dom` to the web, swap the Dockerfile to a Bun base, and
delete `tools/review-ui/`.

## Workspace shape: nested (option a)

`packages/review-ui/` is registered as a Bun workspace via the root
`package.json`'s `packages/*` glob. Internally it declares
`workspaces: ["server", "web"]`, mirroring the current `tools/review-ui/`
layout so Dockerfile + GHA paths stay simple.

**Caveat**: Bun 1.2.x does not recursively discover nested workspaces, so
`server/` and `web/` are not Bun workspace leaves. Install their dependencies
with the legacy npm flow from inside this directory:

```
cd packages/review-ui
npm install
npm run dev       # concurrently runs server + web
npm run build     # builds both
npm run start     # serves production build
```

The top-level `bun install` only installs `concurrently` for this package; it
does not pull `better-sqlite3`, `fastify`, `react`, `vite`, etc. Those come
from `npm install` here. This preserves the isolation pattern used by
`tools/review-ui/` today.

## TypeScript

`packages/review-ui/tsconfig.json` is a composite project referenced by the
root `tsconfig.json`. It intentionally includes only `_placeholder.ts` —
server/web keep their own non-composite `tsconfig.json` files (copied
verbatim) and are type-checked via their own build scripts. Consolidating
the build into the monorepo `tsc --build` graph is a later-wave concern.

## Migration status

- Task 1 (this): scaffold packages/review-ui, copy sources verbatim.
- Later waves: store port, react-router, Bun Dockerfile, delete tools/review-ui/.
