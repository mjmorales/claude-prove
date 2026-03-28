"""Tests for PCD artifact schemas and validation."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

# Ensure the parent package is importable when running via pytest from tools/
_pcd_dir = Path(__file__).resolve().parent
if str(_pcd_dir.parent) not in sys.path:
    sys.path.insert(0, str(_pcd_dir.parent))

from pcd.schemas import (  # noqa: E402
    SCHEMA_REGISTRY,
    validate_artifact,
)


# ---------------------------------------------------------------------------
# Fixture builders
# ---------------------------------------------------------------------------


def _make_structural_map() -> dict:
    """Return a minimal valid structural map."""
    return {
        "version": 1,
        "timestamp": "2026-03-28T00:00:00Z",
        "generated_by": "deterministic",
        "summary": {
            "total_files": 2,
            "total_lines": 100,
            "languages": {"python": 80, "markdown": 20},
        },
        "modules": [
            {
                "path": "src/main.py",
                "lines": 80,
                "language": "python",
                "exports": ["main"],
                "imports_from": ["src/util.py"],
                "imported_by": [],
                "cluster_id": 0,
            },
        ],
        "clusters": [
            {
                "id": 0,
                "name": "core",
                "files": ["src/main.py"],
                "internal_edges": 1,
                "external_edges": 0,
            },
        ],
        "dependency_edges": [
            {"from": "src/main.py", "to": "src/util.py", "type": "internal"},
        ],
    }


def _make_triage_card() -> dict:
    """Return a minimal valid full triage card."""
    return {
        "file": "src/main.py",
        "lines": 80,
        "risk": "high",
        "confidence": 4,
        "findings": [
            {
                "category": "error_handling",
                "brief": "Unchecked return value",
                "line_range": [10, 15],
            },
        ],
        "questions": [
            {
                "id": "q-001",
                "referencing_file": "src/main.py",
                "referenced_symbol": "connect",
                "referenced_files": ["src/db.py"],
                "question_type": "error_handling",
                "text": "What happens when connect() fails?",
            },
        ],
    }


def _make_triage_card_clean() -> dict:
    """Return a valid clean-bill triage card."""
    return {
        "file": "src/util.py",
        "lines": 20,
        "risk": "low",
        "confidence": 5,
        "status": "clean",
    }


def _make_triage_manifest() -> dict:
    """Return a minimal valid triage manifest."""
    return {
        "version": 1,
        "stats": {
            "files_reviewed": 2,
            "high_risk": 1,
            "medium_risk": 0,
            "low_risk": 1,
            "total_questions": 1,
        },
        "cards": [_make_triage_card(), _make_triage_card_clean()],
        "question_index": [
            {
                "id": "q-001",
                "from_file": "src/main.py",
                "target_files": ["src/db.py"],
                "question_type": "error_handling",
            },
        ],
    }


def _make_collapsed_manifest() -> dict:
    """Return a minimal valid collapsed manifest."""
    return {
        "version": 1,
        "stats": {
            "total_cards": 5,
            "preserved": 2,
            "collapsed": 3,
            "compression_ratio": 0.6,
        },
        "preserved_cards": [_make_triage_card()],
        "collapsed_summaries": [
            {
                "cluster_id": 1,
                "file_count": 3,
                "files": ["a.py", "b.py", "c.py"],
                "max_risk": "low",
                "aggregate_signals": ["No significant issues"],
            },
        ],
        "question_index": [
            {
                "id": "q-001",
                "from_file": "src/main.py",
                "target_files": ["src/db.py"],
                "question_type": "error_handling",
            },
        ],
    }


def _make_findings_batch() -> dict:
    """Return a minimal valid findings batch."""
    return {
        "batch_id": 1,
        "files_reviewed": ["src/main.py"],
        "findings": [
            {
                "id": "f-001",
                "severity": "critical",
                "category": "error_handling",
                "file": "src/main.py",
                "line_range": [10, 15],
                "title": "Missing error handling",
                "detail": "The connect() call has no error handling.",
                "fix_sketch": "Wrap in try/except and handle ConnectionError.",
            },
        ],
        "answers": [
            {
                "question_id": "q-001",
                "status": "answered",
                "answer": "connect() raises ConnectionError on failure.",
            },
        ],
        "new_questions": [],
    }


def _make_batch_definition() -> dict:
    """Return a minimal valid batch definition."""
    return {
        "batch_id": 1,
        "files": ["src/main.py"],
        "triage_cards": [_make_triage_card()],
        "cluster_context": [
            {
                "id": 0,
                "name": "core",
                "files": ["src/main.py"],
                "internal_edges": 1,
                "external_edges": 0,
            },
        ],
        "routed_questions": [
            {
                "id": "q-001",
                "from_file": "src/main.py",
                "question": "What happens when connect() fails?",
            },
        ],
        "estimated_tokens": 5000,
    }


def _make_pipeline_status() -> dict:
    """Return a minimal valid pipeline status."""
    return {
        "version": 1,
        "started_at": "2026-03-28T00:00:00Z",
        "rounds": {
            "structural_map": {
                "status": "complete",
                "artifact": ".prove/pcd/structural-map.json",
                "duration_s": 12.5,
            },
            "triage": {
                "status": "in_progress",
                "batches_complete": 2,
                "batches_total": 5,
            },
        },
    }


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestValidStructuralMap(unittest.TestCase):
    """Valid structural map validates cleanly."""

    def test_valid(self):
        errors = validate_artifact(_make_structural_map(), "structural_map")
        self.assertEqual(errors, [])


class TestValidTriageCard(unittest.TestCase):
    """Valid triage card (full) validates cleanly."""

    def test_valid(self):
        errors = validate_artifact(_make_triage_card(), "triage_card")
        self.assertEqual(errors, [])


class TestValidTriageCardClean(unittest.TestCase):
    """Valid triage card (clean-bill) validates cleanly."""

    def test_valid(self):
        errors = validate_artifact(_make_triage_card_clean(), "triage_card_clean")
        self.assertEqual(errors, [])


class TestValidTriageManifest(unittest.TestCase):
    """Valid triage manifest validates cleanly."""

    def test_valid(self):
        errors = validate_artifact(_make_triage_manifest(), "triage_manifest")
        self.assertEqual(errors, [])


class TestValidCollapsedManifest(unittest.TestCase):
    """Valid collapsed manifest validates cleanly."""

    def test_valid(self):
        errors = validate_artifact(_make_collapsed_manifest(), "collapsed_manifest")
        self.assertEqual(errors, [])


class TestValidFindingsBatch(unittest.TestCase):
    """Valid findings batch validates cleanly."""

    def test_valid(self):
        errors = validate_artifact(_make_findings_batch(), "findings_batch")
        self.assertEqual(errors, [])


class TestValidBatchDefinition(unittest.TestCase):
    """Valid batch definition validates cleanly."""

    def test_valid(self):
        errors = validate_artifact(_make_batch_definition(), "batch_definition")
        self.assertEqual(errors, [])


class TestValidPipelineStatus(unittest.TestCase):
    """Pipeline status validates cleanly."""

    def test_valid(self):
        errors = validate_artifact(_make_pipeline_status(), "pipeline_status")
        self.assertEqual(errors, [])


class TestMissingRequiredField(unittest.TestCase):
    """Missing required field returns error."""

    def test_missing_version(self):
        data = _make_structural_map()
        del data["version"]
        errors = validate_artifact(data, "structural_map")
        self.assertTrue(any("version" in e and "required" in e for e in errors))

    def test_missing_nested_required(self):
        data = _make_structural_map()
        del data["summary"]["total_files"]
        errors = validate_artifact(data, "structural_map")
        self.assertTrue(
            any("summary.total_files" in e and "required" in e for e in errors)
        )


class TestWrongType(unittest.TestCase):
    """Wrong type returns error."""

    def test_string_instead_of_int(self):
        data = _make_structural_map()
        data["version"] = "one"
        errors = validate_artifact(data, "structural_map")
        self.assertTrue(any("version" in e and "expected int" in e for e in errors))

    def test_int_instead_of_string(self):
        data = _make_triage_card()
        data["file"] = 123
        errors = validate_artifact(data, "triage_card")
        self.assertTrue(any("file" in e and "expected str" in e for e in errors))

    def test_string_instead_of_list(self):
        data = _make_structural_map()
        data["modules"] = "not a list"
        errors = validate_artifact(data, "structural_map")
        self.assertTrue(any("modules" in e and "expected list" in e for e in errors))


class TestInvalidEnumValue(unittest.TestCase):
    """Invalid enum value returns error."""

    def test_bad_risk(self):
        data = _make_triage_card()
        data["risk"] = "extreme"
        errors = validate_artifact(data, "triage_card")
        self.assertTrue(any("risk" in e and "expected one of" in e for e in errors))

    def test_bad_generated_by(self):
        data = _make_structural_map()
        data["generated_by"] = "manual"
        errors = validate_artifact(data, "structural_map")
        self.assertTrue(
            any("generated_by" in e and "expected one of" in e for e in errors)
        )

    def test_bad_edge_type(self):
        data = _make_structural_map()
        data["dependency_edges"][0]["type"] = "cross-module"
        errors = validate_artifact(data, "structural_map")
        self.assertTrue(any("type" in e and "expected one of" in e for e in errors))


class TestNestedValidation(unittest.TestCase):
    """Nested validation catches deep errors."""

    def test_bad_finding_severity_in_batch(self):
        data = _make_findings_batch()
        data["findings"][0]["severity"] = "minor"
        errors = validate_artifact(data, "findings_batch")
        self.assertTrue(
            any(
                "findings[0].severity" in e and "expected one of" in e
                for e in errors
            )
        )

    def test_bad_finding_category_in_triage(self):
        data = _make_triage_card()
        data["findings"][0]["category"] = "style"
        errors = validate_artifact(data, "triage_card")
        self.assertTrue(
            any(
                "findings[0].category" in e and "expected one of" in e
                for e in errors
            )
        )

    def test_bad_question_type(self):
        data = _make_triage_card()
        data["questions"][0]["question_type"] = "unknown"
        errors = validate_artifact(data, "triage_card")
        self.assertTrue(
            any(
                "questions[0].question_type" in e and "expected one of" in e
                for e in errors
            )
        )


class TestEmptyData(unittest.TestCase):
    """Empty data returns errors for all required fields."""

    def test_empty_structural_map(self):
        errors = validate_artifact({}, "structural_map")
        # All required top-level fields should be reported
        required_fields = [
            "version",
            "timestamp",
            "generated_by",
            "summary",
            "modules",
            "clusters",
            "dependency_edges",
        ]
        for field in required_fields:
            self.assertTrue(
                any(field in e and "required" in e for e in errors),
                f"Expected error for missing required field: {field}",
            )

    def test_empty_triage_card(self):
        errors = validate_artifact({}, "triage_card")
        required_fields = ["file", "lines", "risk", "confidence", "findings", "questions"]
        for field in required_fields:
            self.assertTrue(
                any(field in e and "required" in e for e in errors),
                f"Expected error for missing required field: {field}",
            )


class TestSchemaRegistry(unittest.TestCase):
    """Schema registry covers all expected schemas."""

    def test_all_schemas_registered(self):
        expected = {
            "structural_map",
            "triage_card",
            "triage_card_clean",
            "triage_manifest",
            "collapsed_manifest",
            "findings_batch",
            "batch_definition",
            "pipeline_status",
        }
        self.assertEqual(set(SCHEMA_REGISTRY.keys()), expected)

    def test_unknown_schema_returns_error(self):
        errors = validate_artifact({}, "nonexistent")
        self.assertEqual(len(errors), 1)
        self.assertIn("unknown schema", errors[0])


class TestNonDictInput(unittest.TestCase):
    """Non-dict input is rejected."""

    def test_list_input(self):
        errors = validate_artifact([], "structural_map")  # type: ignore[arg-type]
        self.assertEqual(len(errors), 1)
        self.assertIn("expected dict", errors[0])

    def test_string_input(self):
        errors = validate_artifact("hello", "triage_card")  # type: ignore[arg-type]
        self.assertEqual(len(errors), 1)
        self.assertIn("expected dict", errors[0])


if __name__ == "__main__":
    unittest.main()
