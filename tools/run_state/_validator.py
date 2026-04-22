"""Lightweight JSON schema validator for run-state artifacts.

Narrow field-spec DSL — only ``ValidationError`` and ``validate_config``
are re-exported. File I/O and global config auto-detection live in the
``prove schema`` TypeScript topic.

No external dependencies — pure Python stdlib.
"""

from __future__ import annotations

from typing import Any

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
        schema: Schema definition (kind-specific, see schemas.py)
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
