#!/usr/bin/env bash
# build-review-ui-embed.sh — build the review-ui web bundle and pack it into the
# tarball the compiled `claude-prove` binary embeds.
#
# Pipeline: vite build (packages/review-ui/web) -> tar web/dist into
# packages/cli/bin/web-dist.tar. The CLI compile entry (packages/cli/bin/run.ts)
# statically imports that tar with `type: "file"`, so `bun build --compile` bakes
# it into the executable's virtual filesystem; the review-ui server extracts it
# to a cache dir on first boot (see packages/review-ui/server/src/embedded-assets.ts).
#
# Run this BEFORE the cli compile step in CI. The committed web-dist.tar is a stub
# (an empty tar) so the import always resolves for local `bun build --compile`;
# this script overwrites it with the real bundle.
#
# Usage: scripts/build-review-ui-embed.sh

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
web_dir="$repo_root/packages/review-ui/web"
dist_dir="$web_dir/dist"
tar_out="$repo_root/packages/cli/bin/web-dist.tar"

echo "build-review-ui-embed: building web bundle (vite)"
# Bun crashes vite's bundle step on non-AVX x64 CPUs, so drive vite through
# Node. node_modules/.bin/vite is populated by bun install.
( cd "$web_dir" && node "$repo_root/node_modules/.bin/vite" build )

if [ ! -f "$dist_dir/index.html" ]; then
  echo "build-review-ui-embed: $dist_dir/index.html missing after vite build" >&2
  exit 1
fi

echo "build-review-ui-embed: packing $dist_dir -> $tar_out"
# Tar the dist contents (not the dist dir itself) so extraction yields
# <cache>/index.html + <cache>/assets/... — the layout @fastify/static serves.
tar -cf "$tar_out" -C "$dist_dir" .

echo "build-review-ui-embed: done ($(wc -c < "$tar_out" | tr -d ' ') bytes)"
