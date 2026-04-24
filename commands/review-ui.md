---
description: Launch the prove review UI as a Docker container
argument-hint: "[--port 5174] [--stop] [--restart] [--pull]"
core: true
summary: Docker-based review UI for inspecting prove runs, ACB intent groups, and verdicts
---

# Review UI

Launch the prove review UI. Runs the `ghcr.io/mjmorales/claude-prove/review-ui` image as a detached Docker container named `prove-review`, bind-mounts the current project, and opens the browser.

Default: `docker run` → wait for health → `open http://localhost:5174`.

## Arguments

Parse `$ARGUMENTS` for:

- `--port <N>` — host port to publish. Overrides config + env.
- `--stop` — stop and remove the running container, then exit. No start.
- `--restart` — stop existing container first, then start fresh.
- `--pull` — `docker pull` before running to fetch the latest tag.
- `--no-open` — don't open a browser.
- `--tag <T>` — image tag to run. Overrides config default.
- `--image <I>` — image reference (without tag). Overrides config default.

If `$ARGUMENTS` is empty, use defaults resolved from config.

## Preconditions

Run these checks first. Bail with a clear error on failure.

1. **`claude-prove` installed**: `command -v claude-prove >/dev/null` — if missing, print: "`claude-prove` CLI not found on PATH. Install via \`curl -fsSL https://raw.githubusercontent.com/mjmorales/claude-prove/main/scripts/install.sh | bash\`, or run from a dev checkout with \`bun run packages/cli/bin/run.ts\` on PATH." Stop.
2. **`jq` installed**: `command -v jq >/dev/null` — if missing, say "`jq` not found on PATH. Install via your package manager (`brew install jq`, `apt install jq`, etc.)." Stop.
3. **Docker installed**: `command -v docker >/dev/null` — if missing, tell the user to install Docker Desktop / colima / podman-compat and stop.
4. **Docker daemon running**: `docker info >/dev/null 2>&1` — if it fails, say "Docker daemon isn't running. Start Docker Desktop (or `colima start`) and retry." Stop.
5. **Inside a git repo**: `git rev-parse --show-toplevel` — if it fails, warn that the UI will show an empty runs list, but proceed if the user confirms via AskUserQuestion (options: `Proceed anyway`, `Cancel`).

## Config resolution

Port, image, and tag resolve in this order (first non-empty wins):

1. CLI flag (`--port`, `--image`, `--tag`)
2. Env var (`PROVE_REVIEW_PORT`, `PROVE_REVIEW_IMAGE`, `PROVE_REVIEW_TAG`)
3. `.claude/.prove.json` — keys `tools.acb.config.review_ui_port`, `review_ui_image`, `review_ui_tag`
4. Hard-coded defaults: `5174`, `ghcr.io/mjmorales/claude-prove/review-ui`, `latest`

The `claude-prove review-ui config` subcommand emits `{port, image, tag}` as a single JSON line, filling any missing key with the hardcoded default. So the shell resolution drops one fallback layer — `$CFG_*` is guaranteed non-empty and already carries the default when the config file is absent or incomplete.

```bash
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
CFG_JSON=$(claude-prove review-ui config --cwd "$REPO_ROOT")
CFG_PORT=$(echo "$CFG_JSON" | jq -r '.port')
CFG_IMAGE=$(echo "$CFG_JSON" | jq -r '.image')
CFG_TAG=$(echo "$CFG_JSON" | jq -r '.tag')

PORT="${FLAG_PORT:-${PROVE_REVIEW_PORT:-$CFG_PORT}}"
IMAGE="${FLAG_IMAGE:-${PROVE_REVIEW_IMAGE:-$CFG_IMAGE}}"
TAG="${FLAG_TAG:-${PROVE_REVIEW_TAG:-$CFG_TAG}}"
```

If the resolved port is occupied by something other than `prove-review`, scan upward for the next free port and warn the user.

## Flow

### Handle `--stop`

If `--stop` is set:

```bash
docker rm -f prove-review 2>/dev/null && echo "Stopped." || echo "Not running."
```

Exit.

### Bind-mount source

`$REPO_ROOT` was already resolved during Config resolution. Use it as the bind-mount source. Never use `$(pwd)` — the container expects the whole repo available at `/repo`.

### Detect existing container

```bash
EXISTING="$(docker ps -a --filter name=^prove-review$ --format '{{.Status}}')"
```

- Empty → no container; proceed to Start.
- Starts with `Up` and `--restart` not set → already running; skip Start, jump to Open Browser.
- Starts with `Up` and `--restart` is set → `docker rm -f prove-review`, then Start.
- Anything else (`Exited`, `Created`, etc.) → `docker rm -f prove-review`, then Start.

Use `docker port prove-review 5174/tcp 2>/dev/null` to detect what host port the running container is bound to, so "Open Browser" targets the right port.

### Port selection

`$PORT` is already resolved (see Config resolution above). Only a fresh start needs the availability check:

```bash
REQUESTED_PORT="$PORT"
while lsof -iTCP:"$PORT" -sTCP:LISTEN -Pn >/dev/null 2>&1; do
  PORT=$((PORT + 1))
done
if [ "$PORT" != "$REQUESTED_PORT" ]; then
  echo "Port $REQUESTED_PORT busy — using $PORT instead."
fi
```

### Optional pull

If `--pull` is set, or if no local image exists for `$IMAGE:$TAG`:

```bash
docker pull "${IMAGE}:${TAG}"
```

Otherwise skip the pull so offline/subsequent runs are fast.

### Start

```bash
docker run -d \
  --name prove-review \
  -p "${PORT}:5174" \
  -v "${REPO_ROOT}:/repo" \
  --restart unless-stopped \
  "${IMAGE}:${TAG}"
```

The container's internal port is always `5174` (set via `ENV PORT=5174` in the image); only the host side is configurable.

### Wait for health

Poll `http://127.0.0.1:${PORT}/api/health` for up to 10 seconds (0.25s backoff). Any 200 → ready. If it never returns 200, surface `docker logs prove-review` and stop.

### Open browser

Unless `--no-open`:

- macOS: `open "http://localhost:${PORT}"`
- Linux: `xdg-open "http://localhost:${PORT}" 2>/dev/null`
- Windows/WSL: `cmd.exe /c start "http://localhost:${PORT}"`

Detect platform via `uname -s`. If browser open fails, just print the URL.

## Report

After any successful action, print a short status block:

```
prove-review
  status:  running
  port:    $PORT
  url:     http://localhost:$PORT
  repo:    $REPO_ROOT
  image:   $IMAGE:$TAG
  source:  flag | env | config

Stop:    /prove:review-ui --stop   (or: docker stop prove-review)
Logs:    docker logs -f prove-review
```

The `source` line tells the user where `$PORT` came from so they can pin it via `.claude/.prove.json` → `tools.acb.config.review_ui_port` if they want the new value to stick. Report `config` whenever the value came from `$CFG_PORT` — since `claude-prove review-ui config` now fills missing keys with hardcoded defaults, `default` collapses into `config` at this layer. Run `claude-prove review-ui config --cwd "$REPO_ROOT"` to inspect the resolved config JSON directly.

## Notes

- Container survives this Claude session. Subsequent `/prove:review-ui` calls reconnect to it instead of starting a new one.
- The image bind-mounts the repo read-write so verdict writes (`.prove/reviews/*.acb.json`, `.prove/acb.db`) persist to the host.
- `git` inside the container is configured with `safe.directory '*'` so it operates on the mounted repo regardless of host UID.
- For arch-mismatched machines (e.g. Apple Silicon on amd64-only images), the GHCR image is published multi-arch (`linux/amd64`, `linux/arm64`); no flags needed.
