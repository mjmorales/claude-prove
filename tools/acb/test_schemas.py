"""Tests for acb.schemas validation functions."""

import sys
import unittest
from pathlib import Path

_tool_dir = Path(__file__).resolve().parent
if str(_tool_dir.parent) not in sys.path:
    sys.path.insert(0, str(_tool_dir.parent))

from acb.schemas import validate_manifest, validate_review_state


class TestValidateManifest(unittest.TestCase):
    def _minimal_manifest(self) -> dict:
        return {
            "acb_manifest_version": "0.2",
            "commit_sha": "abc1234",
            "timestamp": "2026-03-29T12:00:00Z",
            "intent_groups": [
                {
                    "id": "feat-auth",
                    "title": "Add authentication",
                    "classification": "explicit",
                    "file_refs": [{"path": "src/auth.py", "ranges": ["1-50"]}],
                    "annotations": [],
                }
            ],
        }

    def test_valid_manifest_no_errors(self):
        errors = validate_manifest(self._minimal_manifest())
        self.assertEqual(errors, [])

    def test_not_a_dict(self):
        errors = validate_manifest("string")
        self.assertEqual(len(errors), 1)
        self.assertIn("JSON object", errors[0])

    def test_missing_required_fields(self):
        errors = validate_manifest({})
        self.assertEqual(len(errors), 4)
        for field in ("acb_manifest_version", "commit_sha", "timestamp", "intent_groups"):
            self.assertTrue(any(field in e for e in errors), f"Missing error for {field}")

    def test_empty_intent_groups(self):
        m = self._minimal_manifest()
        m["intent_groups"] = []
        errors = validate_manifest(m)
        self.assertEqual(len(errors), 1)
        self.assertIn("not be empty", errors[0])

    def test_duplicate_group_ids(self):
        m = self._minimal_manifest()
        m["intent_groups"].append(
            {
                "id": "feat-auth",
                "title": "Duplicate",
                "classification": "inferred",
                "file_refs": [{"path": "src/b.py"}],
            }
        )
        errors = validate_manifest(m)
        self.assertTrue(any("duplicate" in e for e in errors))

    def test_invalid_classification(self):
        m = self._minimal_manifest()
        m["intent_groups"][0]["classification"] = "maybe"
        errors = validate_manifest(m)
        self.assertTrue(any("invalid classification" in e for e in errors))

    def test_missing_group_fields(self):
        m = self._minimal_manifest()
        m["intent_groups"] = [{"id": "x"}]
        errors = validate_manifest(m)
        self.assertTrue(any("title" in e for e in errors))
        self.assertTrue(any("classification" in e for e in errors))
        self.assertTrue(any("file_refs" in e for e in errors))

    def test_empty_file_refs(self):
        m = self._minimal_manifest()
        m["intent_groups"][0]["file_refs"] = []
        errors = validate_manifest(m)
        self.assertTrue(any("non-empty" in e for e in errors))


class TestValidateReviewState(unittest.TestCase):
    def _minimal_review(self) -> dict:
        return {
            "acb_version": "0.2",
            "acb_hash": "deadbeef",
            "acb_id": "test-id",
            "group_verdicts": [
                {"group_id": "feat-auth", "verdict": "pending"},
            ],
            "overall_verdict": "pending",
        }

    def test_valid_review_no_errors(self):
        errors = validate_review_state(self._minimal_review())
        self.assertEqual(errors, [])

    def test_missing_fields(self):
        errors = validate_review_state({})
        self.assertEqual(len(errors), 5)

    def test_invalid_verdict(self):
        r = self._minimal_review()
        r["group_verdicts"][0]["verdict"] = "maybe"
        errors = validate_review_state(r)
        self.assertTrue(any("invalid verdict" in e for e in errors))

    def test_invalid_overall_verdict(self):
        r = self._minimal_review()
        r["overall_verdict"] = "dunno"
        errors = validate_review_state(r)
        self.assertTrue(any("overall_verdict" in e for e in errors))

    def test_missing_group_id(self):
        r = self._minimal_review()
        r["group_verdicts"] = [{"verdict": "accepted"}]
        errors = validate_review_state(r)
        self.assertTrue(any("group_id" in e for e in errors))


if __name__ == "__main__":
    unittest.main()
