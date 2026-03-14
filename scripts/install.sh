#!/usr/bin/env bash
# install.sh — Install the prove plugin for Claude Code
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/mjmorales/claude-prove/main/scripts/install.sh | bash
#   # or
#   bash scripts/install.sh
#
# Options:
#   --dir DIR     Install location (default: ~/.claude/plugins/prove)
#   --user        Install as user-level plugin (default)
#   --project     Install as project-level plugin (uses current directory)

set -eo pipefail

REPO_URL="https://github.com/mjmorales/claude-prove.git"
INSTALL_DIR=""
SCOPE="user"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir)     INSTALL_DIR="$2"; shift 2 ;;
    --user)    SCOPE="user"; shift ;;
    --project) SCOPE="project"; shift ;;
    *)         echo "Unknown arg: $1"; exit 1 ;;
  esac
done

# === Prompt for scope if interactive ===

if [[ -t 0 && -t 1 && -z "$INSTALL_DIR" ]]; then
  echo "prove — Plan, Research, Orchestrate, Validate, Execute"
  echo ""
  echo "Install scope:"
  echo "  1) User   — available in all projects"
  echo "  2) Project — available only in this project"
  echo ""
  printf "Choose [1]: "
  read -r choice
  case "$choice" in
    2) SCOPE="project" ;;
    *) SCOPE="user" ;;
  esac
fi

# === Determine install directory ===

if [[ -z "$INSTALL_DIR" ]]; then
  INSTALL_DIR="${HOME}/.claude/plugins/prove"
fi

# === Clone or update ===
# Use sparse-checkout so only plugin-runtime files are on disk.
# This prevents files like CLAUDE.md and .prove.json (which
# belong to the plugin's own development) from appearing in the install
# directory where they could confuse the LLM.

SPARSE_PATHS=(
  .claude-plugin
  agents
  commands
  references
  scripts
  skills
  tools
)

# === Resolve latest release tag ===

resolve_latest_tag() {
  local tag
  tag=$(git ls-remote --tags --sort=-v:refname "$REPO_URL" 'v*' 2>/dev/null \
    | head -1 | sed 's|.*refs/tags/||; s|\^{}||')
  echo "$tag"
}

RELEASE_TAG=$(resolve_latest_tag)

if [[ -n "$RELEASE_TAG" ]]; then
  echo "Latest release: $RELEASE_TAG"
  CHECKOUT_REF="$RELEASE_TAG"
else
  echo "No release tags found — using main branch."
  CHECKOUT_REF="main"
fi

if [[ -d "$INSTALL_DIR/.git" ]]; then
  echo "Updating existing installation at $INSTALL_DIR..."
  git -C "$INSTALL_DIR" fetch --tags --quiet
  RELEASE_TAG=$(git -C "$INSTALL_DIR" tag --sort=-v:refname | head -1)
  if [[ -n "$RELEASE_TAG" ]]; then
    echo "Checking out $RELEASE_TAG..."
    git -C "$INSTALL_DIR" checkout --quiet "$RELEASE_TAG"
  else
    git -C "$INSTALL_DIR" pull --quiet
  fi
else
  echo "Cloning prove to $INSTALL_DIR..."
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone --quiet --no-checkout "$REPO_URL" "$INSTALL_DIR"
  git -C "$INSTALL_DIR" sparse-checkout init --no-cone
  # Prefix each path with / and suffix with / for directory matching
  sparse_patterns=()
  for p in "${SPARSE_PATHS[@]}"; do
    sparse_patterns+=("/$p/")
  done
  git -C "$INSTALL_DIR" sparse-checkout set "${sparse_patterns[@]}"
  git -C "$INSTALL_DIR" checkout --quiet "$CHECKOUT_REF"
fi

# === Check for claude CLI ===

if ! command -v claude &>/dev/null; then
  echo ""
  echo "WARNING: 'claude' CLI not found in PATH."
  echo "Install Claude Code first, then run:"
  echo "  claude plugin marketplace add $INSTALL_DIR --scope $SCOPE"
  echo "  claude plugin install prove@prove --scope $SCOPE"
  exit 0
fi

# === Register as marketplace and install plugin ===

SCOPE_FLAG="--scope $SCOPE"

# Add as a local marketplace (idempotent — fails gracefully if already added)
if claude plugin marketplace list 2>/dev/null | grep -q "prove"; then
  echo "Marketplace 'prove' already registered."
else
  echo "Registering prove marketplace..."
  if claude plugin marketplace add "$INSTALL_DIR" $SCOPE_FLAG 2>/dev/null; then
    echo "Marketplace registered."
  else
    echo ""
    echo "WARNING: Could not register marketplace automatically."
    echo "Run manually:"
    echo "  claude plugin marketplace add $INSTALL_DIR $SCOPE_FLAG"
    echo "  claude plugin install prove@prove $SCOPE_FLAG"
    exit 0
  fi
fi

# Install the plugin from the marketplace
if claude plugin list 2>/dev/null | grep -q "prove@prove"; then
  echo "Plugin 'prove' already installed."
else
  echo "Installing prove plugin..."
  if claude plugin install prove@prove $SCOPE_FLAG 2>/dev/null; then
    echo "Plugin installed."
  else
    echo ""
    echo "WARNING: Could not install plugin automatically."
    echo "Run manually:"
    echo "  claude plugin install prove@prove $SCOPE_FLAG"
    exit 0
  fi
fi

# === Done ===

echo ""
echo "=== prove installed ==="
echo "Location: $INSTALL_DIR"
echo "Scope:    $SCOPE"
echo ""
echo "If Claude Code is running, restart it for the plugin to take effect."
echo ""
echo "Get started:"
echo "  /prove:init          — Initialize validation config for your project"
echo "  /prove:brainstorm    — Start brainstorming a feature"
echo "  /prove:task-planner  — Plan an implementation"
