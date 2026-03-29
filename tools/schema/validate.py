"""Lightweight JSON config validator using schema definitions from schemas.py.

No external dependencies — pure Python stdlib.
"""

import json
from pathlib import Path
from typing import Any

from tools.schema.schemas import PROVE_SCHEMA, SETTINGS_SCHEMA

TYPE_MAP = {
    "str": str,
    "int": (int, float),
    "bool": bool,
    "list": list,
    "dict": dict,
}


class ValidationError:
    """A single validation finding."""

    def __init__(self, path: str, message: str, severity: str = "error"):
        self.path = path
        self.message = message
        self.severity = severity  # "error" or "warning"

    def __str__(self) -> str:
        prefix = "ERROR" if self.severity == "error" else "WARN"
        return f"  {prefix}: {self.path}: {self.message}"

    def __repr__(self) -> str:
        return f"ValidationError({self.path!r}, {self.message!r})"


def _validate_value(value: Any, spec: dict, path: str) -> list[ValidationError]:
    """Validate a single value against a field spec."""
    errors: list[ValidationError] = []
    expected_type = spec.get("type", "any")

    if expected_type == "any":
        return errors

    # Type check
    python_type = TYPE_MAP.get(expected_type)
    if python_type and not isinstance(value, python_type):
        # Allow int for float
        if expected_type == "int" and isinstance(value, float) and value == int(value):
            pass
        else:
            errors.append(
                ValidationError(
                    path,
                    f"expected {expected_type}, got {type(value).__name__}",
                )
            )
            return errors  # Skip further checks if type is wrong

    # Enum check
    if "enum" in spec and value not in spec["enum"]:
        errors.append(
            ValidationError(
                path,
                f"must be one of {spec['enum']}, got {value!r}",
            )
        )

    # List items
    if expected_type == "list" and "items" in spec:
        for i, item in enumerate(value):
            errors.extend(_validate_value(item, spec["items"], f"{path}[{i}]"))

    # Dict fields (known keys)
    if expected_type == "dict" and "fields" in spec:
        errors.extend(_validate_fields(value, spec["fields"], path))

    # Dict values (arbitrary keys, uniform value type)
    if expected_type == "dict" and "values" in spec and "fields" not in spec:
        for key, val in value.items():
            errors.extend(_validate_value(val, spec["values"], f"{path}.{key}"))

    return errors


def _validate_fields(
    data: dict, fields: dict, prefix: str = ""
) -> list[ValidationError]:
    """Validate a dict's fields against schema field definitions."""
    errors: list[ValidationError] = []

    for field_name, spec in fields.items():
        path = f"{prefix}.{field_name}" if prefix else field_name

        if field_name not in data:
            if spec.get("required", False):
                errors.append(ValidationError(path, "required field is missing"))
            continue

        errors.extend(_validate_value(data[field_name], spec, path))

    # Warn about unknown top-level fields (not an error — extensibility)
    known = set(fields.keys())
    for key in data:
        if key not in known:
            path = f"{prefix}.{key}" if prefix else key
            errors.append(
                ValidationError(
                    path,
                    "unknown field (not in schema — may be from a tool or future version)",
                    severity="warning",
                )
            )

    return errors


def validate_config(
    config: dict, schema: dict, strict: bool = False
) -> list[ValidationError]:
    """Validate a config dict against a schema.

    Args:
        config: The parsed JSON config
        schema: Schema definition (PROVE_SCHEMA or SETTINGS_SCHEMA)
        strict: If True, treat warnings as errors

    Returns:
        List of ValidationError objects
    """
    errors = _validate_fields(config, schema["fields"])

    if strict:
        for e in errors:
            if e.severity == "warning":
                e.severity = "error"

    return errors


def validate_file(
    path: str, schema: dict | None = None, strict: bool = False
) -> tuple[dict | None, list[ValidationError]]:
    """Validate a JSON config file.

    Auto-detects schema from filename if not provided.

    Returns:
        (parsed_config_or_None, errors)
    """
    filepath = Path(path)

    if not filepath.exists():
        return None, [ValidationError(path, "file not found")]

    try:
        with open(filepath) as f:
            config = json.load(f)
    except json.JSONDecodeError as e:
        return None, [ValidationError(path, f"invalid JSON: {e}")]

    if not isinstance(config, dict):
        return None, [ValidationError(path, "top-level value must be an object")]

    # Auto-detect schema
    if schema is None:
        if filepath.name == ".prove.json" or str(filepath).endswith(".claude/.prove.json"):
            schema = PROVE_SCHEMA
        elif filepath.name == "settings.json" and ".claude" in str(filepath):
            schema = SETTINGS_SCHEMA
        else:
            return config, [
                ValidationError(
                    path,
                    "cannot auto-detect schema — pass schema explicitly",
                    severity="warning",
                )
            ]

    errors = validate_config(config, schema, strict=strict)
    return config, errors
