"""Human-readable diff between current config and schema-compliant target."""

import json
from pathlib import Path

from tools.schema.migrate import plan_migration
from tools.schema.schemas import PROVE_SCHEMA, SETTINGS_SCHEMA
from tools.schema.validate import validate_config


def config_diff(path: str) -> str:
    """Generate a human-readable diff report for a config file.

    Shows:
    - Validation errors in current config
    - Migration changes needed
    - Side-by-side of current vs target for changed fields
    """
    filepath = Path(path)

    if not filepath.exists():
        return f"File not found: {path}"

    with open(filepath) as f:
        config = json.load(f)

    lines: list[str] = []

    # Auto-detect schema
    if filepath.name == ".prove.json":
        schema = PROVE_SCHEMA
        label = ".prove.json"
    elif filepath.name == "settings.json" and ".claude" in str(filepath):
        schema = SETTINGS_SCHEMA
        label = ".claude/settings.json"
    else:
        return f"Cannot auto-detect schema for {path}"

    lines.append(f"=== Config Diff: {label} ===")
    lines.append("")

    # Validation errors
    errors = validate_config(config, schema)
    if errors:
        lines.append("Validation Issues:")
        for e in errors:
            lines.append(str(e))
        lines.append("")

    # Migration plan (only for .prove.json)
    if filepath.name == ".prove.json":
        target, changes = plan_migration(config)

        if changes:
            lines.append("Migration Changes:")
            for c in changes:
                lines.append(str(c))
            lines.append("")

            # Show target config
            lines.append("Target config after migration:")
            lines.append(json.dumps(target, indent=2))
        else:
            lines.append("Config is up to date (no migration needed).")
    else:
        if not errors:
            lines.append("Config is valid (no issues found).")

    return "\n".join(lines)


def summary(prove_path: str = ".prove.json",
            settings_path: str = ".claude/settings.json") -> str:
    """Generate a combined summary for both config files."""
    parts: list[str] = []

    for path in [prove_path, settings_path]:
        if Path(path).exists():
            parts.append(config_diff(path))
        else:
            parts.append(f"=== {path} ===\nNot found (will be created by /prove:init)")

    return "\n\n".join(parts)
