"""Tests for PCD Round 2 batch formation."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

_pcd_dir = Path(__file__).resolve().parent
if str(_pcd_dir.parent) not in sys.path:
    sys.path.insert(0, str(_pcd_dir.parent))

from pcd.batch_former import _estimate_tokens, form_batches  # noqa: E402
from pcd.schemas import validate_artifact  # noqa: E402


# ---------------------------------------------------------------------------
# Fixture builders
# ---------------------------------------------------------------------------


def _make_triage_card(
    file: str = "src/main.py",
    risk: str = "high",
    confidence: int = 4,
) -> dict:
    """Build a preserved triage card."""
    return {
        "file": file,
        "lines": 100,
        "risk": risk,
        "confidence": confidence,
        "findings": [
            {
                "category": "error_handling",
                "brief": f"Issue in {file}",
                "line_range": [1, 10],
            },
        ],
        "questions": [],
    }


def _make_collapsed_manifest(
    preserved_cards: list[dict],
    question_index: list[dict] | None = None,
) -> dict:
    """Build a collapsed manifest with given preserved cards."""
    return {
        "version": 1,
        "stats": {
            "total_cards": len(preserved_cards) + 2,
            "preserved": len(preserved_cards),
            "collapsed": 2,
            "compression_ratio": 2 / (len(preserved_cards) + 2)
            if preserved_cards
            else 0.0,
        },
        "preserved_cards": preserved_cards,
        "collapsed_summaries": [
            {
                "cluster_id": 99,
                "file_count": 2,
                "files": ["lib/helper.py", "lib/utils.py"],
                "max_risk": "low",
                "aggregate_signals": ["Minor style issue"],
            }
        ],
        "question_index": question_index or [],
    }


def _make_structural_map(
    modules: list[dict] | None = None,
    clusters: list[dict] | None = None,
) -> dict:
    """Build a minimal structural map."""
    return {
        "version": 1,
        "timestamp": "2026-03-28T00:00:00Z",
        "generated_by": "deterministic",
        "summary": {
            "total_files": 5,
            "total_lines": 500,
            "languages": {"python": 500},
        },
        "modules": modules
        or [
            {
                "path": "src/main.py",
                "lines": 100,
                "language": "python",
                "exports": ["main"],
                "imports_from": ["src/util.py"],
                "imported_by": [],
                "cluster_id": 0,
            },
            {
                "path": "src/util.py",
                "lines": 50,
                "language": "python",
                "exports": ["helper"],
                "imports_from": [],
                "imported_by": ["src/main.py"],
                "cluster_id": 0,
            },
            {
                "path": "src/db.py",
                "lines": 80,
                "language": "python",
                "exports": ["connect"],
                "imports_from": [],
                "imported_by": ["src/main.py"],
                "cluster_id": 1,
            },
        ],
        "clusters": clusters
        or [
            {
                "id": 0,
                "name": "core",
                "files": ["src/main.py", "src/util.py"],
                "internal_edges": 1,
                "external_edges": 0,
            },
            {
                "id": 1,
                "name": "data",
                "files": ["src/db.py"],
                "internal_edges": 0,
                "external_edges": 1,
            },
        ],
        "dependency_edges": [
            {"from": "src/main.py", "to": "src/util.py", "type": "internal"},
            {"from": "src/main.py", "to": "src/db.py", "type": "internal"},
        ],
    }


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestBasicBatching(unittest.TestCase):
    """Preserved cards grouped by cluster produce batches."""

    def test_two_clusters_two_batches(self) -> None:
        cards = [
            _make_triage_card(file="src/main.py"),
            _make_triage_card(file="src/util.py"),
            _make_triage_card(file="src/db.py"),
        ]
        manifest = _make_collapsed_manifest(cards)
        struct_map = _make_structural_map()

        batches = form_batches(manifest, struct_map)

        self.assertEqual(len(batches), 2)
        # Cluster 0 has main.py and util.py
        cluster0_batch = next(
            b for b in batches if "src/main.py" in b["files"]
        )
        self.assertIn("src/util.py", cluster0_batch["files"])
        # Cluster 1 has db.py
        cluster1_batch = next(
            b for b in batches if "src/db.py" in b["files"]
        )
        self.assertEqual(cluster1_batch["files"], ["src/db.py"])

    def test_batch_ids_sequential(self) -> None:
        cards = [
            _make_triage_card(file="src/main.py"),
            _make_triage_card(file="src/db.py"),
        ]
        manifest = _make_collapsed_manifest(cards)
        struct_map = _make_structural_map()

        batches = form_batches(manifest, struct_map)
        ids = [b["batch_id"] for b in batches]
        self.assertEqual(ids, list(range(1, len(batches) + 1)))


class TestSplitLargeCluster(unittest.TestCase):
    """Cluster with > max_files_per_batch splits into multiple batches."""

    def test_split(self) -> None:
        # Create 5 files in the same cluster, with max_files_per_batch=2
        files = [f"src/mod{i}.py" for i in range(5)]
        cards = [_make_triage_card(file=f) for f in files]
        modules = [
            {
                "path": f,
                "lines": 50,
                "language": "python",
                "exports": [],
                "imports_from": [],
                "imported_by": [],
                "cluster_id": 0,
            }
            for f in files
        ]
        clusters = [
            {
                "id": 0,
                "name": "big_cluster",
                "files": files,
                "internal_edges": 4,
                "external_edges": 0,
            }
        ]
        manifest = _make_collapsed_manifest(cards)
        struct_map = _make_structural_map(modules=modules, clusters=clusters)

        batches = form_batches(manifest, struct_map, max_files_per_batch=2)

        # 5 files / 2 per batch = 3 batches
        self.assertEqual(len(batches), 3)
        total_files = sum(len(b["files"]) for b in batches)
        self.assertEqual(total_files, 5)
        for batch in batches:
            self.assertLessEqual(len(batch["files"]), 2)


class TestQuestionRouting(unittest.TestCase):
    """Questions routed to batch containing target file."""

    def test_direct_routing(self) -> None:
        cards = [
            _make_triage_card(file="src/main.py"),
            _make_triage_card(file="src/db.py"),
        ]
        questions = [
            {
                "id": "q-001",
                "from_file": "src/main.py",
                "target_files": ["src/db.py"],
                "question_type": "error_handling",
                "text": "What happens on connection failure?",
            }
        ]
        manifest = _make_collapsed_manifest(cards, question_index=questions)
        struct_map = _make_structural_map()

        batches = form_batches(manifest, struct_map)

        # Question should go to the batch containing src/db.py
        db_batch = next(b for b in batches if "src/db.py" in b["files"])
        self.assertEqual(len(db_batch["routed_questions"]), 1)
        self.assertEqual(
            db_batch["routed_questions"][0]["id"], "q-001"
        )


class TestUnroutableQuestion(unittest.TestCase):
    """Question with target file not in any batch goes to closest batch."""

    def test_fallback_routing(self) -> None:
        cards = [
            _make_triage_card(file="src/main.py"),
            _make_triage_card(file="src/db.py"),
        ]
        questions = [
            {
                "id": "q-002",
                "from_file": "src/main.py",
                "target_files": ["src/config.py"],  # not in any batch
                "question_type": "contract",
                "text": "What is the config schema?",
            }
        ]
        manifest = _make_collapsed_manifest(cards, question_index=questions)
        struct_map = _make_structural_map()

        batches = form_batches(manifest, struct_map)

        # Question should be routed to *some* batch (fallback)
        all_routed = [
            q
            for b in batches
            for q in b["routed_questions"]
        ]
        self.assertEqual(len(all_routed), 1)
        self.assertEqual(all_routed[0]["id"], "q-002")


class TestEmptyManifest(unittest.TestCase):
    """Empty preserved cards produce no batches."""

    def test_no_batches(self) -> None:
        manifest = _make_collapsed_manifest([])
        struct_map = _make_structural_map()

        batches = form_batches(manifest, struct_map)
        self.assertEqual(batches, [])


class TestSingleFileBatch(unittest.TestCase):
    """Single preserved card creates single-file batch."""

    def test_single_file(self) -> None:
        cards = [_make_triage_card(file="src/main.py")]
        manifest = _make_collapsed_manifest(cards)
        struct_map = _make_structural_map()

        batches = form_batches(manifest, struct_map)

        self.assertEqual(len(batches), 1)
        self.assertEqual(batches[0]["files"], ["src/main.py"])
        self.assertEqual(len(batches[0]["triage_cards"]), 1)


class TestClusterContextAttached(unittest.TestCase):
    """Each batch includes relevant cluster metadata."""

    def test_cluster_context(self) -> None:
        cards = [
            _make_triage_card(file="src/main.py"),
            _make_triage_card(file="src/db.py"),
        ]
        manifest = _make_collapsed_manifest(cards)
        struct_map = _make_structural_map()

        batches = form_batches(manifest, struct_map)

        for batch in batches:
            # Each batch should have cluster context
            self.assertIsInstance(batch["cluster_context"], list)
            if batch["cluster_context"]:
                ctx = batch["cluster_context"][0]
                self.assertIn("id", ctx)
                self.assertIn("name", ctx)
                self.assertIn("files", ctx)

    def test_correct_cluster_assignment(self) -> None:
        cards = [
            _make_triage_card(file="src/main.py"),  # cluster 0
            _make_triage_card(file="src/db.py"),  # cluster 1
        ]
        manifest = _make_collapsed_manifest(cards)
        struct_map = _make_structural_map()

        batches = form_batches(manifest, struct_map)

        core_batch = next(b for b in batches if "src/main.py" in b["files"])
        self.assertEqual(core_batch["cluster_context"][0]["name"], "core")

        data_batch = next(b for b in batches if "src/db.py" in b["files"])
        self.assertEqual(data_batch["cluster_context"][0]["name"], "data")


class TestTokenEstimation(unittest.TestCase):
    """Estimated tokens > 0 for non-empty batches."""

    def test_nonzero_tokens(self) -> None:
        cards = [_make_triage_card(file="src/main.py")]
        manifest = _make_collapsed_manifest(cards)
        struct_map = _make_structural_map()

        batches = form_batches(manifest, struct_map)

        self.assertGreater(len(batches), 0)
        for batch in batches:
            self.assertGreater(batch["estimated_tokens"], 0)

    def test_estimate_tokens_fallback(self) -> None:
        """Token estimation falls back for non-existent files."""
        tokens = _estimate_tokens(["nonexistent/file.py"], ".")
        self.assertGreater(tokens, 0)


class TestBatchSchemaValidation(unittest.TestCase):
    """Batch definitions conform to BATCH_DEFINITION_SCHEMA."""

    def test_valid_schema(self) -> None:
        cards = [
            _make_triage_card(file="src/main.py"),
            _make_triage_card(file="src/db.py"),
        ]
        questions = [
            {
                "id": "q-001",
                "from_file": "src/main.py",
                "target_files": ["src/db.py"],
                "question_type": "error_handling",
                "text": "What happens on failure?",
            }
        ]
        manifest = _make_collapsed_manifest(cards, question_index=questions)
        struct_map = _make_structural_map()

        batches = form_batches(manifest, struct_map)

        for batch in batches:
            errors = validate_artifact(batch, "batch_definition")
            self.assertEqual(
                errors, [], f"Batch {batch['batch_id']} errors: {errors}"
            )


if __name__ == "__main__":
    unittest.main()
