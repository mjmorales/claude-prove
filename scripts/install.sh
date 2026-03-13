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
  echo "  1) User   — available in all projects (~/.claude/settings.json)"
  echo "  2) Project — available only in this project (.claude/settings.json)"
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

# === Register plugin in settings ===

if [[ "$SCOPE" == "project" ]]; then
  SETTINGS_DIR=".claude"
  SETTINGS_FILE=".claude/settings.json"
else
  SETTINGS_DIR="${HOME}/.claude"
  SETTINGS_FILE="${HOME}/.claude/settings.json"
fi

mkdir -p "$SETTINGS_DIR"

register_plugin() {
  local file="$1"
  local plugin_path="$INSTALL_DIR"

  if [[ ! -f "$file" ]]; then
    echo '{}' > "$file"
  fi

  # Check if already registered
  if grep -q "$plugin_path" "$file" 2>/dev/null; then
    echo "Plugin already registered in $file"
    return
  fi

  # Use python3 for reliable JSON manipulation (available on macOS and most Linux)
  if command -v python3 &>/dev/null; then
    python3 -c "
import json, sys
path = sys.argv[1]
plugin = sys.argv[2]
with open(path) as f:
    data = json.load(f)
plugins = data.get('plugins', [])
if plugin not in plugins:
    plugins.append(plugin)
data['plugins'] = plugins
with open(path, 'w') as f:
    json.dump(data, f, indent=2)
    f.write('\n')
" "$file" "$plugin_path"
    echo "Registered plugin in $file"
  else
    echo ""
    echo "Could not auto-register. Add this to $file manually:"
    echo ""
    echo "  \"plugins\": [\"$plugin_path\"]"
  fi
}

register_plugin "$SETTINGS_FILE"

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
