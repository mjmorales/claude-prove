#!/usr/bin/env bash
# Capture ACB assembler parity output against the Python reference
# (`tools/acb/assembler.py::compute_acb_hash`, `merge_intent_groups`,
# `collect_negative_space`).
#
# Each case lands under `python-captures/<name>.json` with one of:
#   { "kind": "hash", "name": "...", "input": <value>, "hash": "..." }
#   { "kind": "merge", "name": "...", "manifests": [ ... ], "expected": [ ... ] }
#   { "kind": "negative_space", "name": "...", "manifests": [ ... ], "expected": [ ... ] }
#
# `assembler.test.ts` iterates over every .json and asserts TS produces the
# same output. Pins are byte-for-byte — re-run this script whenever
# `tools/acb/assembler.py` or `packages/cli/src/topics/acb/assembler.ts`
# changes semantics.
#
#   bash packages/cli/src/topics/acb/__fixtures__/assembler/capture.sh

set -euo pipefail

FIXTURES_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$FIXTURES_DIR/../../../../../../.." && pwd)"
PY_CAP="$FIXTURES_DIR/python-captures"

mkdir -p "$PY_CAP"
rm -f "$PY_CAP"/*.json

python3 - <<PY
import json
import sys
from pathlib import Path

sys.path.insert(0, "$REPO_ROOT/tools")
from acb.assembler import (
    collect_negative_space,
    compute_acb_hash,
    merge_intent_groups,
)

out_dir = Path("$PY_CAP")


def write(name: str, payload: dict) -> None:
    (out_dir / f"{name}.json").write_text(
        json.dumps(payload, indent=2, ensure_ascii=True) + "\n",
        encoding="utf-8",
    )


# ---------------------------------------------------------------------------
# Hash fixtures — pin compute_acb_hash byte-parity.
# ---------------------------------------------------------------------------

hash_cases = [
    ("hash_primitive", {"id": "test", "intent_groups": []}),
    (
        "hash_nested",
        {
            "acb_version": "0.2",
            "id": "fixed-uuid",
            "change_set_ref": {"base_ref": "main", "head_ref": "HEAD"},
            "intent_groups": [
                {
                    "id": "g1",
                    "title": "Group One",
                    "classification": "explicit",
                    "file_refs": [{"path": "a.py", "ranges": ["1-10", "20-30"]}],
                    "annotations": [],
                    "ambiguity_tags": ["assumption"],
                }
            ],
            "manifest_count": 2,
        },
    ),
    (
        "hash_unicode",
        {
            "note": "héllo — wörld 🎉",
            "ascii": "plain",
        },
    ),
]

for name, obj in hash_cases:
    write(name, {"kind": "hash", "name": name, "input": obj, "hash": compute_acb_hash(obj)})


# ---------------------------------------------------------------------------
# Merge fixtures — pin merge_intent_groups output structure.
# ---------------------------------------------------------------------------


def manifest(sha: str, groups: list[dict], **kw) -> dict:
    return {
        "acb_manifest_version": "0.2",
        "commit_sha": sha,
        "timestamp": f"2026-03-29T12:0{sha}:00Z",
        "intent_groups": groups,
        **kw,
    }


def group(gid: str, files: list[str], ranges: dict[str, list[str]] | None = None, **kw) -> dict:
    ranges = ranges or {}
    return {
        "id": gid,
        "title": gid.replace("-", " ").title(),
        "classification": kw.pop("classification", "explicit"),
        "file_refs": [
            {"path": f, **({"ranges": list(ranges[f])} if f in ranges else {})}
            for f in files
        ],
        "annotations": kw.pop("annotations", []),
        "ambiguity_tags": kw.pop("ambiguity_tags", []),
        **kw,
    }


merge_cases = [
    (
        "merge_distinct_groups",
        [
            manifest("0", [group("g1", ["a.py"])]),
            manifest("1", [group("g2", ["b.py"])]),
        ],
    ),
    (
        "merge_same_id_file_refs",
        [
            manifest("0", [group("g1", ["a.py"], ranges={"a.py": ["1-10"]})]),
            manifest("1", [group("g1", ["a.py", "b.py"], ranges={"a.py": ["1-10", "20-30"]})]),
        ],
    ),
    (
        "merge_annotations_and_tags",
        [
            manifest(
                "0",
                [
                    group(
                        "g1",
                        ["a.py"],
                        annotations=[{"id": "ann-1", "type": "note", "body": "first"}],
                        ambiguity_tags=["assumption"],
                    )
                ],
            ),
            manifest(
                "1",
                [
                    group(
                        "g1",
                        ["a.py"],
                        annotations=[
                            {"id": "ann-1", "type": "note", "body": "dup"},
                            {"id": "ann-2", "type": "flag", "body": "new"},
                        ],
                        ambiguity_tags=["scope_creep", "assumption"],
                    )
                ],
            ),
        ],
    ),
]

for name, manifests in merge_cases:
    write(
        name,
        {
            "kind": "merge",
            "name": name,
            "manifests": manifests,
            "expected": merge_intent_groups(manifests),
        },
    )


# ---------------------------------------------------------------------------
# Negative space fixture — dedup-by-path parity.
# ---------------------------------------------------------------------------

ns_cases = [
    (
        "negative_space_dedup",
        [
            manifest(
                "0",
                [group("g1", ["a.py"])],
                negative_space=[{"path": "x.py", "reason": "out_of_scope"}],
            ),
            manifest(
                "1",
                [group("g2", ["b.py"])],
                negative_space=[
                    {"path": "x.py", "reason": "out_of_scope"},
                    {"path": "y.py", "reason": "intentionally_preserved"},
                ],
            ),
        ],
    ),
]

for name, manifests in ns_cases:
    write(
        name,
        {
            "kind": "negative_space",
            "name": name,
            "manifests": manifests,
            "expected": collect_negative_space(manifests),
        },
    )

count = len(hash_cases) + len(merge_cases) + len(ns_cases)
print(f"wrote {count} python captures to {out_dir}")
PY

echo "acb assembler captures regenerated"
