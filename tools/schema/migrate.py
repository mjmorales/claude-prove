"""Migration engine for .prove.json schema evolution.

Detects current schema version, plans migrations, and applies them safely
with backup.
"""

import json
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from tools.schema.schemas import CURRENT_SCHEMA_VERSION, PROVE_SCHEMA


class MigrationChange:
    """A single change in a migration plan."""

    def __init__(self, action: str, path: str, description: str, value: Any = None):
        self.action = action  # "add", "remove", "change"
        self.path = path
        self.description = description
        self.value = value

    def __str__(self) -> str:
        symbol = {"add": "+", "remove": "-", "change": "~", "rename": "~"}[self.action]
        return f"  {symbol} {self.path}: {self.description}"


def detect_version(config: dict) -> str:
    """Detect the schema version of a config.

    Returns "0" for pre-schema configs (no schema_version field).
    """
    return config.get("schema_version", "0")


def _migrate_v0_to_v1(config: dict) -> tuple[dict, list[MigrationChange]]:
    """Migrate from v0 (pre-schema) to v1.

    Changes:
    - Adds schema_version: "1"
    - Validates and preserves all existing sections
    """
    changes: list[MigrationChange] = []
    result = dict(config)

    # Add schema_version as first key
    if "schema_version" not in result:
        new_result = {"schema_version": "1"}
        new_result.update(result)
        result = new_result
        changes.append(
            MigrationChange(
                "add",
                "schema_version",
                'set to "1"',
                "1",
            )
        )

    return result, changes


def _migrate_v1_to_v2(config: dict) -> tuple[dict, list[MigrationChange]]:
    """Migrate from v1 to v2.

    Changes:
    - Bumps schema_version to "2"
    - Adds claude_md section with empty references if not present
    """
    changes: list[MigrationChange] = []
    result = dict(config)

    result["schema_version"] = "2"
    changes.append(
        MigrationChange("change", "schema_version", '"1" -> "2"')
    )

    # Rename stage -> phase in validators
    for validator in result.get("validators", []):
        if "stage" in validator and "phase" not in validator:
            validator["phase"] = validator.pop("stage")
            changes.append(
                MigrationChange(
                    "rename",
                    f"validators[{validator.get('name', '?')}].stage",
                    'renamed "stage" -> "phase"',
                )
            )

    if "claude_md" not in result:
        result["claude_md"] = {"references": []}
        changes.append(
            MigrationChange(
                "add",
                "claude_md",
                "added with empty references (configure via /prove:init or /prove:update)",
                {"references": []},
            )
        )

    return result, changes


# Migration registry: maps "from_to" version pairs to functions
MIGRATIONS: dict[str, Any] = {
    "0_to_1": _migrate_v0_to_v1,
    "1_to_2": _migrate_v1_to_v2,
}


def plan_migration(config: dict) -> tuple[dict, list[MigrationChange]]:
    """Plan all migrations needed to bring config to current version.

    Returns:
        (target_config, list_of_changes)
    """
    current_version = detect_version(config)
    all_changes: list[MigrationChange] = []
    result = dict(config)

    if current_version == CURRENT_SCHEMA_VERSION:
        return result, []

    # Walk through versions sequentially
    version = current_version
    while version != CURRENT_SCHEMA_VERSION:
        next_version = str(int(version) + 1)
        key = f"{version}_to_{next_version}"

        if key not in MIGRATIONS:
            all_changes.append(
                MigrationChange(
                    "change",
                    "schema_version",
                    f"no migration path from v{version} to v{next_version}",
                )
            )
            break

        result, changes = MIGRATIONS[key](result)
        all_changes.extend(changes)
        version = next_version

    return result, all_changes


def backup_config(path: str) -> str:
    """Create a timestamped backup of a config file.

    Returns the backup file path.
    """
    filepath = Path(path)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
    backup_path = filepath.with_suffix(f".{timestamp}.bak")
    shutil.copy2(filepath, backup_path)
    return str(backup_path)


def apply_migration(path: str, dry_run: bool = False) -> tuple[str | None, list[MigrationChange]]:
    """Run migration on a config file.

    Args:
        path: Path to .prove.json
        dry_run: If True, return plan without modifying files

    Returns:
        (backup_path_or_None, changes)
    """
    filepath = Path(path)

    with open(filepath) as f:
        config = json.load(f)

    target, changes = plan_migration(config)

    if not changes:
        return None, []

    if dry_run:
        return None, changes

    # Backup before modifying
    backup_path = backup_config(path)

    # Write migrated config
    with open(filepath, "w") as f:
        json.dump(target, f, indent=2)
        f.write("\n")

    return backup_path, changes
