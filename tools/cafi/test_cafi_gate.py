"""Tests for the CAFI gate PreToolUse hook."""

from __future__ import annotations

import json
import os
import sys

import pytest

# Ensure cafi package is importable
_cafi_dir = os.path.dirname(os.path.abspath(__file__))
_tools_dir = os.path.dirname(_cafi_dir)
if _tools_dir not in sys.path:
    sys.path.insert(0, _tools_dir)

from cafi.cafi_gate import (
    _extract_glob_keyword,
    _extract_grep_keyword,
    _run_lookup,
)


# -- Glob keyword extraction --------------------------------------------------


class TestExtractGlobKeyword:
    def test_generic_extension_only(self):
        assert _extract_glob_keyword({"pattern": "**/*.tsx"}) is None

    def test_directory_segment(self):
        assert _extract_glob_keyword({"pattern": "src/components/**/*.tsx"}) == "components"

    def test_filename_with_wildcard_ext(self):
        assert _extract_glob_keyword({"pattern": "**/user_repository.*"}) == "user_repository"

    def test_deep_path_last_segment(self):
        assert _extract_glob_keyword({"pattern": "crates/flite-parser/**/*.rs"}) == "flite-parser"

    def test_simple_filename(self):
        assert _extract_glob_keyword({"pattern": "**/config.yaml"}) == "config"

    def test_star_only(self):
        assert _extract_glob_keyword({"pattern": "*"}) is None

    def test_double_star_only(self):
        assert _extract_glob_keyword({"pattern": "**"}) is None

    def test_short_segment_skipped(self):
        assert _extract_glob_keyword({"pattern": "**/a.py"}) is None

    def test_fallback_to_path_field(self):
        assert _extract_glob_keyword({"pattern": "**/*.ts", "path": "/code/my-project/src"}) == "src"

    def test_path_fallback_deep(self):
        assert _extract_glob_keyword({"pattern": "*.rs", "path": "/home/user/flite/crates/parser"}) == "parser"

    def test_empty_pattern(self):
        assert _extract_glob_keyword({"pattern": ""}) is None

    def test_no_pattern_key(self):
        assert _extract_glob_keyword({}) is None


# -- Grep keyword extraction --------------------------------------------------


class TestExtractGrepKeyword:
    def test_function_pattern(self):
        assert _extract_grep_keyword({"pattern": r"fn\s+parse_expr"}) == "parse_expr"

    def test_class_pattern(self):
        assert _extract_grep_keyword({"pattern": r"class\s+UserRepo"}) == "UserRepo"

    def test_dot_star_pattern(self):
        assert _extract_grep_keyword({"pattern": "log.*Error"}) == "Error"

    def test_interface_braces(self):
        assert _extract_grep_keyword({"pattern": r"interface\{\}"}) == "interface"

    def test_simple_word(self):
        assert _extract_grep_keyword({"pattern": "authenticate"}) == "authenticate"

    def test_single_char(self):
        assert _extract_grep_keyword({"pattern": "x"}) is None

    def test_empty_pattern(self):
        assert _extract_grep_keyword({"pattern": ""}) is None

    def test_only_metacharacters(self):
        assert _extract_grep_keyword({"pattern": ".*"}) is None

    def test_multiple_tokens_picks_longest(self):
        assert _extract_grep_keyword({"pattern": r"def\s+my_function_name"}) == "my_function_name"

    def test_no_pattern_key(self):
        assert _extract_grep_keyword({}) is None


# -- CAFI lookup integration ---------------------------------------------------


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
                "description": "Authentication and session management.",
            },
            "src/api.py": {
                "hash": "def456",
                "description": "API endpoints and request handlers.",
            },
        },
    }
    with open(prove_dir / "file-index.json", "w") as f:
        json.dump(cache, f)
    return str(tmp_path)


class TestRunLookup:
    def test_returns_formatted_context(self, indexed_project):
        result = _run_lookup(indexed_project, "auth")
        assert result is not None
        assert "CAFI index matches" in result
        assert "src/auth.py" in result

    def test_no_matches_returns_none(self, indexed_project):
        result = _run_lookup(indexed_project, "nonexistent")
        assert result is None

    def test_no_cache_returns_none(self, tmp_path):
        result = _run_lookup(str(tmp_path), "anything")
        assert result is None

    def test_multiple_matches(self, indexed_project):
        result = _run_lookup(indexed_project, "src")
        assert result is not None
        assert "src/auth.py" in result
        assert "src/api.py" in result


# -- Full hook integration (stdin/stdout) --------------------------------------


class TestHookIntegration:
    """Test main() end-to-end via subprocess to validate JSON protocol."""

    def _run_hook(self, hook_input: dict) -> dict | None:
        """Run the hook as a subprocess and return parsed stdout."""
        import subprocess

        proc = subprocess.run(
            [sys.executable, os.path.join(_cafi_dir, "cafi_gate.py")],
            input=json.dumps(hook_input),
            capture_output=True,
            text=True,
            cwd=_cafi_dir,
        )
        assert proc.returncode == 0
        if not proc.stdout.strip():
            return None
        return json.loads(proc.stdout)

    def test_glob_with_matches(self, indexed_project):
        result = self._run_hook({
            "tool_name": "Glob",
            "tool_input": {"pattern": "**/auth.*"},
            "cwd": indexed_project,
        })
        assert result is not None
        ctx = result["hookSpecificOutput"]["additionalContext"]
        assert "src/auth.py" in ctx
        assert result["hookSpecificOutput"]["permissionDecision"] == "allow"

    def test_grep_with_matches(self, indexed_project):
        result = self._run_hook({
            "tool_name": "Grep",
            "tool_input": {"pattern": r"class\s+Authentication"},
            "cwd": indexed_project,
        })
        assert result is not None
        ctx = result["hookSpecificOutput"]["additionalContext"]
        assert "auth" in ctx.lower()

    def test_generic_glob_no_output(self, indexed_project):
        result = self._run_hook({
            "tool_name": "Glob",
            "tool_input": {"pattern": "**/*.py"},
            "cwd": indexed_project,
        })
        # No meaningful keyword extractable -> no output
        assert result is None

    def test_unknown_tool_no_output(self, indexed_project):
        result = self._run_hook({
            "tool_name": "Read",
            "tool_input": {"file_path": "foo.py"},
            "cwd": indexed_project,
        })
        assert result is None

    def test_no_index_no_output(self, tmp_path):
        result = self._run_hook({
            "tool_name": "Glob",
            "tool_input": {"pattern": "**/auth.*"},
            "cwd": str(tmp_path),
        })
        assert result is None
