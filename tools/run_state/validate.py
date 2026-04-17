"""Schema validation for .prove/runs artifact JSON files.

Thin wrapper around the DSL-based validator from ``tools/schema/validate.py``
parameterized by the per-kind schemas in ``schemas.py``.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from tools.run_state.schemas import SCHEMA_BY_KIND, infer_kind
from tools.schema.validate import ValidationError, validate_config


def validate_data(
    data: Any, kind: str, strict: bool = False
) -> list[ValidationError]:
    """Validate a parsed JSON value against the schema for ``kind``."""
    if kind not in SCHEMA_BY_KIND:
        return [ValidationError("", f"unknown schema kind: {kind!r}")]
    if not isinstance(data, dict):
        return [ValidationError("", "top-level value must be a JSON object")]
    return validate_config(data, SCHEMA_BY_KIND[kind], strict=strict)


def validate_file(
    path: str | Path, kind: str | None = None, strict: bool = False
) -> tuple[dict | None, list[ValidationError]]:
    """Validate a run-state JSON file.

    If ``kind`` is None, infer from the filename (``prd.json``, ``plan.json``,
    ``state.json``, or ``reports/*.json``).
    """
    p = Path(path)
    if not p.exists():
        return None, [ValidationError(str(p), "file not found")]

    try:
        with open(p, encoding="utf-8") as f:
            data = json.load(f)
    except json.JSONDecodeError as e:
        return None, [ValidationError(str(p), f"invalid JSON: {e}")]

    if kind is None:
        kind = infer_kind(str(p))
        if kind is None:
            return data, [
                ValidationError(
                    str(p),
                    "cannot infer schema kind from filename — pass --kind explicitly",
                )
            ]

    errors = validate_data(data, kind, strict=strict)
    return data, errors
