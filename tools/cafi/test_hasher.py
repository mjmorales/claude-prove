"""Tests for the CAFI file hasher and cache manager."""

import hashlib
import json
import os
import tempfile
import unittest
from pathlib import Path

import sys as _sys

_sys.path.insert(0, str(Path(__file__).resolve().parent))

from hasher import (  # noqa: E402
    _git_check_ignore,
    compute_hash,
    diff_cache,
    is_binary,
    load_cache,
    save_cache,
    walk_project,
)


class TestComputeHash(unittest.TestCase):
    """Test compute_hash returns correct SHA256 digest."""

    def test_compute_hash(self):
        content = b"hello world\n"
        expected = hashlib.sha256(content).hexdigest()

        with tempfile.NamedTemporaryFile(delete=False) as f:
            f.write(content)
            f.flush()
            tmp = f.name

        try:
            result = compute_hash(tmp)
            self.assertEqual(result, expected)
        finally:
            os.unlink(tmp)

    def test_compute_hash_empty_file(self):
        expected = hashlib.sha256(b"").hexdigest()

        with tempfile.NamedTemporaryFile(delete=False) as f:
            tmp = f.name

        try:
            result = compute_hash(tmp)
            self.assertEqual(result, expected)
        finally:
            os.unlink(tmp)


class TestIsBinary(unittest.TestCase):
    """Test is_binary detection."""

    def test_text_file(self):
        with tempfile.NamedTemporaryFile(delete=False, suffix=".txt") as f:
            f.write(b"This is plain text.\nLine two.\n")
            tmp = f.name

        try:
            self.assertFalse(is_binary(tmp))
        finally:
            os.unlink(tmp)

    def test_binary_file(self):
        with tempfile.NamedTemporaryFile(delete=False, suffix=".bin") as f:
            f.write(b"\x00\x01\x02\x03\x89PNG\r\n")
            tmp = f.name

        try:
            self.assertTrue(is_binary(tmp))
        finally:
            os.unlink(tmp)

    def test_empty_file_is_not_binary(self):
        with tempfile.NamedTemporaryFile(delete=False) as f:
            tmp = f.name

        try:
            self.assertFalse(is_binary(tmp))
        finally:
            os.unlink(tmp)


class TestDiffCache(unittest.TestCase):
    """Test diff_cache identifies new, stale, deleted, and unchanged files."""

    def test_all_categories(self):
        current_files = {
            "new_file.py": "aaa111",
            "changed.py": "bbb222_new",
            "same.py": "ccc333",
        }
        cache = {
            "version": 1,
            "files": {
                "changed.py": {"hash": "bbb222_old", "description": "", "last_indexed": "2025-01-01T00:00:00Z"},
                "same.py": {"hash": "ccc333", "description": "", "last_indexed": "2025-01-01T00:00:00Z"},
                "deleted.py": {"hash": "ddd444", "description": "", "last_indexed": "2025-01-01T00:00:00Z"},
            },
        }

        new, stale, deleted, unchanged = diff_cache(current_files, cache)

        self.assertEqual(new, ["new_file.py"])
        self.assertEqual(stale, ["changed.py"])
        self.assertEqual(deleted, ["deleted.py"])
        self.assertEqual(unchanged, ["same.py"])

    def test_empty_cache(self):
        current_files = {"a.py": "hash_a", "b.py": "hash_b"}
        cache = {"version": 1, "files": {}}

        new, stale, deleted, unchanged = diff_cache(current_files, cache)

        self.assertEqual(new, ["a.py", "b.py"])
        self.assertEqual(stale, [])
        self.assertEqual(deleted, [])
        self.assertEqual(unchanged, [])

    def test_empty_current(self):
        cache = {
            "version": 1,
            "files": {
                "old.py": {"hash": "xxx", "description": "", "last_indexed": "2025-01-01T00:00:00Z"},
            },
        }

        new, stale, deleted, unchanged = diff_cache({}, cache)

        self.assertEqual(new, [])
        self.assertEqual(stale, [])
        self.assertEqual(deleted, ["old.py"])
        self.assertEqual(unchanged, [])


class TestWalkProjectExcludes(unittest.TestCase):
    """Test that walk_project respects exclude patterns."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        # Create some files
        for name in ["main.py", "util.py", "data.log", "notes.txt"]:
            Path(os.path.join(self.tmpdir, name)).write_text(f"# {name}\n")
        # Create a subdirectory with files
        sub = os.path.join(self.tmpdir, "sub")
        os.makedirs(sub)
        Path(os.path.join(sub, "lib.py")).write_text("# lib\n")
        Path(os.path.join(sub, "debug.log")).write_text("# debug log\n")

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmpdir)

    def test_no_excludes(self):
        # Not a git repo, so it falls back to os.walk
        files = walk_project(self.tmpdir)
        self.assertIn("main.py", files)
        self.assertIn("util.py", files)
        self.assertIn("data.log", files)

    def test_exclude_pattern(self):
        files = walk_project(self.tmpdir, excludes=["*.log"])
        self.assertIn("main.py", files)
        self.assertNotIn("data.log", files)
        self.assertNotIn("sub/debug.log", files)

    def test_exclude_multiple_patterns(self):
        files = walk_project(self.tmpdir, excludes=["*.log", "*.txt"])
        self.assertIn("main.py", files)
        self.assertNotIn("data.log", files)
        self.assertNotIn("notes.txt", files)

    def test_skips_binary_files(self):
        bin_path = os.path.join(self.tmpdir, "image.dat")
        with open(bin_path, "wb") as f:
            f.write(b"\x00\x01\x02binary content")
        files = walk_project(self.tmpdir)
        self.assertNotIn("image.dat", files)

    def test_skips_large_files(self):
        big_path = os.path.join(self.tmpdir, "big.txt")
        with open(big_path, "w") as f:
            f.write("x" * 200000)
        files = walk_project(self.tmpdir, max_file_size=102400)
        self.assertNotIn("big.txt", files)

    def test_exclude_directory_prefix(self):
        """Patterns ending with '/' exclude all files under that directory."""
        pkg_dir = os.path.join(self.tmpdir, "packages", "foo")
        os.makedirs(pkg_dir)
        Path(os.path.join(pkg_dir, "index.js")).write_text("// js\n")
        Path(os.path.join(pkg_dir, "util.js")).write_text("// util\n")

        files = walk_project(self.tmpdir, excludes=["packages/foo/"])
        self.assertIn("main.py", files)
        for f in files:
            self.assertFalse(f.startswith("packages/foo/"), f"Should exclude: {f}")

    def test_skips_prove_directory(self):
        prove_dir = os.path.join(self.tmpdir, ".prove")
        os.makedirs(prove_dir)
        Path(os.path.join(prove_dir, "cache.json")).write_text("{}")
        files = walk_project(self.tmpdir)
        for f in files:
            self.assertFalse(f.startswith(".prove"), f"Should skip .prove: {f}")


class TestGitCheckIgnore(unittest.TestCase):
    """Test _git_check_ignore and gitignore integration in walk_project."""

    def setUp(self):
        import subprocess as _sp
        self.tmpdir = tempfile.mkdtemp()
        # Init a git repo
        _sp.run(["git", "init"], cwd=self.tmpdir, capture_output=True)
        _sp.run(["git", "config", "user.email", "test@test.com"], cwd=self.tmpdir, capture_output=True)
        _sp.run(["git", "config", "user.name", "Test"], cwd=self.tmpdir, capture_output=True)

        # Create files
        Path(os.path.join(self.tmpdir, "keep.py")).write_text("# keep\n")
        Path(os.path.join(self.tmpdir, "secret.env")).write_text("KEY=val\n")
        os.makedirs(os.path.join(self.tmpdir, "dist"))
        Path(os.path.join(self.tmpdir, "dist", "bundle.js")).write_text("// bundle\n")

        # Create .gitignore
        Path(os.path.join(self.tmpdir, ".gitignore")).write_text("*.env\ndist/\n")

        # Track everything (including files that match .gitignore)
        _sp.run(["git", "add", "-A"], cwd=self.tmpdir, capture_output=True)
        _sp.run(["git", "commit", "-m", "init"], cwd=self.tmpdir, capture_output=True)

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmpdir)

    def test_check_ignore_identifies_ignored_files(self):
        """_git_check_ignore returns files matching .gitignore patterns."""
        ignored = _git_check_ignore(
            self.tmpdir, ["keep.py", "secret.env", "dist/bundle.js"]
        )
        self.assertNotIn("keep.py", ignored)
        self.assertIn("secret.env", ignored)
        self.assertIn("dist/bundle.js", ignored)

    def test_check_ignore_empty_input(self):
        """Empty path list returns empty set."""
        self.assertEqual(_git_check_ignore(self.tmpdir, []), set())

    def test_check_ignore_no_git(self):
        """Non-git directory returns empty set (graceful fallback)."""
        with tempfile.TemporaryDirectory() as non_git:
            ignored = _git_check_ignore(non_git, ["foo.py"])
            self.assertEqual(ignored, set())

    def test_walk_project_skips_gitignored(self):
        """walk_project filters out files matching .gitignore, even if tracked."""
        files = walk_project(self.tmpdir)
        self.assertIn("keep.py", files)
        self.assertNotIn("secret.env", files)
        for f in files:
            self.assertFalse(f.startswith("dist/"), f"Should skip gitignored: {f}")


class TestLoadSaveCache(unittest.TestCase):
    """Test cache persistence."""

    def test_load_missing_file(self):
        cache = load_cache("/nonexistent/path/cache.json")
        self.assertEqual(cache, {"version": 1, "files": {}})

    def test_save_and_load_roundtrip(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            cache_path = os.path.join(tmpdir, "file-index.json")
            cache = {
                "version": 1,
                "files": {
                    "foo.py": {
                        "hash": "abc123",
                        "description": "a module",
                        "last_indexed": "2025-06-01T00:00:00Z",
                    }
                },
            }
            save_cache(cache_path, cache)
            loaded = load_cache(cache_path)
            self.assertEqual(loaded, cache)

    def test_load_corrupt_json(self):
        with tempfile.NamedTemporaryFile(delete=False, suffix=".json", mode="w") as f:
            f.write("not json{{{")
            tmp = f.name
        try:
            cache = load_cache(tmp)
            self.assertEqual(cache, {"version": 1, "files": {}})
        finally:
            os.unlink(tmp)

    def test_load_wrong_version(self):
        with tempfile.NamedTemporaryFile(delete=False, suffix=".json", mode="w") as f:
            json.dump({"version": 999, "files": {}}, f)
            tmp = f.name
        try:
            cache = load_cache(tmp)
            self.assertEqual(cache, {"version": 1, "files": {}})
        finally:
            os.unlink(tmp)


if __name__ == "__main__":
    unittest.main()
