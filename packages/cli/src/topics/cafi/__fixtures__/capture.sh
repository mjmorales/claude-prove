#!/usr/bin/env bash
# Capture TS CAFI output against a synthetic project with a stubbed claude CLI.
#
# The Python side of parity lands in task 4 once `claude-prove cafi` dispatches to
# the TS indexer; task 2 pins only TS captures that indexer.test.ts uses.
#
# Flow:
#   1. Build a throwaway project with three text files.
#   2. Shim `claude` on PATH to return JSON stub descriptions.
#   3. Run buildIndex + getStatus + formatIndexForContext + lookup via a
#      bun inline script.
#   4. Write captures to ts-captures/.
#
# Rerun after hasher/describer/indexer logic changes:
#   bash packages/cli/src/topics/cafi/__fixtures__/capture.sh

set -euo pipefail

FIXTURES_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$FIXTURES_DIR/../../../../../.." && pwd)"
TS_CAP="$FIXTURES_DIR/ts-captures"
PY_CAP="$FIXTURES_DIR/python-captures"

mkdir -p "$TS_CAP" "$PY_CAP"

# python-captures/ is intentionally empty for task 2 — see README.md for
# why. Add a .gitkeep so the directory survives git without implying parity.
touch "$PY_CAP/.gitkeep"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# --- Synthetic project -------------------------------------------------------
project="$tmp/project"
mkdir -p "$project/src" "$project/.claude"
echo "# readme" > "$project/README.md"
echo "export const main = 1;" > "$project/src/main.ts"
echo "export const util = 2;" > "$project/src/util.ts"
cat > "$project/.claude/.prove.json" <<'JSON'
{
  "schema_version": "4",
  "tools": {
    "cafi": {
      "config": {
        "excludes": [],
        "max_file_size": 102400,
        "concurrency": 1,
        "batch_size": 5,
        "triage": true
      }
    }
  }
}
JSON

# --- Stubbed claude CLI ------------------------------------------------------
# Returns a JSON map: {path: "stub description for <path>"}. Handles both
# single-file prompts (look for "File path:") and batch prompts (FILE markers).
cat > "$tmp/claude" <<'STUB'
#!/usr/bin/env bash
input="$(cat)"
if grep -q '^--- FILE:' <<<"$input"; then
  paths=$(grep -oE '^--- FILE: [^ ]+ ---' <<<"$input" | sed -E 's/^--- FILE: (.+) ---$/\1/')
else
  paths=$(grep -oE '^File path: .+$' <<<"$input" | sed -E 's/^File path: //')
fi
printf '{'
first=1
while IFS= read -r p; do
  [ -z "$p" ] && continue
  if [ $first -eq 1 ]; then
    first=0
  else
    printf ', '
  fi
  printf '"%s": "stub description for %s"' "$p" "$p"
done <<<"$paths"
printf '}\n'
STUB
chmod +x "$tmp/claude"
export PATH="$tmp:$PATH"

# --- Capture harness ---------------------------------------------------------
cat > "$tmp/harness.ts" <<TS
import {
  buildIndex,
  formatIndexForContext,
  getStatus,
  lookup,
} from '$REPO_ROOT/packages/cli/src/topics/cafi/indexer';

const projectRoot = process.argv[2]!;
const outDir = process.argv[3]!;
await buildIndex(projectRoot);

const status = getStatus(projectRoot);
const statusOut = \`\${JSON.stringify(status, Object.keys(status).sort(), 2)}\n\`;
await Bun.write(\`\${outDir}/status.txt\`, statusOut);

const context = formatIndexForContext(projectRoot);
await Bun.write(\`\${outDir}/context.txt\`, context);

const hits = lookup(projectRoot, 'util');
let lookupOut = '';
for (const hit of hits) {
  lookupOut += \`\${hit.path}\n  \${hit.description}\n\`;
}
await Bun.write(\`\${outDir}/lookup_util.txt\`, lookupOut);
TS

(cd "$REPO_ROOT" && bun run "$tmp/harness.ts" "$project" "$TS_CAP")

echo "ts captures written to $TS_CAP"
echo "(python captures deferred to task 4 once claude-prove cafi CLI is wired)"
