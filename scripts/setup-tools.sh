#!/usr/bin/env bash
# setup-tools.sh — Detect and configure prove tools for a project
#
# Usage: setup-tools.sh [--list] [--project-root DIR] [--plugin-dir DIR]
#
# Scans the plugin's tools/ directory for available tools,
# checks which are already configured, and outputs setup instructions.
#
# Each tool directory can contain a tool.json manifest:
# {
#   "name": "cafi",
#   "description": "Content-addressable file index",
#   "config_key": "index",
#   "config_defaults": {"excludes": [], "max_file_size": 102400, "concurrency": 3},
#   "requires": ["python3"]
# }

set -eo pipefail

# === Parse args ===

PROJECT_ROOT="$(pwd)"
PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LIST_ONLY=false
JSON_OUTPUT=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --list)          LIST_ONLY=true; shift ;;
        --json)          JSON_OUTPUT=true; shift ;;
        --project-root)  PROJECT_ROOT="$2"; shift 2 ;;
        --plugin-dir)    PLUGIN_DIR="$2"; shift 2 ;;
        *)               echo "Unknown arg: $1" >&2; exit 1 ;;
    esac
done

TOOLS_DIR="$PLUGIN_DIR/tools"
PROVE_JSON="$PROJECT_ROOT/.prove.json"

# === Helper: read tool manifest ===

read_tool_manifest() {
    local tool_dir="$1"
    local manifest="$tool_dir/tool.json"
    if [[ -f "$manifest" ]]; then
        cat "$manifest"
    else
        echo "{}"
    fi
}

# === Helper: check if config key exists in .prove.json ===

config_key_exists() {
    local key="$1"
    if [[ ! -f "$PROVE_JSON" ]]; then
        return 1
    fi
    python3 -c "
import json, sys
with open('$PROVE_JSON') as f:
    data = json.load(f)
sys.exit(0 if sys.argv[1] in data else 1)
" "$key" 2>/dev/null
}

# === Scan tools ===

declare -a TOOL_NAMES=()
declare -a TOOL_DESCS=()
declare -a TOOL_STATUSES=()

if [[ ! -d "$TOOLS_DIR" ]]; then
    if $LIST_ONLY; then
        echo "No tools directory found at $TOOLS_DIR"
    fi
    exit 0
fi

for tool_dir in "$TOOLS_DIR"/*/; do
    [[ -d "$tool_dir" ]] || continue
    tool_name="$(basename "$tool_dir")"
    manifest=$(read_tool_manifest "$tool_dir")

    name=$(echo "$manifest" | python3 -c "import json,sys; print(json.load(sys.stdin).get('name', sys.argv[1]))" "$tool_name" 2>/dev/null || echo "$tool_name")
    desc=$(echo "$manifest" | python3 -c "import json,sys; print(json.load(sys.stdin).get('description', 'No description'))" 2>/dev/null || echo "No description")
    config_key=$(echo "$manifest" | python3 -c "import json,sys; print(json.load(sys.stdin).get('config_key', ''))" 2>/dev/null || echo "")

    # Determine status
    status="not configured"
    if [[ -n "$config_key" ]] && config_key_exists "$config_key"; then
        status="configured"
    fi

    TOOL_NAMES+=("$name")
    TOOL_DESCS+=("$desc")
    TOOL_STATUSES+=("$status")
done

# === List mode ===

if $LIST_ONLY; then
    if $JSON_OUTPUT; then
        python3 -c "
import json, sys
tools = []
names = sys.argv[1].split('|') if sys.argv[1] else []
descs = sys.argv[2].split('|') if sys.argv[2] else []
statuses = sys.argv[3].split('|') if sys.argv[3] else []
for i in range(len(names)):
    tools.append({'name': names[i], 'description': descs[i], 'status': statuses[i]})
print(json.dumps(tools, indent=2))
" "$(IFS='|'; echo "${TOOL_NAMES[*]}")" "$(IFS='|'; echo "${TOOL_DESCS[*]}")" "$(IFS='|'; echo "${TOOL_STATUSES[*]}")"
    else
        echo "Available tools:"
        for i in "${!TOOL_NAMES[@]}"; do
            echo "  ${TOOL_NAMES[$i]} — ${TOOL_DESCS[$i]} (${TOOL_STATUSES[$i]})"
        done
    fi
    exit 0
fi

# === Setup mode ===

setup_count=0

for tool_dir in "$TOOLS_DIR"/*/; do
    [[ -d "$tool_dir" ]] || continue
    tool_name="$(basename "$tool_dir")"
    manifest=$(read_tool_manifest "$tool_dir")

    # Check requirements
    requires=$(echo "$manifest" | python3 -c "
import json, sys
m = json.load(sys.stdin)
print(' '.join(m.get('requires', [])))
" 2>/dev/null || echo "")

    for req in $requires; do
        if ! command -v "$req" &>/dev/null; then
            echo "WARNING: $tool_name requires '$req' which is not installed. Skipping."
            continue 2
        fi
    done

    # Add config section
    config_key=$(echo "$manifest" | python3 -c "import json,sys; print(json.load(sys.stdin).get('config_key', ''))" 2>/dev/null || echo "")
    config_defaults=$(echo "$manifest" | python3 -c "
import json, sys
m = json.load(sys.stdin)
d = m.get('config_defaults', {})
print(json.dumps(d) if d else '')
" 2>/dev/null || echo "")

    if [[ -n "$config_key" ]] && [[ -n "$config_defaults" ]] && ! config_key_exists "$config_key"; then
        echo "Adding '$config_key' config for $tool_name..."
        python3 -c "
import json, sys, os

prove_path = sys.argv[1]
key = sys.argv[2]
defaults = json.loads(sys.argv[3])

if os.path.isfile(prove_path):
    with open(prove_path) as f:
        data = json.load(f)
else:
    data = {}

data[key] = defaults

with open(prove_path, 'w') as f:
    json.dump(data, f, indent=2)
    f.write('\n')

print(f'  Added \"{key}\" section to .prove.json')
" "$PROVE_JSON" "$config_key" "$config_defaults"
        setup_count=$((setup_count + 1))
    fi
done

# === Summary ===

if [[ $setup_count -eq 0 ]]; then
    echo "All tools already configured."
else
    echo ""
    echo "Setup complete. $setup_count configuration(s) added."
fi
