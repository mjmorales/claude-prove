"""Tests for acb.store — SQLite-backed ACB storage."""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

_tool_dir = Path(__file__).resolve().parent
if str(_tool_dir.parent) not in sys.path:
    sys.path.insert(0, str(_tool_dir.parent))

from acb.store import Store, open_store


def _manifest(sha: str, groups: list[dict] | None = None) -> dict:
    return {
        "acb_manifest_version": "0.2",
        "commit_sha": sha,
        "timestamp": f"2026-03-29T12:0{sha}:00Z",
        "intent_groups": groups or [
            {"id": "g1", "title": "Test", "classification": "explicit",
             "file_refs": [{"path": "a.py"}], "annotations": []}
        ],
    }


def _acb(branch: str = "feat/x") -> dict:
    return {
        "acb_version": "0.2",
        "id": "test-id",
        "change_set_ref": {"base_ref": "abc", "head_ref": "def"},
        "intent_groups": [
            {"id": "g1", "title": "Test", "classification": "explicit",
             "file_refs": [{"path": "a.py"}]}
        ],
    }


class TestStoreManifests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.store = Store(os.path.join(self.tmp, "acb.db"))

    def tearDown(self):
        self.store.close()

    def test_save_and_has(self):
        self.assertFalse(self.store.has_manifest("feat/x"))
        self.store.save_manifest("feat/x", "abc", _manifest("0"))
        self.assertTrue(self.store.has_manifest("feat/x"))

    def test_branch_isolation(self):
        self.store.save_manifest("feat/x", "abc", _manifest("0"))
        self.assertFalse(self.store.has_manifest("feat/y"))

    def test_list_manifests_sorted(self):
        self.store.save_manifest("feat/x", "sha2", _manifest("2"))
        self.store.save_manifest("feat/x", "sha1", _manifest("1"))
        manifests = self.store.list_manifests("feat/x")
        self.assertEqual(len(manifests), 2)
        self.assertEqual(manifests[0]["commit_sha"], "1")
        self.assertEqual(manifests[1]["commit_sha"], "2")

    def test_clear_manifests(self):
        self.store.save_manifest("feat/x", "abc", _manifest("0"))
        self.store.save_manifest("feat/x", "def", _manifest("1"))
        count = self.store.clear_manifests("feat/x")
        self.assertEqual(count, 2)
        self.assertFalse(self.store.has_manifest("feat/x"))

    def test_clear_stale_manifests(self):
        self.store.save_manifest("feat/x", "abc", _manifest("0"))
        self.store.save_manifest("feat/old", "def", _manifest("1"))
        count = self.store.clear_stale_manifests("feat/x")
        self.assertEqual(count, 1)
        self.assertTrue(self.store.has_manifest("feat/x"))
        self.assertFalse(self.store.has_manifest("feat/old"))


class TestStoreAcb(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.store = Store(os.path.join(self.tmp, "acb.db"))

    def tearDown(self):
        self.store.close()

    def test_save_and_load(self):
        acb = _acb()
        self.store.save_acb("feat/x", acb)
        loaded = self.store.load_acb("feat/x")
        self.assertIsNotNone(loaded)
        self.assertEqual(loaded["id"], "test-id")

    def test_load_missing_returns_none(self):
        self.assertIsNone(self.store.load_acb("feat/x"))

    def test_upsert(self):
        self.store.save_acb("feat/x", {"id": "v1"})
        self.store.save_acb("feat/x", {"id": "v2"})
        loaded = self.store.load_acb("feat/x")
        self.assertEqual(loaded["id"], "v2")

    def test_latest_acb_branch(self):
        self.store.save_acb("feat/old", {"id": "old"})
        self.store.save_acb("feat/new", {"id": "new"})
        self.assertEqual(self.store.latest_acb_branch(), "feat/new")

    def test_latest_acb_branch_empty(self):
        self.assertIsNone(self.store.latest_acb_branch())


class TestStoreReview(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.store = Store(os.path.join(self.tmp, "acb.db"))

    def tearDown(self):
        self.store.close()

    def test_save_and_load(self):
        review = {"overall_verdict": "pending", "group_verdicts": []}
        self.store.save_review("feat/x", "hash123", review)
        loaded = self.store.load_review("feat/x")
        self.assertIsNotNone(loaded)
        self.assertEqual(loaded["overall_verdict"], "pending")

    def test_load_missing_returns_none(self):
        self.assertIsNone(self.store.load_review("feat/x"))

    def test_upsert(self):
        self.store.save_review("feat/x", "h1", {"overall_verdict": "pending"})
        self.store.save_review("feat/x", "h2", {"overall_verdict": "approved"})
        loaded = self.store.load_review("feat/x")
        self.assertEqual(loaded["overall_verdict"], "approved")


class TestStoreCleanup(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.store = Store(os.path.join(self.tmp, "acb.db"))

    def tearDown(self):
        self.store.close()

    def test_clean_branch(self):
        self.store.save_manifest("feat/x", "abc", _manifest("0"))
        self.store.save_acb("feat/x", _acb())
        self.store.save_review("feat/x", "h", {"verdict": "pending"})
        counts = self.store.clean_branch("feat/x")
        self.assertEqual(counts["manifests"], 1)
        self.assertEqual(counts["acb_documents"], 1)
        self.assertEqual(counts["review_state"], 1)
        self.assertFalse(self.store.has_manifest("feat/x"))
        self.assertIsNone(self.store.load_acb("feat/x"))
        self.assertIsNone(self.store.load_review("feat/x"))

    def test_branches(self):
        self.store.save_manifest("feat/a", "abc", _manifest("0"))
        self.store.save_acb("feat/b", _acb())
        self.store.save_review("feat/c", "h", {"verdict": "pending"})
        branches = self.store.branches()
        self.assertEqual(branches, ["feat/a", "feat/b", "feat/c"])


class TestOpenStore(unittest.TestCase):
    def test_creates_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = open_store(tmp)
            self.assertTrue(os.path.exists(os.path.join(tmp, ".prove", "acb.db")))
            store.close()


class TestRunSlug(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.store = Store(os.path.join(self.tmp, "acb.db"))

    def tearDown(self):
        self.store.close()

    def test_save_with_slug_roundtrips(self):
        self.store.save_manifest("feat/x", "abc123", _manifest("0"), run_slug="run-1")
        rows = self.store.list_manifests_by_run("run-1")
        self.assertEqual(len(rows), 1)
        # list_manifests_by_run returns the stored manifest body as-is; _manifest("0")
        # sets commit_sha="0" at manifest-body level, independent of the row's SHA.
        self.assertEqual(rows[0]["commit_sha"], "0")

    def test_list_by_run_is_slug_scoped(self):
        self.store.save_manifest("feat/x", "aaa", _manifest("1"), run_slug="run-A")
        self.store.save_manifest("feat/y", "bbb", _manifest("2"), run_slug="run-B")
        self.store.save_manifest("feat/z", "ccc", _manifest("3"))  # no slug
        self.assertEqual(len(self.store.list_manifests_by_run("run-A")), 1)
        self.assertEqual(len(self.store.list_manifests_by_run("run-B")), 1)
        self.assertEqual(len(self.store.list_manifests_by_run("run-Z")), 0)

    def test_has_manifest_for_sha_with_slug_filter(self):
        self.store.save_manifest("feat/x", "deadbeef", _manifest("0"), run_slug="run-1")
        self.assertTrue(self.store.has_manifest_for_sha("deadbeef"))
        self.assertTrue(self.store.has_manifest_for_sha("dead"))
        self.assertTrue(self.store.has_manifest_for_sha("deadbeef", run_slug="run-1"))
        self.assertFalse(self.store.has_manifest_for_sha("deadbeef", run_slug="run-2"))

    def test_has_manifest_for_sha_null_slug_row_excluded_by_filter(self):
        self.store.save_manifest("feat/x", "aaa", _manifest("0"))  # slug NULL
        self.assertTrue(self.store.has_manifest_for_sha("aaa"))
        self.assertFalse(self.store.has_manifest_for_sha("aaa", run_slug="run-1"))


class TestRunSlugMigration(unittest.TestCase):
    """Older DBs lack the run_slug column; the store must add it on open."""

    def _make_legacy_db(self, path: str) -> None:
        import sqlite3
        conn = sqlite3.connect(path)
        conn.executescript(
            """
            CREATE TABLE manifests (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                branch TEXT NOT NULL,
                commit_sha TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                data TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE acb_documents (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                branch TEXT NOT NULL UNIQUE,
                data TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE review_state (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                branch TEXT NOT NULL UNIQUE,
                acb_hash TEXT NOT NULL,
                data TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            """
        )
        conn.execute(
            "INSERT INTO manifests (branch, commit_sha, timestamp, data, created_at) "
            "VALUES (?, ?, ?, ?, ?)",
            ("feat/old", "oldsha", "2026-01-01", json.dumps(_manifest("0")), "2026-01-01"),
        )
        conn.commit()
        conn.close()

    def test_adds_run_slug_column_on_open(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = os.path.join(tmp, "acb.db")
            self._make_legacy_db(db)

            store = Store(db)
            cols = {r[1] for r in store._conn.execute("PRAGMA table_info(manifests)").fetchall()}
            self.assertIn("run_slug", cols)

            # Pre-existing rows have NULL run_slug and don't match any filter.
            self.assertTrue(store.has_manifest_for_sha("oldsha"))
            self.assertFalse(store.has_manifest_for_sha("oldsha", run_slug="any"))

            # New writes with a slug work.
            store.save_manifest("feat/new", "newsha", _manifest("1"), run_slug="run-1")
            self.assertEqual(len(store.list_manifests_by_run("run-1")), 1)
            store.close()


if __name__ == "__main__":
    unittest.main()
