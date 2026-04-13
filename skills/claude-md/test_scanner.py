"""Tests for the codebase scanner."""

from __future__ import annotations

import json
import os
import sys

import pytest

# Add skill dir to path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from scanner import scan_project, _detect_naming, _scan_tech_stack, _scan_key_dirs, _scan_core_commands, _scan_plugin_version


@pytest.fixture
def go_project(tmp_path):
    """Create a minimal Go project."""
    (tmp_path / "go.mod").write_text("module example.com/myapp\n\ngo 1.21\n")
    (tmp_path / "cmd").mkdir()
    (tmp_path / "cmd" / "main.go").write_text("package main\n")
    (tmp_path / "internal").mkdir()
    (tmp_path / "internal" / "handler.go").write_text("package internal\n")
    (tmp_path / "internal" / "handler_test.go").write_text("package internal\n")
    return str(tmp_path)


@pytest.fixture
def node_project(tmp_path):
    """Create a minimal Node.js project."""
    pkg = {"name": "my-app", "dependencies": {"react": "^18.0.0", "next": "^14.0.0"}}
    (tmp_path / "package.json").write_text(json.dumps(pkg))
    (tmp_path / "tsconfig.json").write_text("{}")
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "App.tsx").write_text("export default function App() {}")
    (tmp_path / "src" / "App.test.tsx").write_text("test('renders', () => {})")
    (tmp_path / "components").mkdir()
    return str(tmp_path)


@pytest.fixture
def python_project(tmp_path):
    """Create a minimal Python project."""
    (tmp_path / "pyproject.toml").write_text('[project]\nname = "my-lib"\n')
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "my_module.py").write_text("def hello(): pass\n")
    (tmp_path / "tests").mkdir()
    (tmp_path / "tests" / "test_my_module.py").write_text("def test_hello(): pass\n")
    return str(tmp_path)


class TestScanProject:
    def test_go_project(self, go_project):
        scan = scan_project(go_project)
        assert "Go" in scan["tech_stack"]["languages"]
        assert "go" in scan["tech_stack"]["build_systems"]
        assert "cmd" in scan["key_dirs"]
        assert "internal" in scan["key_dirs"]

    def test_node_project(self, node_project):
        scan = scan_project(node_project)
        assert "JavaScript/TypeScript" in scan["tech_stack"]["languages"]
        assert "React" in scan["tech_stack"]["frameworks"]
        assert "Next.js" in scan["tech_stack"]["frameworks"]
        assert "src" in scan["key_dirs"]
        assert "components" in scan["key_dirs"]

    def test_python_project(self, python_project):
        scan = scan_project(python_project)
        assert "Python" in scan["tech_stack"]["languages"]
        assert "pip" in scan["tech_stack"]["build_systems"]
        assert "tests" in scan["key_dirs"]

    def test_project_name_from_package_json(self, node_project):
        scan = scan_project(node_project)
        assert scan["project"]["name"] == "my-app"

    def test_project_name_from_pyproject(self, python_project):
        scan = scan_project(python_project)
        assert scan["project"]["name"] == "my-lib"

    def test_project_name_fallback_to_dirname(self, tmp_path):
        scan = scan_project(str(tmp_path))
        assert scan["project"]["name"] == tmp_path.name

    def test_empty_project(self, tmp_path):
        scan = scan_project(str(tmp_path))
        assert scan["tech_stack"]["languages"] == []
        assert scan["key_dirs"] == {}


class TestDetectNaming:
    def test_snake_case(self):
        assert _detect_naming(["my_module.py", "test_helper.py", "utils.py"]) == "snake_case"

    def test_kebab_case(self):
        assert _detect_naming(["my-component.tsx", "api-handler.ts"]) == "kebab-case"

    def test_camel_case(self):
        assert _detect_naming(["myModule.js", "apiHandler.js"]) == "camelCase"

    def test_pascal_case(self):
        assert _detect_naming(["MyComponent.tsx", "ApiHandler.ts"]) == "PascalCase"

    def test_empty_list(self):
        assert _detect_naming([]) == "unknown"


class TestScanKeyDirs:
    def test_ignores_hidden_dirs(self, tmp_path):
        (tmp_path / ".git").mkdir()
        (tmp_path / "src").mkdir()
        dirs = _scan_key_dirs(str(tmp_path))
        assert ".git" not in dirs
        assert "src" in dirs

    def test_only_known_dirs(self, tmp_path):
        (tmp_path / "src").mkdir()
        (tmp_path / "random_folder").mkdir()
        dirs = _scan_key_dirs(str(tmp_path))
        assert "src" in dirs
        assert "random_folder" not in dirs


class TestScanProveConfig:
    def test_with_prove_json(self, tmp_path):
        config = {
            "validators": [
                {"name": "build", "command": "go build ./...", "phase": "build"}
            ],
            "index": {"excludes": [], "max_file_size": 102400},
        }
        claude_dir = tmp_path / ".claude"
        claude_dir.mkdir()
        (claude_dir / ".prove.json").write_text(json.dumps(config))
        scan = scan_project(str(tmp_path))
        assert scan["prove_config"]["exists"] is True
        assert len(scan["prove_config"]["validators"]) == 1
        assert scan["prove_config"]["has_index"] is True

    def test_without_prove_json(self, tmp_path):
        scan = scan_project(str(tmp_path))
        assert scan["prove_config"]["exists"] is False

    def test_cafi_available(self, tmp_path):
        prove_dir = tmp_path / ".prove"
        prove_dir.mkdir()
        cache = {"version": 1, "files": {"a.py": {"hash": "x", "description": "y"}}}
        (prove_dir / "file-index.json").write_text(json.dumps(cache))
        scan = scan_project(str(tmp_path))
        assert scan["cafi"]["available"] is True
        assert scan["cafi"]["file_count"] == 1

    def test_cafi_not_available(self, tmp_path):
        scan = scan_project(str(tmp_path))
        assert scan["cafi"]["available"] is False
        assert scan["cafi"]["file_count"] == 0


class TestReferences:
    def test_reads_references_from_prove_json(self, tmp_path):
        config = {
            "claude_md": {
                "references": [
                    {"path": "~/.claude/standards.md", "label": "Standards"},
                ]
            }
        }
        claude_dir = tmp_path / ".claude"
        claude_dir.mkdir(exist_ok=True)
        (claude_dir / ".prove.json").write_text(json.dumps(config))
        scan = scan_project(str(tmp_path))
        assert scan["prove_config"]["references"] == [
            {"path": "~/.claude/standards.md", "label": "Standards"},
        ]

    def test_empty_references_when_not_configured(self, tmp_path):
        scan = scan_project(str(tmp_path))
        assert scan["prove_config"]["references"] == []

    def test_skips_references_without_path(self, tmp_path):
        config = {
            "claude_md": {
                "references": [
                    {"path": "", "label": "Empty"},
                    {"label": "No path"},
                    {"path": "~/.claude/valid.md", "label": "Valid"},
                ]
            }
        }
        claude_dir = tmp_path / ".claude"
        claude_dir.mkdir(exist_ok=True)
        (claude_dir / ".prove.json").write_text(json.dumps(config))
        scan = scan_project(str(tmp_path))
        assert len(scan["prove_config"]["references"]) == 1
        assert scan["prove_config"]["references"][0]["path"] == "~/.claude/valid.md"


class TestToolDirectives:
    def test_reads_directives_from_enabled_tools(self, tmp_path):
        """Directives from enabled tools with directive field are collected."""
        # Create tool manifest with directive.
        tools_dir = tmp_path / "tools" / "acb"
        tools_dir.mkdir(parents=True)
        (tools_dir / "tool.json").write_text(json.dumps({
            "name": "acb",
            "directive": "Write intent manifests before committing.",
        }))

        # Create .prove.json with tool enabled.
        claude_dir = tmp_path / ".claude"
        claude_dir.mkdir()
        (claude_dir / ".prove.json").write_text(json.dumps({
            "tools": {"acb": {"enabled": True}},
        }))

        scan = scan_project(str(tmp_path), plugin_dir=str(tmp_path))
        directives = scan["prove_config"]["tool_directives"]
        assert len(directives) == 1
        assert directives[0]["name"] == "acb"
        assert "intent manifests" in directives[0]["directive"]

    def test_skips_disabled_tools(self, tmp_path):
        tools_dir = tmp_path / "tools" / "acb"
        tools_dir.mkdir(parents=True)
        (tools_dir / "tool.json").write_text(json.dumps({
            "name": "acb",
            "directive": "Write intent manifests.",
        }))

        claude_dir = tmp_path / ".claude"
        claude_dir.mkdir()
        (claude_dir / ".prove.json").write_text(json.dumps({
            "tools": {"acb": {"enabled": False}},
        }))

        scan = scan_project(str(tmp_path), plugin_dir=str(tmp_path))
        assert scan["prove_config"]["tool_directives"] == []

    def test_skips_tools_without_directive(self, tmp_path):
        tools_dir = tmp_path / "tools" / "cafi"
        tools_dir.mkdir(parents=True)
        (tools_dir / "tool.json").write_text(json.dumps({
            "name": "cafi",
            "description": "File index",
        }))

        claude_dir = tmp_path / ".claude"
        claude_dir.mkdir()
        (claude_dir / ".prove.json").write_text(json.dumps({
            "tools": {"cafi": {"enabled": True}},
        }))

        scan = scan_project(str(tmp_path), plugin_dir=str(tmp_path))
        assert scan["prove_config"]["tool_directives"] == []

    def test_empty_when_no_tools_dir(self, tmp_path):
        """When plugin has no tools directory, no directives are collected."""
        # Use a plugin_dir that has no tools/ subdirectory.
        fake_plugin = tmp_path / "fake-plugin"
        fake_plugin.mkdir()

        claude_dir = tmp_path / ".claude"
        claude_dir.mkdir()
        (claude_dir / ".prove.json").write_text(json.dumps({
            "tools": {"acb": {"enabled": True}},
        }))

        scan = scan_project(str(tmp_path), plugin_dir=str(fake_plugin))
        assert scan["prove_config"]["tool_directives"] == []


class TestCoreCommands:
    def test_reads_core_commands(self, tmp_path):
        cmds = tmp_path / "commands"
        cmds.mkdir()
        (cmds / "index.md").write_text(
            "---\ndescription: Update file index\ncore: true\nsummary: Update the file index\n---\n"
        )
        (cmds / "review.md").write_text(
            "---\ndescription: Review changes\n---\n"
        )
        result = _scan_core_commands(str(tmp_path))
        assert len(result) == 1
        assert result[0]["name"] == "index"
        assert result[0]["summary"] == "Update the file index"

    def test_sorted_alphabetically(self, tmp_path):
        cmds = tmp_path / "commands"
        cmds.mkdir()
        (cmds / "zeta.md").write_text(
            "---\ndescription: Zeta\ncore: true\nsummary: Zeta cmd\n---\n"
        )
        (cmds / "alpha.md").write_text(
            "---\ndescription: Alpha\ncore: true\nsummary: Alpha cmd\n---\n"
        )
        result = _scan_core_commands(str(tmp_path))
        assert [c["name"] for c in result] == ["alpha", "zeta"]

    def test_empty_when_no_commands_dir(self, tmp_path):
        result = _scan_core_commands(str(tmp_path))
        assert result == []

    def test_skips_non_md_files(self, tmp_path):
        cmds = tmp_path / "commands"
        cmds.mkdir()
        (cmds / "script.sh").write_text("#!/bin/bash\n")
        (cmds / "index.md").write_text(
            "---\ndescription: Index\ncore: true\nsummary: Index\n---\n"
        )
        result = _scan_core_commands(str(tmp_path))
        assert len(result) == 1

    def test_falls_back_to_description_when_no_summary(self, tmp_path):
        cmds = tmp_path / "commands"
        cmds.mkdir()
        (cmds / "test.md").write_text(
            "---\ndescription: Run all tests\ncore: true\n---\n"
        )
        result = _scan_core_commands(str(tmp_path))
        assert result[0]["summary"] == "Run all tests"

    def test_skips_files_without_frontmatter(self, tmp_path):
        cmds = tmp_path / "commands"
        cmds.mkdir()
        (cmds / "plain.md").write_text("# No frontmatter\n\nJust content.")
        result = _scan_core_commands(str(tmp_path))
        assert result == []


class TestPluginVersion:
    def test_reads_version_from_plugin_json(self, tmp_path):
        plugin_dir = tmp_path / ".claude-plugin"
        plugin_dir.mkdir()
        (plugin_dir / "plugin.json").write_text(json.dumps({"version": "1.2.3"}))
        assert _scan_plugin_version(str(tmp_path)) == "1.2.3"

    def test_returns_unknown_when_missing(self, tmp_path):
        assert _scan_plugin_version(str(tmp_path)) == "unknown"

    def test_returns_unknown_on_invalid_json(self, tmp_path):
        plugin_dir = tmp_path / ".claude-plugin"
        plugin_dir.mkdir()
        (plugin_dir / "plugin.json").write_text("not json")
        assert _scan_plugin_version(str(tmp_path)) == "unknown"
