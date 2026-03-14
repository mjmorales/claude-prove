"""Tests for the CLAUDE.md composer."""

from __future__ import annotations

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from composer import (
    MANAGED_END,
    MANAGED_START,
    _replace_managed_block,
    compose,
    compose_subagent_context,
    write_claude_md,
)


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
    def test_wraps_in_managed_markers(self, full_scan):
        result = compose(full_scan)
        assert result.startswith(MANAGED_START + "\n")
        assert result.rstrip().endswith(MANAGED_END)

    def test_includes_header(self, full_scan):
        result = compose(full_scan)
        assert "# my-project\n" in result

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


class TestReplaceManagedBlock:
    def test_replaces_managed_block(self):
        existing = (
            "# My Project\n\nUser notes here.\n\n"
            f"{MANAGED_START}\nold managed content\n{MANAGED_END}\n\n"
            "## My Custom Section\n\nUser content preserved.\n"
        )
        new_block = f"{MANAGED_START}\nnew managed content\n{MANAGED_END}\n"
        result = _replace_managed_block(existing, new_block)
        assert result is not None
        assert "new managed content" in result
        assert "old managed content" not in result
        assert "User notes here." in result
        assert "User content preserved." in result

    def test_returns_none_without_markers(self):
        assert _replace_managed_block("no markers here", "new") is None

    def test_returns_none_with_only_start_marker(self):
        assert _replace_managed_block(f"{MANAGED_START}\nstuff", "new") is None

    def test_returns_none_with_only_end_marker(self):
        assert _replace_managed_block(f"stuff\n{MANAGED_END}\n", "new") is None

    def test_preserves_content_before_and_after(self):
        existing = f"BEFORE\n{MANAGED_START}\nold\n{MANAGED_END}\nAFTER\n"
        new_block = f"{MANAGED_START}\nnew\n{MANAGED_END}\n"
        result = _replace_managed_block(existing, new_block)
        assert result == f"BEFORE\n{MANAGED_START}\nnew\n{MANAGED_END}\nAFTER\n"


class TestWriteClaudeMd:
    def test_writes_file(self, tmp_path):
        content = f"{MANAGED_START}\n# Test\n\nHello world\n{MANAGED_END}\n"
        path = write_claude_md(str(tmp_path), content)
        assert os.path.isfile(path)
        with open(path) as f:
            assert f.read() == content

    def test_full_replace_when_no_markers_in_existing(self, tmp_path):
        target = tmp_path / "CLAUDE.md"
        target.write_text("old content without markers")
        new_content = f"{MANAGED_START}\nnew content\n{MANAGED_END}\n"
        write_claude_md(str(tmp_path), new_content)
        assert target.read_text() == new_content

    def test_partial_replace_preserves_user_content(self, tmp_path):
        target = tmp_path / "CLAUDE.md"
        user_section = "\n## My Notes\n\nDo not delete this.\n"
        target.write_text(
            f"{MANAGED_START}\nold managed\n{MANAGED_END}\n{user_section}"
        )
        new_content = f"{MANAGED_START}\nnew managed\n{MANAGED_END}\n"
        write_claude_md(str(tmp_path), new_content)
        result = target.read_text()
        assert "new managed" in result
        assert "old managed" not in result
        assert "Do not delete this." in result

    def test_preserves_content_before_managed_block(self, tmp_path):
        target = tmp_path / "CLAUDE.md"
        target.write_text(
            f"# Custom Header\n\n{MANAGED_START}\nold\n{MANAGED_END}\n"
        )
        new_content = f"{MANAGED_START}\nnew\n{MANAGED_END}\n"
        write_claude_md(str(tmp_path), new_content)
        result = target.read_text()
        assert result.startswith("# Custom Header\n")
        assert "new" in result
