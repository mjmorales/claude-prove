"""Tests for the lookup function in indexer.py."""

from __future__ import annotations

import json
import os

import pytest

from cafi.indexer import lookup


@pytest.fixture
def indexed_project(tmp_path):
    """Create a tmp project with a populated file index cache."""
    prove_dir = tmp_path / ".prove"
    prove_dir.mkdir()
    cache = {
        "version": 1,
        "files": {
            "src/auth.py": {
                "hash": "abc123",
                "description": "Read this file when implementing authentication or session management.",
            },
            "src/api.py": {
                "hash": "def456",
                "description": "Read this file when adding API endpoints or modifying request handlers.",
            },
            "tests/test_auth.py": {
                "hash": "ghi789",
                "description": "Read this file when writing tests for authentication logic.",
            },
            "README.md": {
                "hash": "jkl012",
                "description": "Read this file when setting up the project or understanding the architecture.",
            },
            "config/settings.py": {
                "hash": "mno345",
                "description": "",
            },
        },
    }
    with open(prove_dir / "file-index.json", "w") as f:
        json.dump(cache, f)
    return str(tmp_path)


class TestLookup:
    def test_match_by_description(self, indexed_project):
        results = lookup(indexed_project, "authentication")
        paths = [r["path"] for r in results]
        assert "src/auth.py" in paths
        assert "tests/test_auth.py" in paths

    def test_match_by_path(self, indexed_project):
        results = lookup(indexed_project, "api")
        paths = [r["path"] for r in results]
        assert "src/api.py" in paths

    def test_case_insensitive(self, indexed_project):
        results = lookup(indexed_project, "API")
        paths = [r["path"] for r in results]
        assert "src/api.py" in paths

    def test_no_matches(self, indexed_project):
        results = lookup(indexed_project, "nonexistent")
        assert results == []

    def test_empty_cache(self, tmp_path):
        prove_dir = tmp_path / ".prove"
        prove_dir.mkdir()
        cache = {"version": 1, "files": {}}
        with open(prove_dir / "file-index.json", "w") as f:
            json.dump(cache, f)
        results = lookup(str(tmp_path), "anything")
        assert results == []

    def test_no_cache_file(self, tmp_path):
        results = lookup(str(tmp_path), "anything")
        assert results == []

    def test_results_sorted_by_path(self, indexed_project):
        results = lookup(indexed_project, "auth")
        paths = [r["path"] for r in results]
        assert paths == sorted(paths)

    def test_results_include_description(self, indexed_project):
        results = lookup(indexed_project, "auth")
        for r in results:
            assert "path" in r
            assert "description" in r

    def test_matches_file_with_empty_description(self, indexed_project):
        """Keyword matching against path still works even if description is empty."""
        results = lookup(indexed_project, "settings")
        assert len(results) == 1
        assert results[0]["path"] == "config/settings.py"
        assert results[0]["description"] == ""
