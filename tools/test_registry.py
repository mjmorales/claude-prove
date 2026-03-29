"""Tests for tools/registry.py — tool registry CLI."""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from unittest import mock

import pytest

# Ensure the tools directory is importable.
import sys

_tools_dir = os.path.dirname(os.path.abspath(__file__))
if _tools_dir not in sys.path:
    sys.path.insert(0, _tools_dir)

import registry  # noqa: E402


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

SAMPLE_MANIFEST_ACB = {
    "name": "acb",
    "version": "0.2.0",
    "description": "Intent-based code review",
    "requires": ["python3", "git"],
    "hooks": {
        "PostToolUse": [
            {
                "matcher": "Bash",
                "hooks": [
                    {"type": "command", "command": "python3 hook.py"}
                ],
            }
        ]
    },
    "directories": [".prove/intents", ".prove/reviews"],
    "config_schema": {
        "base_branch": {
            "type": "str",
            "default": "main",
            "description": "Base branch for diffs",
        }
    },
    "provides": {
        "commands": ["review", "review/fix"],
        "skills": ["review"],
    },
    "lifecycle": {
        "post_install": "tools.acb.lifecycle:install",
        "pre_uninstall": "tools.acb.lifecycle:uninstall",
    },
}

SAMPLE_MANIFEST_CAFI = {
    "name": "cafi",
    "version": "1.0.0",
    "description": "Content-addressable file index",
    "requires": ["python3"],
    "config_schema": {
        "excludes": {"type": "list", "default": [], "description": "Excludes"},
    },
    "provides": {"commands": ["index"], "skills": ["index"]},
}


def _make_env(
    tmp: str,
    manifests: dict[str, dict] | None = None,
    prove_tools: dict | None = None,
    settings_hooks: dict | None = None,
) -> tuple[Path, Path]:
    """Create a minimal plugin + project layout inside *tmp*.

    Returns (plugin_root, project_root). For simplicity they are the same dir.
    """
    root = Path(tmp)
    plugin_root = root / "plugin"
    project_root = root / "project"

    # Plugin: tools/<name>/tool.json
    if manifests is None:
        manifests = {"acb": SAMPLE_MANIFEST_ACB, "cafi": SAMPLE_MANIFEST_CAFI}
    for name, manifest in manifests.items():
        d = plugin_root / "tools" / name
        d.mkdir(parents=True, exist_ok=True)
        (d / "tool.json").write_text(json.dumps(manifest, indent=2))

    # Project: .claude/.prove.json
    prove: dict = {"schema_version": "3", "tools": prove_tools or {}}
    claude_dir = project_root / ".claude"
    claude_dir.mkdir(parents=True, exist_ok=True)
    (claude_dir / ".prove.json").write_text(json.dumps(prove, indent=2))

    # Project: .claude/settings.json
    if settings_hooks is not None:
        (claude_dir / "settings.json").write_text(
            json.dumps({"hooks": settings_hooks}, indent=2)
        )

    return plugin_root, project_root


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestList:
    def test_list_discovers_tools(self, capsys: pytest.CaptureFixture[str]) -> None:
        """Scan tool.json files and return correct count."""
        with tempfile.TemporaryDirectory() as tmp:
            plugin_root, project_root = _make_env(tmp)
            registry.main([
                "--plugin-root", str(plugin_root),
                "--project-root", str(project_root),
                "list",
            ])
            out = capsys.readouterr()
            data = json.loads(out.out)
            assert len(data["tools"]) == 2
            names = {t["name"] for t in data["tools"]}
            assert names == {"acb", "cafi"}

    def test_list_includes_kind_field(self, capsys: pytest.CaptureFixture[str]) -> None:
        """Manifest with kind: 'pack' appears in output with correct kind."""
        pack_manifest = {
            "name": "project-manager",
            "version": "1.0.0",
            "kind": "pack",
            "description": "Project management pack",
        }
        with tempfile.TemporaryDirectory() as tmp:
            plugin_root, project_root = _make_env(
                tmp,
                manifests={"acb": SAMPLE_MANIFEST_ACB, "project-manager": pack_manifest},
            )
            registry.main([
                "--plugin-root", str(plugin_root),
                "--project-root", str(project_root),
                "list",
            ])
            data = json.loads(capsys.readouterr().out)
            by_name = {t["name"]: t for t in data["tools"]}
            assert by_name["project-manager"]["kind"] == "pack"
            assert by_name["acb"]["kind"] == "tool"

    def test_list_defaults_kind_to_tool(self, capsys: pytest.CaptureFixture[str]) -> None:
        """Manifest without kind field defaults to 'tool'."""
        with tempfile.TemporaryDirectory() as tmp:
            plugin_root, project_root = _make_env(tmp)
            registry.main([
                "--plugin-root", str(plugin_root),
                "--project-root", str(project_root),
                "list",
            ])
            data = json.loads(capsys.readouterr().out)
            for tool in data["tools"]:
                assert tool["kind"] == "tool"

    def test_list_shows_enabled_status(self, capsys: pytest.CaptureFixture[str]) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            plugin_root, project_root = _make_env(
                tmp, prove_tools={"acb": {"enabled": True}}
            )
            registry.main([
                "--plugin-root", str(plugin_root),
                "--project-root", str(project_root),
                "list",
            ])
            data = json.loads(capsys.readouterr().out)
            by_name = {t["name"]: t for t in data["tools"]}
            assert by_name["acb"]["enabled"] is True
            assert by_name["cafi"]["enabled"] is False


class TestInstall:
    def test_install_writes_prove_json(self, capsys: pytest.CaptureFixture[str]) -> None:
        """Install a tool and verify .prove.json updated."""
        with tempfile.TemporaryDirectory() as tmp:
            plugin_root, project_root = _make_env(tmp)
            registry.main([
                "--plugin-root", str(plugin_root),
                "--project-root", str(project_root),
                "install", "acb",
            ])
            prove = json.loads((project_root / ".claude" / ".prove.json").read_text())
            assert "acb" in prove["tools"]
            assert prove["tools"]["acb"]["enabled"] is True
            assert prove["tools"]["acb"]["config"]["base_branch"] == "main"

    def test_install_writes_hooks(self, capsys: pytest.CaptureFixture[str]) -> None:
        """Verify hooks written to settings.json with _tool tag."""
        with tempfile.TemporaryDirectory() as tmp:
            plugin_root, project_root = _make_env(tmp)
            registry.main([
                "--plugin-root", str(plugin_root),
                "--project-root", str(project_root),
                "install", "acb",
            ])
            settings = json.loads(
                (project_root / ".claude" / "settings.json").read_text()
            )
            post_hooks = settings["hooks"]["PostToolUse"]
            assert len(post_hooks) == 1
            assert post_hooks[0]["_tool"] == "acb"
            assert post_hooks[0]["matcher"] == "Bash"

            # Verify JSON output.
            data = json.loads(capsys.readouterr().out)
            assert data["installed"] == "acb"
            assert data["hooks_added"] == 1

    def test_install_creates_directories(self, capsys: pytest.CaptureFixture[str]) -> None:
        """Verify directories listed in manifest are created."""
        with tempfile.TemporaryDirectory() as tmp:
            plugin_root, project_root = _make_env(tmp)
            registry.main([
                "--plugin-root", str(plugin_root),
                "--project-root", str(project_root),
                "install", "acb",
            ])
            assert (project_root / ".prove" / "intents").is_dir()
            assert (project_root / ".prove" / "reviews").is_dir()
            data = json.loads(capsys.readouterr().out)
            assert data["dirs_created"] == 2

    def test_install_tool_without_hooks(self, capsys: pytest.CaptureFixture[str]) -> None:
        """A tool with no hooks should not create settings.json hooks section."""
        with tempfile.TemporaryDirectory() as tmp:
            plugin_root, project_root = _make_env(tmp)
            registry.main([
                "--plugin-root", str(plugin_root),
                "--project-root", str(project_root),
                "install", "cafi",
            ])
            prove = json.loads((project_root / ".claude" / ".prove.json").read_text())
            assert prove["tools"]["cafi"]["enabled"] is True
            data = json.loads(capsys.readouterr().out)
            assert data["hooks_added"] == 0

    def test_install_appends_to_existing_hooks(self, capsys: pytest.CaptureFixture[str]) -> None:
        """Installing a tool should not clobber pre-existing hooks."""
        existing_hook = {
            "PostToolUse": [
                {"matcher": "Write", "hooks": [{"type": "command", "command": "echo existing"}]}
            ]
        }
        with tempfile.TemporaryDirectory() as tmp:
            plugin_root, project_root = _make_env(
                tmp, settings_hooks=existing_hook
            )
            registry.main([
                "--plugin-root", str(plugin_root),
                "--project-root", str(project_root),
                "install", "acb",
            ])
            settings = json.loads(
                (project_root / ".claude" / "settings.json").read_text()
            )
            post_hooks = settings["hooks"]["PostToolUse"]
            assert len(post_hooks) == 2  # existing + new

    def test_install_calls_post_install_lifecycle(self, capsys: pytest.CaptureFixture[str]) -> None:
        """Lifecycle post_install function is called."""
        called = []
        manifest = dict(SAMPLE_MANIFEST_ACB)
        manifest["lifecycle"] = {"post_install": "fake_mod:do_install"}

        with tempfile.TemporaryDirectory() as tmp:
            plugin_root, project_root = _make_env(
                tmp, manifests={"acb": manifest}
            )
            with mock.patch.object(registry, "_call_lifecycle") as mock_lc:
                registry.main([
                    "--plugin-root", str(plugin_root),
                    "--project-root", str(project_root),
                    "install", "acb",
                ])
                mock_lc.assert_called_once_with(plugin_root, "fake_mod:do_install")

    def test_install_expands_plugin_dir_in_nested_hooks(self, capsys: pytest.CaptureFixture[str]) -> None:
        """$PLUGIN_DIR in nested hook commands is expanded to the actual path."""
        manifest = dict(SAMPLE_MANIFEST_ACB)
        manifest["hooks"] = {
            "PostToolUse": [
                {
                    "matcher": "Bash",
                    "hooks": [
                        {"type": "command", "command": "python3 $PLUGIN_DIR/tools/acb/hook.py"}
                    ],
                }
            ]
        }
        with tempfile.TemporaryDirectory() as tmp:
            plugin_root, project_root = _make_env(tmp, manifests={"acb": manifest})
            registry.main([
                "--plugin-root", str(plugin_root),
                "--project-root", str(project_root),
                "install", "acb",
            ])
            settings = json.loads(
                (project_root / ".claude" / "settings.json").read_text()
            )
            hook_cmd = settings["hooks"]["PostToolUse"][0]["hooks"][0]["command"]
            assert "$PLUGIN_DIR" not in hook_cmd
            assert str(plugin_root) in hook_cmd

    def test_install_unknown_tool_exits(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            plugin_root, project_root = _make_env(tmp)
            with pytest.raises(SystemExit):
                registry.main([
                    "--plugin-root", str(plugin_root),
                    "--project-root", str(project_root),
                    "install", "nonexistent",
                ])


class TestRemove:
    def test_remove_strips_hooks(self, capsys: pytest.CaptureFixture[str]) -> None:
        """Verify tagged hooks removed from settings.json."""
        existing_hooks = {
            "PostToolUse": [
                {"matcher": "Bash", "_tool": "acb", "hooks": [{"type": "command", "command": "hook.py"}]},
                {"matcher": "Write", "hooks": [{"type": "command", "command": "other.py"}]},
            ]
        }
        with tempfile.TemporaryDirectory() as tmp:
            plugin_root, project_root = _make_env(
                tmp,
                prove_tools={"acb": {"enabled": True}},
                settings_hooks=existing_hooks,
            )
            registry.main([
                "--plugin-root", str(plugin_root),
                "--project-root", str(project_root),
                "remove", "acb",
            ])
            settings = json.loads(
                (project_root / ".claude" / "settings.json").read_text()
            )
            post_hooks = settings["hooks"]["PostToolUse"]
            assert len(post_hooks) == 1
            assert "_tool" not in post_hooks[0]  # the untagged one remains

            data = json.loads(capsys.readouterr().out)
            assert data["removed"] == "acb"
            assert data["hooks_removed"] == 1

    def test_remove_strips_prove_json(self, capsys: pytest.CaptureFixture[str]) -> None:
        """Verify tool section removed from .prove.json."""
        with tempfile.TemporaryDirectory() as tmp:
            plugin_root, project_root = _make_env(
                tmp,
                prove_tools={"acb": {"enabled": True}, "cafi": {"enabled": True}},
            )
            registry.main([
                "--plugin-root", str(plugin_root),
                "--project-root", str(project_root),
                "remove", "acb",
            ])
            prove = json.loads((project_root / ".claude" / ".prove.json").read_text())
            assert "acb" not in prove["tools"]
            assert "cafi" in prove["tools"]

    def test_remove_cleans_empty_event(self, capsys: pytest.CaptureFixture[str]) -> None:
        """If all hooks for an event are removed, the event key is deleted."""
        existing_hooks = {
            "PostToolUse": [
                {"matcher": "Bash", "_tool": "acb", "hooks": []},
            ]
        }
        with tempfile.TemporaryDirectory() as tmp:
            plugin_root, project_root = _make_env(
                tmp,
                prove_tools={"acb": {"enabled": True}},
                settings_hooks=existing_hooks,
            )
            registry.main([
                "--plugin-root", str(plugin_root),
                "--project-root", str(project_root),
                "remove", "acb",
            ])
            settings = json.loads(
                (project_root / ".claude" / "settings.json").read_text()
            )
            assert "PostToolUse" not in settings.get("hooks", {})

    def test_remove_calls_pre_uninstall_lifecycle(self, capsys: pytest.CaptureFixture[str]) -> None:
        manifest = dict(SAMPLE_MANIFEST_ACB)
        manifest["lifecycle"] = {"pre_uninstall": "fake_mod:do_uninstall"}

        with tempfile.TemporaryDirectory() as tmp:
            plugin_root, project_root = _make_env(
                tmp,
                manifests={"acb": manifest},
                prove_tools={"acb": {"enabled": True}},
            )
            with mock.patch.object(registry, "_call_lifecycle") as mock_lc:
                registry.main([
                    "--plugin-root", str(plugin_root),
                    "--project-root", str(project_root),
                    "remove", "acb",
                ])
                mock_lc.assert_called_once_with(plugin_root, "fake_mod:do_uninstall")


class TestStatus:
    def test_status_single_tool(self, capsys: pytest.CaptureFixture[str]) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            plugin_root, project_root = _make_env(
                tmp, prove_tools={"acb": {"enabled": True, "config": {"base_branch": "develop"}}}
            )
            registry.main([
                "--plugin-root", str(plugin_root),
                "--project-root", str(project_root),
                "status", "acb",
            ])
            data = json.loads(capsys.readouterr().out)
            assert data["name"] == "acb"
            assert data["enabled"] is True
            assert data["config"]["base_branch"] == "develop"

    def test_status_all_tools(self, capsys: pytest.CaptureFixture[str]) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            plugin_root, project_root = _make_env(tmp)
            registry.main([
                "--plugin-root", str(plugin_root),
                "--project-root", str(project_root),
                "status",
            ])
            data = json.loads(capsys.readouterr().out)
            assert "tools" in data
            assert len(data["tools"]) == 2

    def test_status_unknown_tool_exits(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            plugin_root, project_root = _make_env(tmp)
            with pytest.raises(SystemExit):
                registry.main([
                    "--plugin-root", str(plugin_root),
                    "--project-root", str(project_root),
                    "status", "nope",
                ])


class TestAvailable:
    def test_available_excludes_enabled(self, capsys: pytest.CaptureFixture[str]) -> None:
        """Only shows tools not already in .prove.json tools section."""
        with tempfile.TemporaryDirectory() as tmp:
            plugin_root, project_root = _make_env(
                tmp, prove_tools={"acb": {"enabled": True}}
            )
            registry.main([
                "--plugin-root", str(plugin_root),
                "--project-root", str(project_root),
                "available",
            ])
            data = json.loads(capsys.readouterr().out)
            names = {t["name"] for t in data["available"]}
            assert "acb" not in names
            assert "cafi" in names

    def test_available_all_enabled(self, capsys: pytest.CaptureFixture[str]) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            plugin_root, project_root = _make_env(
                tmp,
                prove_tools={"acb": {"enabled": True}, "cafi": {"enabled": True}},
            )
            registry.main([
                "--plugin-root", str(plugin_root),
                "--project-root", str(project_root),
                "available",
            ])
            data = json.loads(capsys.readouterr().out)
            assert len(data["available"]) == 0


class TestMissingProveJson:
    def test_errors_without_prove_json(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            plugin_root = Path(tmp) / "plugin"
            project_root = Path(tmp) / "project"
            plugin_root.mkdir()
            project_root.mkdir()
            # No .prove.json
            with pytest.raises(SystemExit):
                registry.main([
                    "--plugin-root", str(plugin_root),
                    "--project-root", str(project_root),
                    "list",
                ])
