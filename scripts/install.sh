#!/usr/bin/env bash
# install.sh — Install the prove plugin for Claude Code.
#
# Fetches the compiled `prove` binary from GitHub Releases for the host
# platform, drops it under $PREFIX (default ~/.local/bin), then runs
# `prove install init`. Falls back to a shallow git clone + bun invocation
# when the binary fetch fails.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/mjmorales/claude-prove/main/scripts/install.sh | bash
#   bash scripts/install.sh [--prefix <dir>] [--project]
#
#   --prefix <dir>  override binary install dir (default ~/.local/bin)
#   --project       scope plugin-install + prove-init to $PWD (default: user)

set -euo pipefail
PREFIX="${HOME}/.local/bin"; SCOPE="user"; INIT_ARGS=()
while [[ $# -gt 0 ]]; do case "$1" in
  --prefix) PREFIX="$2"; shift 2 ;;
  --project) SCOPE="project"; INIT_ARGS=(--project "$PWD"); shift ;;
  *) echo "unknown arg: $1" >&2; exit 1 ;;
esac; done
TARGET="$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/')"
URL="https://github.com/mjmorales/claude-prove/releases/latest/download/prove-${TARGET}"
DEST="${PREFIX}/prove"; TMP="${PREFIX}/.prove.tmp.$$"; CLONE="${HOME}/.claude/plugins/prove"
mkdir -p "$PREFIX"; trap 'rm -f "$TMP"' EXIT
if curl -fsSL "$URL" -o "$TMP" && [[ -s "$TMP" ]]; then
  chmod +x "$TMP"; mv "$TMP" "$DEST"; CMD=("$DEST"); echo ":: wrote $DEST ($TARGET)"
else
  echo ":: fetch failed — falling back to git clone" >&2
  [[ -d "$CLONE/.git" ]] || git clone --depth 1 https://github.com/mjmorales/claude-prove.git "$CLONE"
  CMD=(bun run "${CLONE}/packages/cli/bin/run.ts")
fi
if ! [[ ":$PATH:" == *":${PREFIX}:"* ]]; then
  case "${SHELL##*/}" in zsh) RC="${HOME}/.zshrc" ;; bash) RC="${HOME}/.bashrc" ;; *) RC="your shell rc file" ;; esac
  echo ":: warning: ${PREFIX} not on PATH — append to ${RC}: export PATH=\"${PREFIX}:\$PATH\"" >&2
fi
"${CMD[@]}" install init "${INIT_ARGS[@]}"
if command -v claude >/dev/null 2>&1; then
  claude plugin marketplace add mjmorales/claude-prove --scope "$SCOPE" 2>/dev/null || true
  claude plugin install prove@prove --scope "$SCOPE" 2>/dev/null || true
else
  printf ':: claude CLI not found — run manually:\n   claude plugin marketplace add mjmorales/claude-prove --scope %s\n   claude plugin install prove@prove --scope %s\n' "$SCOPE" "$SCOPE"
fi
echo ":: prove installed"
