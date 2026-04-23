#!/usr/bin/env bash
# Capture ACB schema parity output against the Python reference
# (`tools/acb/schemas.py::validate_manifest` and `validate_review_state`).
#
# Each case is serialized to `python-captures/<name>.txt` as:
#   { "name": "...", "validator": "manifest"|"review_state", "input": <data>, "errors": [ ... ] }
#
# `schemas.test.ts` iterates over every .txt file and asserts the TS
# validator returns the same `errors` list. The captures pin error strings
# byte-for-byte — re-run this script whenever `tools/acb/schemas.py` or
# `packages/cli/src/topics/acb/schemas.ts` changes.
#
#   bash packages/cli/src/topics/acb/__fixtures__/schemas/capture.sh

set -euo pipefail

FIXTURES_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$FIXTURES_DIR/../../../../../../.." && pwd)"
PY_CAP="$FIXTURES_DIR/python-captures"

mkdir -p "$PY_CAP"
rm -f "$PY_CAP"/*.txt

cases_file="$FIXTURES_DIR/cases.json"
cat > "$cases_file" <<'JSON'
[
  {
    "name": "manifest_valid",
    "validator": "manifest",
    "input": {
      "acb_manifest_version": "0.2",
      "commit_sha": "abc1234",
      "timestamp": "2026-03-29T12:00:00Z",
      "intent_groups": [
        {
          "id": "feat-auth",
          "title": "Add authentication",
          "classification": "explicit",
          "file_refs": [{"path": "src/auth.py", "ranges": ["1-50"]}],
          "annotations": []
        }
      ]
    }
  },
  {
    "name": "manifest_not_an_object_null",
    "validator": "manifest",
    "input": null
  },
  {
    "name": "manifest_not_an_object_string",
    "validator": "manifest",
    "input": "string"
  },
  {
    "name": "manifest_not_an_object_number",
    "validator": "manifest",
    "input": 123
  },
  {
    "name": "manifest_not_an_object_list",
    "validator": "manifest",
    "input": []
  },
  {
    "name": "manifest_missing_all_required",
    "validator": "manifest",
    "input": {}
  },
  {
    "name": "manifest_missing_commit_sha",
    "validator": "manifest",
    "input": {
      "acb_manifest_version": "0.2",
      "timestamp": "2026-03-29T12:00:00Z",
      "intent_groups": [
        {
          "id": "feat-auth",
          "title": "Add authentication",
          "classification": "explicit",
          "file_refs": [{"path": "src/auth.py"}]
        }
      ]
    }
  },
  {
    "name": "manifest_intent_groups_not_array",
    "validator": "manifest",
    "input": {
      "acb_manifest_version": "0.2",
      "commit_sha": "abc1234",
      "timestamp": "2026-03-29T12:00:00Z",
      "intent_groups": {"not": "array"}
    }
  },
  {
    "name": "manifest_intent_groups_empty",
    "validator": "manifest",
    "input": {
      "acb_manifest_version": "0.2",
      "commit_sha": "abc1234",
      "timestamp": "2026-03-29T12:00:00Z",
      "intent_groups": []
    }
  },
  {
    "name": "manifest_group_not_object",
    "validator": "manifest",
    "input": {
      "acb_manifest_version": "0.2",
      "commit_sha": "abc1234",
      "timestamp": "2026-03-29T12:00:00Z",
      "intent_groups": ["not-an-object"]
    }
  },
  {
    "name": "manifest_group_missing_all_fields",
    "validator": "manifest",
    "input": {
      "acb_manifest_version": "0.2",
      "commit_sha": "abc1234",
      "timestamp": "2026-03-29T12:00:00Z",
      "intent_groups": [{}]
    }
  },
  {
    "name": "manifest_duplicate_group_ids",
    "validator": "manifest",
    "input": {
      "acb_manifest_version": "0.2",
      "commit_sha": "abc1234",
      "timestamp": "2026-03-29T12:00:00Z",
      "intent_groups": [
        {
          "id": "feat-auth",
          "title": "Add authentication",
          "classification": "explicit",
          "file_refs": [{"path": "src/auth.py"}]
        },
        {
          "id": "feat-auth",
          "title": "Duplicate",
          "classification": "inferred",
          "file_refs": [{"path": "src/b.py"}]
        }
      ]
    }
  },
  {
    "name": "manifest_invalid_classification",
    "validator": "manifest",
    "input": {
      "acb_manifest_version": "0.2",
      "commit_sha": "abc1234",
      "timestamp": "2026-03-29T12:00:00Z",
      "intent_groups": [
        {
          "id": "x",
          "title": "t",
          "classification": "maybe",
          "file_refs": [{"path": "src/x.py"}]
        }
      ]
    }
  },
  {
    "name": "manifest_empty_file_refs",
    "validator": "manifest",
    "input": {
      "acb_manifest_version": "0.2",
      "commit_sha": "abc1234",
      "timestamp": "2026-03-29T12:00:00Z",
      "intent_groups": [
        {
          "id": "x",
          "title": "t",
          "classification": "explicit",
          "file_refs": []
        }
      ]
    }
  },
  {
    "name": "manifest_file_refs_not_array",
    "validator": "manifest",
    "input": {
      "acb_manifest_version": "0.2",
      "commit_sha": "abc1234",
      "timestamp": "2026-03-29T12:00:00Z",
      "intent_groups": [
        {
          "id": "x",
          "title": "t",
          "classification": "explicit",
          "file_refs": "nope"
        }
      ]
    }
  },
  {
    "name": "manifest_multiple_errors",
    "validator": "manifest",
    "input": {
      "intent_groups": [
        {
          "id": "x",
          "title": "t",
          "classification": "bogus",
          "file_refs": []
        }
      ]
    }
  },
  {
    "name": "review_state_valid",
    "validator": "review_state",
    "input": {
      "acb_version": "0.2",
      "acb_hash": "deadbeef",
      "acb_id": "test-id",
      "group_verdicts": [
        {"group_id": "feat-auth", "verdict": "pending"}
      ],
      "overall_verdict": "pending"
    }
  },
  {
    "name": "review_state_not_an_object_null",
    "validator": "review_state",
    "input": null
  },
  {
    "name": "review_state_not_an_object_list",
    "validator": "review_state",
    "input": []
  },
  {
    "name": "review_state_missing_all_required",
    "validator": "review_state",
    "input": {}
  },
  {
    "name": "review_state_group_verdicts_not_array",
    "validator": "review_state",
    "input": {
      "acb_version": "0.2",
      "acb_hash": "deadbeef",
      "acb_id": "test-id",
      "group_verdicts": {"not": "array"},
      "overall_verdict": "pending"
    }
  },
  {
    "name": "review_state_verdict_not_object",
    "validator": "review_state",
    "input": {
      "acb_version": "0.2",
      "acb_hash": "deadbeef",
      "acb_id": "test-id",
      "group_verdicts": ["not-an-object"],
      "overall_verdict": "pending"
    }
  },
  {
    "name": "review_state_missing_group_id",
    "validator": "review_state",
    "input": {
      "acb_version": "0.2",
      "acb_hash": "deadbeef",
      "acb_id": "test-id",
      "group_verdicts": [{"verdict": "accepted"}],
      "overall_verdict": "pending"
    }
  },
  {
    "name": "review_state_missing_verdict",
    "validator": "review_state",
    "input": {
      "acb_version": "0.2",
      "acb_hash": "deadbeef",
      "acb_id": "test-id",
      "group_verdicts": [{"group_id": "g"}],
      "overall_verdict": "pending"
    }
  },
  {
    "name": "review_state_invalid_verdict",
    "validator": "review_state",
    "input": {
      "acb_version": "0.2",
      "acb_hash": "deadbeef",
      "acb_id": "test-id",
      "group_verdicts": [{"group_id": "g", "verdict": "maybe"}],
      "overall_verdict": "pending"
    }
  },
  {
    "name": "review_state_invalid_overall_verdict",
    "validator": "review_state",
    "input": {
      "acb_version": "0.2",
      "acb_hash": "deadbeef",
      "acb_id": "test-id",
      "group_verdicts": [{"group_id": "g", "verdict": "pending"}],
      "overall_verdict": "dunno"
    }
  }
]
JSON

python3 - <<PY
import json
import sys
from pathlib import Path

sys.path.insert(0, "$REPO_ROOT")
from tools.acb.schemas import validate_manifest, validate_review_state

cases_path = Path("$cases_file")
out_dir = Path("$PY_CAP")
cases = json.loads(cases_path.read_text(encoding="utf-8"))

for case in cases:
    if case["validator"] == "manifest":
        errors = validate_manifest(case["input"])
    elif case["validator"] == "review_state":
        errors = validate_review_state(case["input"])
    else:
        raise SystemExit(f"unknown validator: {case['validator']!r}")
    payload = {
        "name": case["name"],
        "validator": case["validator"],
        "input": case["input"],
        "errors": errors,
    }
    out_path = out_dir / f"{case['name']}.txt"
    out_path.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
print(f"wrote {len(cases)} python captures to {out_dir}")
PY

(cd "$REPO_ROOT" && npx --no-install biome format --write "$cases_file" >/dev/null 2>&1 || true)

echo "acb schemas captures regenerated"
