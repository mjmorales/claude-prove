# syntax=docker/dockerfile:1.7

# ---------- Build stage ----------
FROM node:20-alpine AS build
WORKDIR /build

# Tools needed to compile native deps (better-sqlite3) + fetch git-installed packages.
RUN apk add --no-cache python3 make g++ git

# Install deps with full workspace context so workspaces + native builds resolve.
COPY package.json package-lock.json* ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm install --no-audit --no-fund

# Copy sources and build both workspaces.
COPY tsconfig*.json ./
COPY server/ server/
COPY web/ web/
RUN npm run build

# Drop dev deps so only runtime deps get copied to the final stage.
RUN npm prune --omit=dev


# ---------- Runtime stage ----------
FROM node:20-alpine AS runtime

# `git` required by simple-git for rev-parse / diff operations against the bind-mounted repo.
# `tini` gives us proper signal handling so `docker stop` exits cleanly.
RUN apk add --no-cache git tini

WORKDIR /app

# Runtime artifacts only.
COPY --from=build /build/package.json ./
COPY --from=build /build/server/package.json server/
COPY --from=build /build/server/dist server/dist
COPY --from=build /build/web/dist web/dist
COPY --from=build /build/node_modules node_modules

# Bind-mounted repo lives here. Git refuses to operate on a repo owned by a
# different UID unless it's marked safe; we mark the mount point system-wide.
ENV REPO_ROOT=/repo
RUN git config --system --add safe.directory /repo \
    && git config --system --add safe.directory '*'

# Bind to all interfaces inside the container so the host port-forward works.
ENV HOST=0.0.0.0
ENV PORT=5174

EXPOSE 5174

# Image metadata for GHCR UI.
LABEL org.opencontainers.image.title="prove-review-ui"
LABEL org.opencontainers.image.description="Read-only UI for reviewing prove runs (ACB intent groups, diffs, verdicts)"
LABEL org.opencontainers.image.source="https://github.com/mjmorales/claude-prove"
LABEL org.opencontainers.image.licenses="MIT"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server/dist/index.js"]
