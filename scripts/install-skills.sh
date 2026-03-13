#!/usr/bin/env bash
# install-skills.sh — Install recommended skills from external repos
#
# Usage:
#   install-skills.sh [--list] [--dest DIR]
#
# Clones skill repos to a temp directory, copies listed skills to the
# destination, then cleans up. Default destination: ~/.claude/skills/
#
# Skill sources are defined in the SOURCES array below. Each entry is:
#   "repo_url|skill_path_in_repo|skill_name"
#
# To add more skills in the future, just add entries to SOURCES.

set -eo pipefail

# === Skill Sources ===
# Format: "repo_url|path_in_repo|skill_name"
SOURCES=(
  "https://github.com/anthropics/skills|skills/skill-creator|skill-creator"
  "https://github.com/anthropics/skills|skills/mcp-builder|mcp-builder"
)

# === Parse args ===

DEST="${HOME}/.claude/skills"
LIST_ONLY=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --list)   LIST_ONLY=true; shift ;;
    --dest)   DEST="$2"; shift 2 ;;
    *)        echo "Unknown arg: $1"; exit 1 ;;
  esac
done

# === List mode ===

if $LIST_ONLY; then
  echo "Recommended skills:"
  for entry in "${SOURCES[@]}"; do
    IFS='|' read -r repo path name <<< "$entry"
    local_exists=""
    [[ -d "$DEST/$name" ]] && local_exists=" (installed)"
    echo "  $name — from $repo ($path)$local_exists"
  done
  exit 0
fi

# === Install ===

# Group by repo to avoid cloning the same repo twice
declare -A REPO_SKILLS  # repo -> "path1|name1 path2|name2 ..."

for entry in "${SOURCES[@]}"; do
  IFS='|' read -r repo path name <<< "$entry"
  REPO_SKILLS["$repo"]+="$path|$name "
done

mkdir -p "$DEST"

installed=()
skipped=()

for repo in "${!REPO_SKILLS[@]}"; do
  TMP_DIR=$(mktemp -d)
  trap 'rm -rf "$TMP_DIR"' EXIT

  echo "Cloning $repo..."
  if ! git clone --depth 1 --quiet "$repo" "$TMP_DIR/repo" 2>&1; then
    echo "ERROR: Failed to clone $repo"
    rm -rf "$TMP_DIR"
    continue
  fi

  for skill_entry in ${REPO_SKILLS["$repo"]}; do
    IFS='|' read -r path name <<< "$skill_entry"

    if [[ ! -d "$TMP_DIR/repo/$path" ]]; then
      echo "  WARNING: $path not found in repo, skipping $name"
      skipped+=("$name")
      continue
    fi

    if [[ -d "$DEST/$name" ]]; then
      echo "  Updating $name (replacing existing)..."
      rm -rf "$DEST/$name"
    else
      echo "  Installing $name..."
    fi

    cp -r "$TMP_DIR/repo/$path" "$DEST/$name"
    installed+=("$name")
  done

  rm -rf "$TMP_DIR"
  trap - EXIT
done

# === Summary ===

echo ""
echo "=== Done ==="
echo "Destination: $DEST"

if [[ ${#installed[@]} -gt 0 ]]; then
  echo "Installed:"
  for name in "${installed[@]}"; do
    echo "  - $name"
  done
fi

if [[ ${#skipped[@]} -gt 0 ]]; then
  echo "Skipped:"
  for name in "${skipped[@]}"; do
    echo "  - $name"
  done
fi

echo ""
echo "Restart Claude Code for the new skills to take effect."
