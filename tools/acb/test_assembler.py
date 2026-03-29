"""Tests for acb.assembler merge and assembly logic."""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

_tool_dir = Path(__file__).resolve().parent
if str(_tool_dir.parent) not in sys.path:
    sys.path.insert(0, str(_tool_dir.parent))

from acb.assembler import (
    collect_negative_space,
    collect_open_questions,
    compute_acb_hash,
    detect_uncovered_files,
    load_manifests,
    merge_intent_groups,
)


def _manifest(sha: str, groups: list[dict], **kwargs) -> dict:
    return {
        "acb_manifest_version": "0.2",
        "commit_sha": sha,
        "timestamp": f"2026-03-29T12:0{sha}:00Z",
        "intent_groups": groups,
        **kwargs,
    }


def _group(gid: str, files: list[str], **kwargs) -> dict:
    return {
        "id": gid,
        "title": gid.replace("-", " ").title(),
        "classification": kwargs.pop("classification", "explicit"),
        "file_refs": [{"path": f} for f in files],
        "annotations": kwargs.pop("annotations", []),
        "ambiguity_tags": kwargs.pop("ambiguity_tags", []),
        **kwargs,
    }


class TestLoadManifests(unittest.TestCase):
    def test_loads_valid_manifests(self):
        with tempfile.TemporaryDirectory() as d:
            m = _manifest("0", [_group("g1", ["a.py"])])
            with open(os.path.join(d, "abc.json"), "w") as f:
                json.dump(m, f)
            result = load_manifests(d)
            self.assertEqual(len(result), 1)

    def test_skips_invalid_json(self):
        with tempfile.TemporaryDirectory() as d:
            with open(os.path.join(d, "bad.json"), "w") as f:
                f.write("{not json")
            result = load_manifests(d)
            self.assertEqual(result, [])

    def test_skips_invalid_manifest(self):
        with tempfile.TemporaryDirectory() as d:
            with open(os.path.join(d, "empty.json"), "w") as f:
                json.dump({"intent_groups": []}, f)
            result = load_manifests(d)
            self.assertEqual(result, [])

    def test_sorts_by_timestamp(self):
        with tempfile.TemporaryDirectory() as d:
            m1 = _manifest("2", [_group("g1", ["a.py"])])
            m2 = _manifest("1", [_group("g2", ["b.py"])])
            with open(os.path.join(d, "second.json"), "w") as f:
                json.dump(m1, f)
            with open(os.path.join(d, "first.json"), "w") as f:
                json.dump(m2, f)
            result = load_manifests(d)
            self.assertEqual(result[0]["commit_sha"], "1")
            self.assertEqual(result[1]["commit_sha"], "2")


class TestMergeIntentGroups(unittest.TestCase):
    def test_distinct_groups_preserved(self):
        manifests = [
            _manifest("0", [_group("g1", ["a.py"])]),
            _manifest("1", [_group("g2", ["b.py"])]),
        ]
        merged = merge_intent_groups(manifests)
        self.assertEqual(len(merged), 2)

    def test_same_id_merges_file_refs(self):
        manifests = [
            _manifest("0", [_group("g1", ["a.py"])]),
            _manifest("1", [_group("g1", ["b.py"])]),
        ]
        merged = merge_intent_groups(manifests)
        self.assertEqual(len(merged), 1)
        paths = {r["path"] for r in merged[0]["file_refs"]}
        self.assertEqual(paths, {"a.py", "b.py"})

    def test_same_id_deduplicates_annotations(self):
        ann = {"id": "ann-1", "type": "note", "body": "test"}
        manifests = [
            _manifest("0", [_group("g1", ["a.py"], annotations=[ann])]),
            _manifest("1", [_group("g1", ["a.py"], annotations=[ann])]),
        ]
        merged = merge_intent_groups(manifests)
        self.assertEqual(len(merged[0]["annotations"]), 1)

    def test_same_id_unions_ambiguity_tags(self):
        manifests = [
            _manifest("0", [_group("g1", ["a.py"], ambiguity_tags=["assumption"])]),
            _manifest("1", [_group("g1", ["a.py"], ambiguity_tags=["scope_creep", "assumption"])]),
        ]
        merged = merge_intent_groups(manifests)
        tags = merged[0]["ambiguity_tags"]
        self.assertEqual(set(tags), {"assumption", "scope_creep"})
        # No duplicates.
        self.assertEqual(len(tags), 2)


class TestCollectNegativeSpace(unittest.TestCase):
    def test_deduplicates_by_path(self):
        manifests = [
            _manifest("0", [_group("g1", ["a.py"])], negative_space=[
                {"path": "x.py", "reason": "out_of_scope"},
            ]),
            _manifest("1", [_group("g2", ["b.py"])], negative_space=[
                {"path": "x.py", "reason": "out_of_scope"},
                {"path": "y.py", "reason": "intentionally_preserved"},
            ]),
        ]
        result = collect_negative_space(manifests)
        self.assertEqual(len(result), 2)


class TestCollectOpenQuestions(unittest.TestCase):
    def test_deduplicates_by_id(self):
        manifests = [
            _manifest("0", [_group("g1", ["a.py"])], open_questions=[
                {"id": "q1", "question": "What about X?"},
            ]),
            _manifest("1", [_group("g2", ["b.py"])], open_questions=[
                {"id": "q1", "question": "What about X?"},
                {"id": "q2", "question": "And Y?"},
            ]),
        ]
        result = collect_open_questions(manifests)
        self.assertEqual(len(result), 2)


class TestDetectUncoveredFiles(unittest.TestCase):
    def test_all_covered(self):
        groups = [_group("g1", ["a.py", "b.py"])]
        result = detect_uncovered_files(groups, ["a.py", "b.py"])
        self.assertEqual(result, [])

    def test_some_uncovered(self):
        groups = [_group("g1", ["a.py"])]
        result = detect_uncovered_files(groups, ["a.py", "b.py", "c.py"])
        self.assertEqual(result, ["b.py", "c.py"])


class TestComputeAcbHash(unittest.TestCase):
    def test_deterministic(self):
        acb = {"id": "test", "intent_groups": []}
        h1 = compute_acb_hash(acb)
        h2 = compute_acb_hash(acb)
        self.assertEqual(h1, h2)

    def test_different_content_different_hash(self):
        h1 = compute_acb_hash({"id": "a"})
        h2 = compute_acb_hash({"id": "b"})
        self.assertNotEqual(h1, h2)


if __name__ == "__main__":
    unittest.main()
