"""Tests for PCD collapse round logic."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

_pcd_dir = Path(__file__).resolve().parent
if str(_pcd_dir.parent) not in sys.path:
    sys.path.insert(0, str(_pcd_dir.parent))

from pcd.collapse import collapse_manifest  # noqa: E402
from pcd.schemas import validate_artifact  # noqa: E402


# ---------------------------------------------------------------------------
# Fixture builders
# ---------------------------------------------------------------------------


def _make_card(
    file: str = "src/main.py",
    risk: str = "high",
    confidence: int = 4,
    findings: list[dict] | None = None,
    questions: list[dict] | None = None,
    cluster_id: int | None = None,
    status: str | None = None,
) -> dict:
    """Build a triage card with configurable risk/confidence."""
    card: dict = {
        "file": file,
        "lines": 100,
        "risk": risk,
        "confidence": confidence,
        "findings": findings
        or [
            {
                "category": "error_handling",
                "brief": f"Issue in {file}",
                "line_range": [1, 10],
            }
        ],
        "questions": questions or [],
    }
    if cluster_id is not None:
        card["cluster_id"] = cluster_id
    if status is not None:
        card["status"] = status
    return card


def _make_clean_card(
    file: str = "src/util.py",
    confidence: int = 5,
) -> dict:
    """Build a clean-bill triage card."""
    return {
        "file": file,
        "lines": 20,
        "risk": "low",
        "confidence": confidence,
        "status": "clean",
    }


def _make_manifest(
    cards: list[dict],
    question_index: list[dict] | None = None,
) -> dict:
    """Build a triage manifest wrapping the given cards."""
    return {
        "version": 1,
        "stats": {
            "files_reviewed": len(cards),
            "high_risk": sum(1 for c in cards if c.get("risk") == "high"),
            "medium_risk": sum(1 for c in cards if c.get("risk") == "medium"),
            "low_risk": sum(1 for c in cards if c.get("risk") == "low"),
            "total_questions": sum(
                len(c.get("questions", [])) for c in cards
            ),
        },
        "cards": cards,
        "question_index": question_index or [],
    }


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestPreserveHighRisk(unittest.TestCase):
    """Cards with risk 'high' or 'critical' are preserved."""

    def test_high_risk_preserved(self) -> None:
        manifest = _make_manifest(
            [
                _make_card(file="a.py", risk="high", confidence=5),
                _make_card(file="b.py", risk="critical", confidence=5),
            ]
        )
        result = collapse_manifest(manifest)
        self.assertEqual(result["stats"]["preserved"], 2)
        self.assertEqual(result["stats"]["collapsed"], 0)
        preserved_files = [c["file"] for c in result["preserved_cards"]]
        self.assertIn("a.py", preserved_files)
        self.assertIn("b.py", preserved_files)


class TestPreserveMediumRisk(unittest.TestCase):
    """Cards with risk 'medium' are preserved."""

    def test_medium_risk_preserved(self) -> None:
        manifest = _make_manifest(
            [_make_card(file="a.py", risk="medium", confidence=5)]
        )
        result = collapse_manifest(manifest)
        self.assertEqual(result["stats"]["preserved"], 1)
        self.assertEqual(result["stats"]["collapsed"], 0)


class TestPreserveLowConfidence(unittest.TestCase):
    """Cards with confidence <= 3 are preserved regardless of risk."""

    def test_low_confidence_low_risk_preserved(self) -> None:
        manifest = _make_manifest(
            [_make_card(file="a.py", risk="low", confidence=3)]
        )
        result = collapse_manifest(manifest)
        self.assertEqual(result["stats"]["preserved"], 1)
        self.assertEqual(result["stats"]["collapsed"], 0)

    def test_confidence_2_preserved(self) -> None:
        manifest = _make_manifest(
            [_make_card(file="a.py", risk="low", confidence=2)]
        )
        result = collapse_manifest(manifest)
        self.assertEqual(result["stats"]["preserved"], 1)

    def test_confidence_1_preserved(self) -> None:
        manifest = _make_manifest(
            [_make_card(file="a.py", risk="low", confidence=1)]
        )
        result = collapse_manifest(manifest)
        self.assertEqual(result["stats"]["preserved"], 1)


class TestCollapseLowRiskHighConfidence(unittest.TestCase):
    """Cards with risk 'low' and confidence >= 4 are collapsed."""

    def test_low_risk_high_confidence_collapsed(self) -> None:
        manifest = _make_manifest(
            [_make_card(file="a.py", risk="low", confidence=4)]
        )
        result = collapse_manifest(manifest)
        self.assertEqual(result["stats"]["preserved"], 0)
        self.assertEqual(result["stats"]["collapsed"], 1)
        self.assertEqual(len(result["collapsed_summaries"]), 1)

    def test_confidence_5_collapsed(self) -> None:
        manifest = _make_manifest(
            [_make_card(file="a.py", risk="low", confidence=5)]
        )
        result = collapse_manifest(manifest)
        self.assertEqual(result["stats"]["collapsed"], 1)


class TestCleanBillAlwaysCollapsed(unittest.TestCase):
    """Cards with status 'clean' are always collapsed."""

    def test_clean_card_collapsed(self) -> None:
        manifest = _make_manifest([_make_clean_card()])
        result = collapse_manifest(manifest)
        self.assertEqual(result["stats"]["collapsed"], 1)
        self.assertEqual(result["stats"]["preserved"], 0)

    def test_clean_card_collapsed_even_low_confidence(self) -> None:
        """Clean cards collapse even when confidence is low."""
        card = _make_clean_card()
        card["confidence"] = 1
        manifest = _make_manifest([card])
        result = collapse_manifest(manifest)
        self.assertEqual(result["stats"]["collapsed"], 1)
        self.assertEqual(result["stats"]["preserved"], 0)


class TestQuestionsAlwaysPreserved(unittest.TestCase):
    """Question index passes through regardless of card collapsing."""

    def test_questions_pass_through(self) -> None:
        questions = [
            {
                "id": "q-001",
                "from_file": "src/main.py",
                "target_files": ["src/db.py"],
                "question_type": "error_handling",
            },
            {
                "id": "q-002",
                "from_file": "src/util.py",
                "target_files": ["src/config.py"],
                "question_type": "contract",
            },
        ]
        # All cards are low-risk, high-confidence (will be collapsed)
        manifest = _make_manifest(
            [
                _make_card(file="src/main.py", risk="low", confidence=5),
                _make_card(file="src/util.py", risk="low", confidence=5),
            ],
            question_index=questions,
        )
        result = collapse_manifest(manifest)
        self.assertEqual(result["question_index"], questions)
        self.assertEqual(len(result["question_index"]), 2)


class TestCompressionRatio(unittest.TestCase):
    """Verify stats.compression_ratio is calculated correctly."""

    def test_half_collapsed(self) -> None:
        manifest = _make_manifest(
            [
                _make_card(file="a.py", risk="high", confidence=5),  # preserve
                _make_card(file="b.py", risk="low", confidence=5),  # collapse
            ]
        )
        result = collapse_manifest(manifest)
        self.assertAlmostEqual(result["stats"]["compression_ratio"], 0.5)

    def test_all_collapsed(self) -> None:
        manifest = _make_manifest(
            [
                _make_card(file="a.py", risk="low", confidence=5),
                _make_card(file="b.py", risk="low", confidence=5),
            ]
        )
        result = collapse_manifest(manifest)
        self.assertAlmostEqual(result["stats"]["compression_ratio"], 1.0)

    def test_none_collapsed(self) -> None:
        manifest = _make_manifest(
            [_make_card(file="a.py", risk="high", confidence=5)]
        )
        result = collapse_manifest(manifest)
        self.assertAlmostEqual(result["stats"]["compression_ratio"], 0.0)


class TestAllHighRisk(unittest.TestCase):
    """When all cards are high risk, no collapse happens."""

    def test_no_collapse(self) -> None:
        manifest = _make_manifest(
            [
                _make_card(file="a.py", risk="high"),
                _make_card(file="b.py", risk="critical"),
                _make_card(file="c.py", risk="high"),
            ]
        )
        result = collapse_manifest(manifest)
        self.assertEqual(result["stats"]["preserved"], 3)
        self.assertEqual(result["stats"]["collapsed"], 0)
        self.assertEqual(len(result["collapsed_summaries"]), 0)


class TestAllLowRisk(unittest.TestCase):
    """When all cards are low risk with high confidence, all are collapsed."""

    def test_all_collapsed(self) -> None:
        manifest = _make_manifest(
            [
                _make_card(file="a.py", risk="low", confidence=5),
                _make_card(file="b.py", risk="low", confidence=4),
                _make_card(file="c.py", risk="low", confidence=5),
            ]
        )
        result = collapse_manifest(manifest)
        self.assertEqual(result["stats"]["preserved"], 0)
        self.assertEqual(result["stats"]["collapsed"], 3)
        self.assertTrue(len(result["collapsed_summaries"]) >= 1)


class TestEmptyManifest(unittest.TestCase):
    """Empty cards list produces valid output."""

    def test_empty(self) -> None:
        manifest = _make_manifest([])
        result = collapse_manifest(manifest)
        self.assertEqual(result["stats"]["total_cards"], 0)
        self.assertEqual(result["stats"]["preserved"], 0)
        self.assertEqual(result["stats"]["collapsed"], 0)
        self.assertAlmostEqual(result["stats"]["compression_ratio"], 0.0)
        self.assertEqual(result["preserved_cards"], [])
        self.assertEqual(result["collapsed_summaries"], [])

    def test_empty_validates(self) -> None:
        manifest = _make_manifest([])
        result = collapse_manifest(manifest)
        errors = validate_artifact(result, "collapsed_manifest")
        self.assertEqual(errors, [])


class TestAggregateSignals(unittest.TestCase):
    """Collapsed summaries include deduplicated signals."""

    def test_dedup_signals(self) -> None:
        cards = [
            _make_card(
                file="src/a.py",
                risk="low",
                confidence=5,
                findings=[
                    {
                        "category": "naming",
                        "brief": "Inconsistent naming",
                        "line_range": [1, 5],
                    },
                    {
                        "category": "dead_code",
                        "brief": "Unused import",
                        "line_range": [6, 6],
                    },
                ],
                cluster_id=1,
            ),
            _make_card(
                file="src/b.py",
                risk="low",
                confidence=5,
                findings=[
                    {
                        "category": "naming",
                        "brief": "Inconsistent naming",  # duplicate
                        "line_range": [1, 3],
                    },
                    {
                        "category": "performance",
                        "brief": "Unoptimized loop",
                        "line_range": [10, 20],
                    },
                ],
                cluster_id=1,
            ),
        ]
        manifest = _make_manifest(cards)
        result = collapse_manifest(manifest)

        self.assertEqual(len(result["collapsed_summaries"]), 1)
        summary = result["collapsed_summaries"][0]
        signals = summary["aggregate_signals"]
        # "Inconsistent naming" appears only once despite being in both cards
        self.assertEqual(signals.count("Inconsistent naming"), 1)
        self.assertIn("Unused import", signals)
        self.assertIn("Unoptimized loop", signals)
        self.assertEqual(len(signals), 3)

    def test_schema_valid(self) -> None:
        """Collapsed manifest output conforms to COLLAPSED_MANIFEST_SCHEMA."""
        manifest = _make_manifest(
            [
                _make_card(file="a.py", risk="high", confidence=4),
                _make_card(
                    file="b.py", risk="low", confidence=5, cluster_id=1
                ),
                _make_clean_card(file="c.py"),
            ],
            question_index=[
                {
                    "id": "q-001",
                    "from_file": "a.py",
                    "target_files": ["b.py"],
                    "question_type": "error_handling",
                }
            ],
        )
        result = collapse_manifest(manifest)
        errors = validate_artifact(result, "collapsed_manifest")
        self.assertEqual(errors, [], f"Validation errors: {errors}")


if __name__ == "__main__":
    unittest.main()
