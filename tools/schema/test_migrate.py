"""Tests for schema migration engine."""

import json
import tempfile
from pathlib import Path

import pytest

from tools.schema.migrate import (
    apply_migration,
    detect_version,
    plan_migration,
)
from tools.schema.schemas import CURRENT_SCHEMA_VERSION


class TestDetectVersion:
    def test_no_version_returns_0(self):
        assert detect_version({}) == "0"
        assert detect_version({"validators": []}) == "0"

    def test_explicit_version(self):
        assert detect_version({"schema_version": "1"}) == "1"
        assert detect_version({"schema_version": "2"}) == "2"


class TestPlanMigration:
    def test_v0_to_current_adds_schema_version(self):
        config = {"validators": [], "scopes": {"plugin": "."}}
        target, changes = plan_migration(config)

        assert target["schema_version"] == CURRENT_SCHEMA_VERSION
        assert any(c.path == "schema_version" for c in changes)

    def test_v0_to_current_preserves_all_sections(self):
        config = {
            "scopes": {"skills": "skills/"},
            "validators": [{"name": "test", "command": "pytest", "phase": "test"}],
            "reporters": [
                {"name": "slack", "command": "./notify.sh", "events": ["step-complete"]}
            ],
            "index": {"excludes": [], "max_file_size": 102400, "concurrency": 3},
        }
        target, changes = plan_migration(config)

        assert target["scopes"] == config["scopes"]
        assert target["validators"] == config["validators"]
        assert target["reporters"] == config["reporters"]
        assert target["index"] == config["index"]
        assert target["schema_version"] == CURRENT_SCHEMA_VERSION

    def test_already_current_no_changes(self):
        config = {"schema_version": CURRENT_SCHEMA_VERSION, "validators": []}
        target, changes = plan_migration(config)

        assert changes == []
        assert target == config

    def test_schema_version_is_first_key(self):
        config = {"validators": [], "scopes": {}}
        target, _ = plan_migration(config)

        keys = list(target.keys())
        assert keys[0] == "schema_version"

    def test_v1_to_v2_adds_claude_md(self):
        config = {"schema_version": "1", "validators": []}
        target, changes = plan_migration(config)

        assert target["schema_version"] == "2"
        assert target["claude_md"] == {"references": []}
        assert any(c.path == "claude_md" for c in changes)

    def test_v1_to_v2_preserves_existing_claude_md(self):
        config = {
            "schema_version": "1",
            "claude_md": {
                "references": [
                    {"path": "~/.claude/standards.md", "label": "Standards"}
                ]
            },
        }
        target, changes = plan_migration(config)

        assert target["schema_version"] == "2"
        assert target["claude_md"]["references"][0]["path"] == "~/.claude/standards.md"
        assert not any(c.path == "claude_md" for c in changes)

    def test_v1_to_v2_renames_stage_to_phase(self):
        config = {
            "schema_version": "1",
            "validators": [
                {"name": "lint", "command": "ruff check .", "stage": "lint"},
                {"name": "test", "command": "pytest", "stage": "test"},
            ],
        }
        target, changes = plan_migration(config)

        assert target["schema_version"] == "2"
        for v in target["validators"]:
            assert "phase" in v
            assert "stage" not in v
        assert target["validators"][0]["phase"] == "lint"
        assert target["validators"][1]["phase"] == "test"
        assert any("stage" in c.path for c in changes)

    def test_v1_to_v2_skips_rename_if_phase_exists(self):
        config = {
            "schema_version": "1",
            "validators": [
                {"name": "test", "command": "pytest", "phase": "test"},
            ],
        }
        target, changes = plan_migration(config)

        assert target["validators"][0]["phase"] == "test"
        assert not any("stage" in c.path for c in changes)

    def test_v0_with_stage_migrates_to_phase(self):
        config = {
            "validators": [
                {"name": "lint", "command": "ruff check .", "stage": "lint"},
            ],
        }
        target, changes = plan_migration(config)

        assert target["schema_version"] == CURRENT_SCHEMA_VERSION
        assert target["validators"][0]["phase"] == "lint"
        assert "stage" not in target["validators"][0]

    def test_v0_migrates_through_v1_to_v2(self):
        config = {"validators": [], "scopes": {"plugin": "."}}
        target, changes = plan_migration(config)

        assert target["schema_version"] == CURRENT_SCHEMA_VERSION
        assert "claude_md" in target


class TestApplyMigration:
    def test_dry_run_no_file_modification(self, tmp_path):
        config = {"validators": []}
        config_path = tmp_path / ".prove.json"
        config_path.write_text(json.dumps(config))

        backup, changes = apply_migration(str(config_path), dry_run=True)

        assert backup is None
        assert len(changes) > 0
        # File should be unchanged
        assert json.loads(config_path.read_text()) == config

    def test_apply_creates_backup(self, tmp_path):
        config = {"validators": []}
        config_path = tmp_path / ".prove.json"
        config_path.write_text(json.dumps(config))

        backup, changes = apply_migration(str(config_path))

        assert backup is not None
        assert Path(backup).exists()
        # Backup should contain original config
        assert json.loads(Path(backup).read_text()) == config

    def test_apply_writes_migrated_config(self, tmp_path):
        config = {"validators": [], "scopes": {"plugin": "."}}
        config_path = tmp_path / ".prove.json"
        config_path.write_text(json.dumps(config))

        apply_migration(str(config_path))

        result = json.loads(config_path.read_text())
        assert result["schema_version"] == CURRENT_SCHEMA_VERSION
        assert result["scopes"] == {"plugin": "."}
        assert result["validators"] == []

    def test_no_migration_needed(self, tmp_path):
        config = {"schema_version": CURRENT_SCHEMA_VERSION}
        config_path = tmp_path / ".prove.json"
        config_path.write_text(json.dumps(config))

        backup, changes = apply_migration(str(config_path))

        assert backup is None
        assert changes == []


class TestRoundTrip:
    def test_validate_after_migrate_passes(self, tmp_path):
        from tools.schema.validate import validate_config
        from tools.schema.schemas import PROVE_SCHEMA

        config = {
            "scopes": {"plugin": "."},
            "validators": [{"name": "test", "command": "pytest", "phase": "test"}],
        }
        config_path = tmp_path / ".prove.json"
        config_path.write_text(json.dumps(config))

        apply_migration(str(config_path))

        result = json.loads(config_path.read_text())
        errors = validate_config(result, PROVE_SCHEMA)
        error_count = sum(1 for e in errors if e.severity == "error")
        assert error_count == 0
