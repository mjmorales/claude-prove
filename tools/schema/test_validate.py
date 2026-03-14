"""Tests for schema validation."""

import pytest

from tools.schema.schemas import PROVE_SCHEMA, SETTINGS_SCHEMA
from tools.schema.validate import validate_config, ValidationError


def _error_paths(errors: list[ValidationError]) -> set[str]:
    return {e.path for e in errors if e.severity == "error"}


def _warn_paths(errors: list[ValidationError]) -> set[str]:
    return {e.path for e in errors if e.severity == "warning"}


class TestProveSchema:
    def test_valid_complete_config(self):
        config = {
            "schema_version": "1",
            "scopes": {"plugin": "."},
            "validators": [
                {"name": "build", "command": "go build ./...", "phase": "build"}
            ],
            "reporters": [
                {
                    "name": "slack",
                    "command": "./notify.sh",
                    "events": ["step-complete"],
                }
            ],
            "index": {"excludes": [], "max_file_size": 102400, "concurrency": 3},
        }
        errors = validate_config(config, PROVE_SCHEMA)
        assert _error_paths(errors) == set()

    def test_missing_schema_version(self):
        config = {"validators": []}
        errors = validate_config(config, PROVE_SCHEMA)
        assert "schema_version" in _error_paths(errors)

    def test_minimal_valid_config(self):
        config = {"schema_version": "1"}
        errors = validate_config(config, PROVE_SCHEMA)
        assert _error_paths(errors) == set()

    def test_wrong_type_validators(self):
        config = {"schema_version": "1", "validators": "not-a-list"}
        errors = validate_config(config, PROVE_SCHEMA)
        assert "validators" in _error_paths(errors)

    def test_wrong_type_scopes(self):
        config = {"schema_version": "1", "scopes": ["a", "b"]}
        errors = validate_config(config, PROVE_SCHEMA)
        assert "scopes" in _error_paths(errors)

    def test_validator_missing_required_fields(self):
        config = {
            "schema_version": "1",
            "validators": [{"command": "echo hi"}],
        }
        errors = validate_config(config, PROVE_SCHEMA)
        paths = _error_paths(errors)
        assert "validators[0].name" in paths
        assert "validators[0].phase" in paths

    def test_validator_invalid_phase(self):
        config = {
            "schema_version": "1",
            "validators": [
                {"name": "bad", "command": "echo", "phase": "invalid"}
            ],
        }
        errors = validate_config(config, PROVE_SCHEMA)
        assert "validators[0].phase" in _error_paths(errors)

    def test_reporter_missing_events(self):
        config = {
            "schema_version": "1",
            "reporters": [{"name": "slack", "command": "./notify.sh"}],
        }
        errors = validate_config(config, PROVE_SCHEMA)
        assert "reporters[0].events" in _error_paths(errors)

    def test_unknown_field_warns(self):
        config = {"schema_version": "1", "custom_field": "value"}
        errors = validate_config(config, PROVE_SCHEMA)
        assert _error_paths(errors) == set()
        assert "custom_field" in _warn_paths(errors)

    def test_strict_mode_promotes_warnings(self):
        config = {"schema_version": "1", "custom_field": "value"}
        errors = validate_config(config, PROVE_SCHEMA, strict=True)
        assert "custom_field" in _error_paths(errors)

    def test_scope_values_must_be_strings(self):
        config = {"schema_version": "1", "scopes": {"plugin": 42}}
        errors = validate_config(config, PROVE_SCHEMA)
        assert "scopes.plugin" in _error_paths(errors)

    def test_index_wrong_types(self):
        config = {
            "schema_version": "1",
            "index": {"excludes": "not-a-list", "max_file_size": "big"},
        }
        errors = validate_config(config, PROVE_SCHEMA)
        paths = _error_paths(errors)
        assert "index.excludes" in paths
        assert "index.max_file_size" in paths


class TestSettingsSchema:
    def test_valid_hooks_config(self):
        config = {
            "hooks": {
                "PostToolUse": [
                    {
                        "matcher": "Bash",
                        "hooks": [
                            {
                                "type": "command",
                                "command": "echo hello",
                                "async": True,
                                "timeout": 30,
                            }
                        ],
                    }
                ]
            }
        }
        errors = validate_config(config, SETTINGS_SCHEMA)
        assert _error_paths(errors) == set()

    def test_empty_settings_valid(self):
        config = {}
        errors = validate_config(config, SETTINGS_SCHEMA)
        assert _error_paths(errors) == set()

    def test_hook_missing_type(self):
        config = {
            "hooks": {
                "PostToolUse": [
                    {
                        "matcher": "Bash",
                        "hooks": [{"command": "echo hello"}],
                    }
                ]
            }
        }
        errors = validate_config(config, SETTINGS_SCHEMA)
        assert any("type" in e.path for e in errors if e.severity == "error")

    def test_hook_invalid_type_enum(self):
        config = {
            "hooks": {
                "PostToolUse": [
                    {
                        "matcher": "Bash",
                        "hooks": [{"type": "invalid"}],
                    }
                ]
            }
        }
        errors = validate_config(config, SETTINGS_SCHEMA)
        assert any("type" in e.path for e in errors if e.severity == "error")
