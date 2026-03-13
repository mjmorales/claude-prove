"""Tests for the CLAUDE.md composer."""

from __future__ import annotations

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from composer import compose, compose_subagent_context, write_claude_md


@pytest.fixture
def full_scan():
    """A complete scan result with all sections populated."""
    return {
        "project": {"name": "my-project"},
        "tech_stack": {
            "languages": ["Go"],
            "frameworks": [],
            "build_systems": ["go"],
        },
        "key_dirs": {
            "cmd": "Go CLI entry points",
            "internal": "Internal packages",
        },
        "conventions": {
            "naming": "snake_case",
            "test_patterns": ["*_test.ext (suffix)"],
            "primary_extensions": [".go"],
        },
        "prove_config": {
            "exists": True,
            "validators": [
                {"name": "build", "command": "go build ./...", "phase": "build"},
                {"name": "test", "command": "go test ./...", "phase": "test"},
            ],
            "has_index": True,
        },
        "cafi": {"available": True, "file_count": 50},
        "plugin_dir": "/opt/prove",
    }


@pytest.fixture
def minimal_scan():
    """A scan result for an empty/unknown project."""
    return {
        "project": {"name": "empty-project"},
        "tech_stack": {"languages": [], "frameworks": [], "build_systems": []},
        "key_dirs": {},
        "conventions": {"naming": "unknown", "test_patterns": [], "primary_extensions": []},
        "prove_config": {"exists": False, "validators": [], "has_index": False},
        "cafi": {"available": False, "file_count": 0},
        "plugin_dir": "/opt/prove",
    }


class TestCompose:
    def test_includes_header(self, full_scan):
        result = compose(full_scan)
        assert result.startswith("# my-project\n")

    def test_includes_structure(self, full_scan):
        result = compose(full_scan)
        assert "## Structure" in result
        assert "`cmd/`" in result
        assert "`internal/`" in result

    def test_includes_conventions(self, full_scan):
        result = compose(full_scan)
        assert "## Conventions" in result
        assert "snake_case" in result

    def test_includes_validation(self, full_scan):
        result = compose(full_scan)
        assert "## Validation" in result
        assert "go build" in result
        assert "go test" in result

    def test_includes_discovery(self, full_scan):
        result = compose(full_scan)
        assert "## Discovery Protocol" in result
        assert "file index" in result
        assert "lookup" in result

    def test_includes_tools(self, full_scan):
        result = compose(full_scan)
        assert "## Prove Commands" in result
        assert "/prove:index" in result

    def test_minimal_project_no_extra_sections(self, minimal_scan):
        result = compose(minimal_scan)
        assert "## Structure" not in result
        assert "## Conventions" not in result
        assert "## Validation" not in result
        assert "## Discovery Protocol" not in result
        assert "## Prove Commands" not in result

    def test_skips_conventions_when_unknown(self, full_scan):
        full_scan["conventions"]["naming"] = "unknown"
        result = compose(full_scan)
        assert "## Conventions" not in result

    def test_skips_discovery_when_no_cafi(self, full_scan):
        full_scan["cafi"]["available"] = False
        full_scan["prove_config"]["has_index"] = False
        result = compose(full_scan)
        assert "## Discovery Protocol" not in result

    def test_plugin_dir_in_commands(self, full_scan):
        result = compose(full_scan, "/custom/path")
        assert "/custom/path" in result


class TestComposeSubagentContext:
    def test_includes_stack(self, full_scan):
        result = compose_subagent_context(full_scan)
        assert "**Stack**: Go" in result

    def test_includes_discovery(self, full_scan):
        result = compose_subagent_context(full_scan)
        assert "**Discovery**" in result
        assert "context" in result

    def test_includes_validation(self, full_scan):
        result = compose_subagent_context(full_scan)
        assert "**Validation**" in result
        assert "go build" in result

    def test_minimal_project(self, minimal_scan):
        result = compose_subagent_context(minimal_scan)
        assert "**Stack**: unknown" in result
        assert "**Discovery**" not in result
        assert "**Validation**" not in result


class TestWriteClaudeMd:
    def test_writes_file(self, tmp_path):
        content = "# Test\n\nHello world\n"
        path = write_claude_md(str(tmp_path), content)
        assert os.path.isfile(path)
        with open(path) as f:
            assert f.read() == content

    def test_overwrites_existing(self, tmp_path):
        target = tmp_path / "CLAUDE.md"
        target.write_text("old content")
        write_claude_md(str(tmp_path), "new content")
        assert target.read_text() == "new content"
