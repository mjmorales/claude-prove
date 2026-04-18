# review-ui

Browser-based review UI for prove runs. Inspects the `.prove/runs/<branch>/<slug>/` JSON layout plus the ACB intent store (`.prove/acb.db`), surfaces intent groups with diffs + annotations, and records verdicts (approve / reject / discuss / rework).

Published as a Docker image at `ghcr.io/mjmorales/claude-prove/review-ui`. The Claude Code plugin ships a `/prove:review-ui` command that handles the container lifecycle.

## Run it

### Via the plugin

```
/prove:review-ui
```

Starts a detached container named `prove-review`, bind-mounts the current repo at `/repo`, exposes port 5174, and opens the browser. Subsequent calls reuse the running container. Stop with `/prove:review-ui --stop`.

### Via Docker directly

```bash
docker run -d \
  --name prove-review \
  -p 5174:5174 \
  -v "$(git rev-parse --show-toplevel):/repo" \
  ghcr.io/mjmorales/claude-prove/review-ui:latest

open http://localhost:5174
```

Environment overrides (inside the container):

| Var         | Default     | Purpose                                               |
|-------------|-------------|-------------------------------------------------------|
| `PORT`      | `5174`      | Listen port inside the container                      |
| `HOST`      | `0.0.0.0`   | Bind address inside the container                     |
| `REPO_ROOT` | `/repo`     | Absolute path to the git repo (where `.prove/` lives) |
| `WEB_ROOT`  | _(auto)_    | Override the prebuilt web bundle location             |
| `LOG_LEVEL` | `info`      | Fastify log level                                     |

Host-side config (used by `/prove:review-ui`):

- **CLI**: `--port <N>`, `--image <I>`, `--tag <T>`
- **Env**: `PROVE_REVIEW_PORT`, `PROVE_REVIEW_IMAGE`, `PROVE_REVIEW_TAG`
- **Config file**: `.claude/.prove.json` → `tools.acb.config.review_ui_port` / `review_ui_image` / `review_ui_tag`

Precedence: CLI > env > config > default. The in-container port stays `5174`; only the host side changes.

## Build the image locally

```bash
docker build -t prove-review-ui:local tools/review-ui
docker run -d --name prove-review -p 5174:5174 \
  -v "$(pwd):/repo" prove-review-ui:local
```

Multi-arch (`linux/amd64` + `linux/arm64`) builds ship from `.github/workflows/review-ui-image.yml` on pushes to `main` and tags matching `review-ui-v*`.

## Local development (no Docker)

```
cd tools/review-ui
npm install            # first time only
npm run dev            # Fastify :5174 + Vite :5175 concurrently
```

Open http://localhost:5175. Vite proxies `/api/*` to the Fastify port (or use same-origin via the built SPA on :5174 if you run `npm run build && npm -w server run start`).

## Layout

- `server/` — Fastify + simple-git + chokidar + better-sqlite3. Serves the prebuilt SPA from `web/dist/` under `/` and the API under `/api/*`. SSE stream at `/api/events` watches `.prove/runs/`, `.git/refs`, `.git/HEAD`, `.git/worktrees`.
- `web/` — Vite + React 18 + Tailwind + TanStack Query + Zustand. Dracula-inspired theme, progressive column reveal (Runs → Structure → Files → Inspector), explicit verdict CTAs, keyboard shortcuts as secondary hints.

## How it reads state

Prove ≥ 0.34 writes a run at `.prove/runs/<branch>/<slug>/`:

- `prd.json` — requirements (write-once)
- `plan.json` — task graph (write-once)
- `state.json` — live run state (mutated only via `prove-run`)
- `reports/<step_id>.json` — per-step validator results + diff stats
- `review.json` — per-group verdicts written by the review session

ACB intent manifests and assembled docs live at `.prove/acb.db` (SQLite).

### URL key

Every run-scoped API route uses a composite `<branch>/<slug>` as the `:slug` param. The client URL-encodes the slash:

```
/api/runs/chore%2Freview-ui-sync/tasks
```

`server/src/parsers.ts::parseRunKey` decodes and splits on the first `/`.

### Git conventions

- Orchestrator branch: `orchestrator/<slug>` — worktree at `.claude/worktrees/orchestrator-<slug>/`
- Sub-task branches: `task/<slug>/<task-id>` — worktree at `.claude/worktrees/<slug>-task-<task-id>/`
- Committed diff: `git diff <base>...<head>`, run inside the head branch's worktree if one exists, else the repo root
- Pending diff: `git diff HEAD` inside the orchestrator worktree (or a task worktree when targeted)

## Review session

In the UI, press `⇧R` (or click "Review") once a run is selected. Keys: `j`/`k` (↑/↓) navigate groups, `a` approve, `r` reject, `d` discuss (opens drawer), `f` rework (opens fix-brief drawer), `u` undo, `v` toggle diff, `e` exit, `?` key map. Verdicts persist to `.prove/acb.db`.
