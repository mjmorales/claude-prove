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

if [[ -d "$INSTALL_DIR/.git" ]]; then
  echo "Updating existing installation at $INSTALL_DIR..."
  git -C "$INSTALL_DIR" pull --quiet
else
  echo "Cloning prove to $INSTALL_DIR..."
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone --quiet "$REPO_URL" "$INSTALL_DIR"
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
