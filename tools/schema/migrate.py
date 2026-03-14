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
        symbol = {"add": "+", "remove": "-", "change": "~"}[self.action]
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
        new_result = {"schema_version": CURRENT_SCHEMA_VERSION}
        new_result.update(result)
        result = new_result
        changes.append(
            MigrationChange(
                "add",
                "schema_version",
                f'set to "{CURRENT_SCHEMA_VERSION}"',
                CURRENT_SCHEMA_VERSION,
            )
        )

    # Add defaults for missing optional sections that have defaults
    for field_name, spec in PROVE_SCHEMA["fields"].items():
        if field_name in result:
            continue
        if "default" in spec:
            result[field_name] = spec["default"]
            changes.append(
                MigrationChange(
                    "add",
                    field_name,
                    f"added with default value {spec['default']!r}",
                    spec["default"],
                )
            )

    return result, changes


# Migration registry: maps "from_to" version pairs to functions
MIGRATIONS: dict[str, Any] = {
    "0_to_1": _migrate_v0_to_v1,
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
