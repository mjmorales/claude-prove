"""Tests for the CAFI index manager."""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

# Ensure the parent package is importable when running via unittest discover
_cafi_dir = Path(__file__).resolve().parent
if str(_cafi_dir.parent) not in sys.path:
    sys.path.insert(0, str(_cafi_dir.parent))

from cafi.indexer import (  # noqa: E402
    MissingConfigError,
    build_index,
    clear_cache,
    format_index_for_context,
    get_description,
    get_status,
    load_config,
)


def _write_prove_json(tmpdir: str, index_cfg: dict | None = None) -> None:
    """Write a minimal .prove.json to tmpdir."""
    config: dict = {}
    if index_cfg:
        config["index"] = index_cfg
    with open(os.path.join(tmpdir, ".prove.json"), "w") as fh:
        json.dump(config, fh)


class TestLoadConfig(unittest.TestCase):
    """Tests for load_config."""

    def test_load_config_missing_raises(self):
        """No .prove.json present — raises MissingConfigError by default."""
        with tempfile.TemporaryDirectory() as tmpdir:
            with self.assertRaises(MissingConfigError):
                load_config(tmpdir)

    def test_load_config_missing_no_require(self):
        """No .prove.json present with require=False — returns defaults."""
        with tempfile.TemporaryDirectory() as tmpdir:
            cfg = load_config(tmpdir, require=False)
            self.assertEqual(cfg["excludes"], [])
            self.assertEqual(cfg["max_file_size"], 102400)
            self.assertEqual(cfg["concurrency"], 3)

    def test_load_config_from_file(self):
        """Reads index key from .prove.json and merges with defaults."""
        with tempfile.TemporaryDirectory() as tmpdir:
            prove_json = os.path.join(tmpdir, ".prove.json")
            with open(prove_json, "w") as fh:
                json.dump(
                    {"index": {"excludes": ["dist"], "concurrency": 5}},
                    fh,
                )
            cfg = load_config(tmpdir)
            self.assertEqual(cfg["excludes"], ["dist"])
            self.assertEqual(cfg["concurrency"], 5)
            # max_file_size should still be the default
            self.assertEqual(cfg["max_file_size"], 102400)


class TestBuildIndex(unittest.TestCase):
    """Tests for build_index."""

    def test_build_index_no_config_raises(self):
        """build_index raises MissingConfigError without .prove.json."""
        with tempfile.TemporaryDirectory() as tmpdir:
            with self.assertRaises(MissingConfigError):
                build_index(tmpdir)

    @patch("cafi.indexer.triage_files", side_effect=lambda files: files)
    @patch("cafi.indexer.describe_files")
    def test_build_index_new_files(self, mock_describe, _mock_triage):
        """New files get described and written to cache."""
        mock_describe.return_value = {
            "hello.py": "Read this file when greeting users.",
        }
        with tempfile.TemporaryDirectory() as tmpdir:
            # Create .prove dir, .prove.json, and a source file
            os.makedirs(os.path.join(tmpdir, ".prove"))
            _write_prove_json(tmpdir)
            hello = os.path.join(tmpdir, "hello.py")
            with open(hello, "w") as fh:
                fh.write("print('hello')\n")

            summary = build_index(tmpdir)
            self.assertEqual(summary["new"], 1)
            self.assertEqual(summary["stale"], 0)
            self.assertEqual(summary["deleted"], 0)
            self.assertEqual(summary["total"], 1)

            # Verify cache was written
            cache_path = os.path.join(tmpdir, ".prove", "file-index.json")
            self.assertTrue(os.path.isfile(cache_path))
            with open(cache_path) as fh:
                cache = json.load(fh)
            self.assertIn("hello.py", cache["files"])
            self.assertEqual(
                cache["files"]["hello.py"]["description"],
                "Read this file when greeting users.",
            )

    @patch("cafi.indexer.triage_files", side_effect=lambda files: files)
    @patch("cafi.indexer.describe_files")
    def test_build_index_incremental(self, mock_describe, _mock_triage):
        """Only stale files are re-described on incremental run."""
        with tempfile.TemporaryDirectory() as tmpdir:
            os.makedirs(os.path.join(tmpdir, ".prove"))
            _write_prove_json(tmpdir)

            # Create two source files
            for name in ("a.py", "b.py"):
                with open(os.path.join(tmpdir, name), "w") as fh:
                    fh.write(f"# {name}\n")

            # First run — describe both
            mock_describe.return_value = {
                "a.py": "Desc A",
                "b.py": "Desc B",
            }
            build_index(tmpdir)
            mock_describe.reset_mock()

            # Modify only a.py
            with open(os.path.join(tmpdir, "a.py"), "w") as fh:
                fh.write("# a.py modified\n")

            mock_describe.return_value = {"a.py": "Desc A v2"}
            summary = build_index(tmpdir)

            # Only a.py should be stale
            self.assertEqual(summary["stale"], 1)
            self.assertEqual(summary["unchanged"], 1)
            self.assertEqual(summary["new"], 0)

            # describe_files should have been called with only a.py
            called_paths = mock_describe.call_args[0][0]
            self.assertEqual(called_paths, ["a.py"])

    @patch("cafi.indexer.triage_files", side_effect=lambda files: files)
    @patch("cafi.indexer.describe_files")
    def test_build_index_force(self, mock_describe, _mock_triage):
        """force=True re-describes all files."""
        with tempfile.TemporaryDirectory() as tmpdir:
            os.makedirs(os.path.join(tmpdir, ".prove"))
            _write_prove_json(tmpdir)

            with open(os.path.join(tmpdir, "x.py"), "w") as fh:
                fh.write("# x\n")

            # First run
            mock_describe.return_value = {"x.py": "Desc X"}
            build_index(tmpdir)
            mock_describe.reset_mock()

            # Second run with force — file unchanged but should still be described
            mock_describe.return_value = {"x.py": "Desc X v2"}
            summary = build_index(tmpdir, force=True)

            self.assertEqual(summary["total"], 1)
            # describe_files should have been called
            mock_describe.assert_called_once()
            called_paths = mock_describe.call_args[0][0]
            self.assertIn("x.py", called_paths)


class TestGetStatus(unittest.TestCase):
    """Tests for get_status."""

    def test_get_status(self):
        """Verify status returns correct counts."""
        with tempfile.TemporaryDirectory() as tmpdir:
            os.makedirs(os.path.join(tmpdir, ".prove"))
            _write_prove_json(tmpdir)
            with open(os.path.join(tmpdir, "f.py"), "w") as fh:
                fh.write("# f\n")

            status = get_status(tmpdir)
            self.assertEqual(status["new"], 1)
            self.assertEqual(status["stale"], 0)
            self.assertEqual(status["deleted"], 0)
            self.assertEqual(status["unchanged"], 0)
            self.assertFalse(status["cache_exists"])


class TestClearCache(unittest.TestCase):
    """Tests for clear_cache."""

    def test_clear_cache(self):
        """Verify cache file is deleted."""
        with tempfile.TemporaryDirectory() as tmpdir:
            cache_path = os.path.join(tmpdir, ".prove", "file-index.json")
            os.makedirs(os.path.dirname(cache_path))
            with open(cache_path, "w") as fh:
                json.dump({"version": 1, "files": {}}, fh)

            self.assertTrue(clear_cache(tmpdir))
            self.assertFalse(os.path.isfile(cache_path))

    def test_clear_cache_no_file(self):
        """Returns False when no cache exists."""
        with tempfile.TemporaryDirectory() as tmpdir:
            self.assertFalse(clear_cache(tmpdir))


class TestGetDescription(unittest.TestCase):
    """Tests for get_description."""

    def test_get_description_found(self):
        """Returns description when file is in cache."""
        with tempfile.TemporaryDirectory() as tmpdir:
            cache_path = os.path.join(tmpdir, ".prove", "file-index.json")
            os.makedirs(os.path.dirname(cache_path))
            with open(cache_path, "w") as fh:
                json.dump(
                    {"version": 1, "files": {"a.py": {"hash": "abc", "description": "Desc A"}}},
                    fh,
                )
            self.assertEqual(get_description(tmpdir, "a.py"), "Desc A")

    def test_get_description_not_found(self):
        """Returns None when file is not in cache."""
        with tempfile.TemporaryDirectory() as tmpdir:
            self.assertIsNone(get_description(tmpdir, "missing.py"))


class TestFormatIndexForContext(unittest.TestCase):
    """Tests for format_index_for_context."""

    def test_format_index_for_context(self):
        """Verify markdown format output."""
        with tempfile.TemporaryDirectory() as tmpdir:
            cache_path = os.path.join(tmpdir, ".prove", "file-index.json")
            os.makedirs(os.path.dirname(cache_path))
            with open(cache_path, "w") as fh:
                json.dump(
                    {
                        "version": 1,
                        "files": {
                            "b.py": {"hash": "h2", "description": "Desc B"},
                            "a.py": {"hash": "h1", "description": "Desc A"},
                        },
                    },
                    fh,
                )

            output = format_index_for_context(tmpdir)
            self.assertIn("# Project File Index", output)
            # a.py should come before b.py (sorted)
            idx_a = output.index("`a.py`")
            idx_b = output.index("`b.py`")
            self.assertLess(idx_a, idx_b)
            self.assertIn("- `a.py`: Desc A", output)
            self.assertIn("- `b.py`: Desc B", output)

    def test_format_index_empty_cache(self):
        """Returns empty string when no files indexed."""
        with tempfile.TemporaryDirectory() as tmpdir:
            output = format_index_for_context(tmpdir)
            self.assertEqual(output, "")


if __name__ == "__main__":
    unittest.main()
