# syntax=docker/dockerfile:1.7

# Build context is the monorepo root so that workspace deps
# (@claude-prove/{cli,shared,store}) resolve via bun install's symlink graph.
#
# Runtime strategy: ship workspace TS source + node_modules. The server entry
# (packages/review-ui/server/src/index.ts) is executed directly by bun, which
# transpiles TS on the fly and uses native `bun:sqlite`. No tsc build step.

# ---------- Build stage ----------
# Bun base for the install step (resolves @claude-prove/* workspace symlinks).
# Node is co-installed because Vite's build step crashes Bun on non-AVX CPUs
# (seen under linux/amd64 emulation on Apple Silicon hosts) — Vite runs on
# Node for the bundle step only. Runtime stays pure Bun.
FROM oven/bun:1-alpine AS build
WORKDIR /build

# `git` for any git-installed deps; `nodejs`/`npm` for the Vite web build.
RUN apk add --no-cache git nodejs npm

# Root workspace manifest + lockfile drive the install graph.
COPY package.json bun.lock ./
COPY tsconfig.base.json tsconfig.json ./

# Workspace package manifests. Copying manifests first maximizes layer reuse
# when only source (not deps) changes.
COPY packages/shared/package.json packages/shared/
COPY packages/store/package.json packages/store/
COPY packages/cli/package.json packages/cli/
COPY packages/installer/package.json packages/installer/
COPY packages/review-ui/package.json packages/review-ui/
COPY packages/review-ui/server/package.json packages/review-ui/server/
COPY packages/review-ui/web/package.json packages/review-ui/web/
COPY packages/review-ui/package-lock.json packages/review-ui/

# Install the full workspace graph (bun resolves @claude-prove/* to symlinks).
# Frozen lockfile is avoided because the review-ui web subpackage is an npm
# workspace leaf with its own package-lock.json; bun resolves its deps fresh
# and that causes harmless drift against the top-level bun.lock.
RUN bun install

# Now bring in source trees. Server has no build step (bun runs TS directly);
# web needs a Vite build to produce the static bundle served by Fastify.
COPY packages/shared/ packages/shared/
COPY packages/store/ packages/store/
COPY packages/cli/ packages/cli/
COPY packages/installer/ packages/installer/
COPY packages/review-ui/ packages/review-ui/

# Build the web bundle. Vite runs on Node (not Bun) because Bun crashes on
# non-AVX x64 CPUs (QEMU emulation under buildx). bun install above already
# populated /build/node_modules with vite + react + plugins, so Node invokes
# the hoisted vite binary directly against web's source + vite.config.ts.
# npm install is skipped because packages/review-ui/server/package.json uses
# `workspace:*` protocol (Bun-only); npm rejects it with EUNSUPPORTEDPROTOCOL.
RUN cd packages/review-ui/web && node /build/node_modules/.bin/vite build


# ---------- Runtime stage ----------
FROM oven/bun:1-alpine AS runtime

# `git` is required by simple-git for rev-parse / diff on the bind-mounted repo.
# `tini` provides PID 1 signal forwarding so `docker stop` exits cleanly.
# No python/make/g++ needed — bun:sqlite replaces better-sqlite3's native build.
RUN apk add --no-cache git tini

WORKDIR /app

# Workspace runtime: root manifests, all package source, and the resolved
# node_modules tree (which contains symlinks @claude-prove/* -> packages/*).
COPY --from=build /build/package.json /build/bun.lock /build/tsconfig.base.json /build/tsconfig.json ./
COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/packages/shared ./packages/shared
COPY --from=build /build/packages/store ./packages/store
COPY --from=build /build/packages/cli ./packages/cli
COPY --from=build /build/packages/installer ./packages/installer
COPY --from=build /build/packages/review-ui/package.json ./packages/review-ui/
COPY --from=build /build/packages/review-ui/tsconfig.json ./packages/review-ui/
COPY --from=build /build/packages/review-ui/server ./packages/review-ui/server
COPY --from=build /build/packages/review-ui/web/package.json ./packages/review-ui/web/
COPY --from=build /build/packages/review-ui/web/dist ./packages/review-ui/web/dist

# The bind-mounted repo lives here. Git refuses to operate on a repo owned by
# a different UID unless it's marked safe; mark both the mount point and a
# wildcard (covers nested worktrees the server may touch).
ENV REPO_ROOT=/repo
RUN git config --system --add safe.directory /repo \
    && git config --system --add safe.directory '*'

# Bind to all interfaces inside the container so the host port-forward works.
ENV HOST=0.0.0.0
ENV PORT=5174
ENV LOG_LEVEL=info

EXPOSE 5174

# Image metadata for GHCR UI.
LABEL org.opencontainers.image.title="prove-review-ui"
LABEL org.opencontainers.image.description="Read-only UI for reviewing prove runs (ACB intent groups, diffs, verdicts)"
LABEL org.opencontainers.image.source="https://github.com/mjmorales/claude-prove"
LABEL org.opencontainers.image.licenses="MIT"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["bun", "run", "packages/review-ui/server/src/index.ts"]
