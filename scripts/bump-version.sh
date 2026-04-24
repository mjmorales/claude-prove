#!/usr/bin/env bash
# bump-version.sh — Update version in .claude-plugin/ JSON files
#
# Usage: bash scripts/bump-version.sh <new-version>
# Example: bash scripts/bump-version.sh 1.2.3

set -eo pipefail

VERSION="${1:?Usage: bump-version.sh <version>}"

# Validate semver format (loose: major.minor.patch)
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "ERROR: Invalid version format '$VERSION'. Expected: X.Y.Z" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

PLUGIN_JSON="$ROOT_DIR/.claude-plugin/plugin.json"
MARKETPLACE_JSON="$ROOT_DIR/.claude-plugin/marketplace.json"
# The compiled CLI imports its package.json and passes pjson.version to
# cac.version(). Without this update `claude-prove --version` reports
# whatever was last committed (historically 0.0.0).
CLI_PACKAGE_JSON="$ROOT_DIR/packages/cli/package.json"

for f in "$PLUGIN_JSON" "$MARKETPLACE_JSON" "$CLI_PACKAGE_JSON"; do
  if [[ ! -f "$f" ]]; then
    echo "ERROR: Missing file: $f" >&2
    exit 1
  fi
done

# Cross-platform sed in-place (macOS requires '' arg, Linux does not)
sedi() {
  if [[ "$OSTYPE" == darwin* ]]; then
    sed -i '' "$@"
  else
    sed -i "$@"
  fi
}

# Update plugin.json — top-level "version" field
sedi "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" "$PLUGIN_JSON"

# Update marketplace.json — all "version" fields (top-level and in plugins array)
sedi "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" "$MARKETPLACE_JSON"

# Update CLI package.json — top-level "version". Only rewrites the first
# "version" match so transitive dep version pins (if any were added) are
# not clobbered.
sedi "1,/\"version\": \"[^\"]*\"/s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" "$CLI_PACKAGE_JSON"

echo "Updated files to version $VERSION"
echo "  $PLUGIN_JSON"
echo "  $MARKETPLACE_JSON"
echo "  $CLI_PACKAGE_JSON"
