"""Schema definitions and validation for PCD pipeline artifacts.

Schemas are plain Python dicts describing expected structure.
Each field spec is a dict with:
  - type: "str" | "int" | "float" | "bool" | "list" | "dict" | "any"
  - required: bool (default True)
  - enum: list of allowed values (optional)
  - items: field spec for list items (optional)
  - fields: dict of sub-field specs (optional, for nested dicts)
  - description: str (for documentation)
"""

from __future__ import annotations

from typing import Any

# ---------------------------------------------------------------------------
# Reusable sub-schemas
# ---------------------------------------------------------------------------

_QUESTION_SCHEMA: dict[str, Any] = {
    "type": "dict",
    "fields": {
        "id": {
            "type": "str",
            "required": True,
            "description": "Unique question identifier",
        },
        "referencing_file": {
            "type": "str",
            "required": True,
            "description": "File that raised the question",
        },
        "referenced_symbol": {
            "type": "str",
            "required": True,
            "description": "Symbol referenced by the question",
        },
        "referenced_files": {
            "type": "list",
            "required": True,
            "items": {"type": "str"},
            "description": "Files that may answer the question",
        },
        "question_type": {
            "type": "str",
            "required": True,
            "enum": [
                "error_handling",
                "invariant",
                "contract",
                "side_effect",
                "dependency",
            ],
            "description": "Category of the question",
        },
        "text": {
            "type": "str",
            "required": True,
            "description": "The question text",
        },
    },
}

_FINDING_SCHEMA: dict[str, Any] = {
    "type": "dict",
    "fields": {
        "category": {
            "type": "str",
            "required": True,
            "enum": [
                "error_handling",
                "invariant",
                "contract",
                "side_effect",
                "dependency",
                "performance",
                "naming",
                "dead_code",
            ],
            "description": "Finding category",
        },
        "brief": {
            "type": "str",
            "required": True,
            "description": "Short finding description",
        },
        "line_range": {
            "type": "list",
            "required": True,
            "items": {"type": "int"},
            "description": "Start and end line numbers",
        },
    },
}

_CLUSTER_SCHEMA: dict[str, Any] = {
    "type": "dict",
    "fields": {
        "id": {
            "type": "int",
            "required": True,
            "description": "Cluster identifier",
        },
        "name": {
            "type": "str",
            "required": True,
            "description": "Cluster name",
        },
        "files": {
            "type": "list",
            "required": True,
            "items": {"type": "str"},
            "description": "Files in the cluster",
        },
        "internal_edges": {
            "type": "int",
            "required": True,
            "description": "Number of internal dependency edges",
        },
        "external_edges": {
            "type": "int",
            "required": True,
            "description": "Number of external dependency edges",
        },
        "semantic_label": {
            "type": "str",
            "required": False,
            "description": "LLM-assigned semantic label",
        },
        "module_purpose": {
            "type": "str",
            "required": False,
            "description": "LLM-assigned module purpose",
        },
    },
}

_QUESTION_INDEX_ENTRY_SCHEMA: dict[str, Any] = {
    "type": "dict",
    "fields": {
        "id": {
            "type": "str",
            "required": True,
            "description": "Question identifier",
        },
        "from_file": {
            "type": "str",
            "required": True,
            "description": "File that raised the question",
        },
        "target_files": {
            "type": "list",
            "required": True,
            "items": {"type": "str"},
            "description": "Files targeted by the question",
        },
        "question_type": {
            "type": "str",
            "required": True,
            "description": "Category of the question",
        },
        "routed_to_batch": {
            "type": "int",
            "required": False,
            "description": "Batch this question was routed to",
        },
    },
}

# ---------------------------------------------------------------------------
# Top-level schemas
# ---------------------------------------------------------------------------

STRUCTURAL_MAP_SCHEMA: dict[str, Any] = {
    "type": "dict",
    "fields": {
        "version": {
            "type": "int",
            "required": True,
            "description": "Schema version",
        },
        "timestamp": {
            "type": "str",
            "required": True,
            "description": "ISO-8601 generation timestamp",
        },
        "generated_by": {
            "type": "str",
            "required": True,
            "enum": ["deterministic", "annotated"],
            "description": "Generation method",
        },
        "summary": {
            "type": "dict",
            "required": True,
            "fields": {
                "total_files": {
                    "type": "int",
                    "required": True,
                    "description": "Total number of files",
                },
                "total_lines": {
                    "type": "int",
                    "required": True,
                    "description": "Total line count",
                },
                "languages": {
                    "type": "dict",
                    "required": True,
                    "description": "Language breakdown",
                },
            },
            "description": "Codebase summary statistics",
        },
        "modules": {
            "type": "list",
            "required": True,
            "items": {
                "type": "dict",
                "fields": {
                    "path": {
                        "type": "str",
                        "required": True,
                        "description": "File path",
                    },
                    "lines": {
                        "type": "int",
                        "required": True,
                        "description": "Line count",
                    },
                    "language": {
                        "type": "str",
                        "required": True,
                        "description": "Programming language",
                    },
                    "exports": {
                        "type": "list",
                        "required": True,
                        "items": {"type": "str"},
                        "description": "Exported symbols",
                    },
                    "imports_from": {
                        "type": "list",
                        "required": True,
                        "items": {"type": "str"},
                        "description": "Files imported from",
                    },
                    "imported_by": {
                        "type": "list",
                        "required": True,
                        "items": {"type": "str"},
                        "description": "Files that import this module",
                    },
                    "cafi_description": {
                        "type": "str",
                        "required": False,
                        "description": "CAFI index description",
                    },
                    "cluster_id": {
                        "type": "int",
                        "required": True,
                        "description": "Cluster assignment",
                    },
                },
            },
            "description": "Module list with dependency info",
        },
        "clusters": {
            "type": "list",
            "required": True,
            "items": _CLUSTER_SCHEMA,
            "description": "File clusters",
        },
        "dependency_edges": {
            "type": "list",
            "required": True,
            "items": {
                "type": "dict",
                "fields": {
                    "from": {
                        "type": "str",
                        "required": True,
                        "description": "Source file",
                    },
                    "to": {
                        "type": "str",
                        "required": True,
                        "description": "Target file",
                    },
                    "type": {
                        "type": "str",
                        "required": True,
                        "enum": ["internal", "external"],
                        "description": "Edge type",
                    },
                },
            },
            "description": "Dependency edges between modules",
        },
    },
}

TRIAGE_CARD_SCHEMA: dict[str, Any] = {
    "type": "dict",
    "fields": {
        "file": {
            "type": "str",
            "required": True,
            "description": "File path",
        },
        "lines": {
            "type": "int",
            "required": True,
            "description": "Line count",
        },
        "risk": {
            "type": "str",
            "required": True,
            "enum": ["critical", "high", "medium", "low"],
            "description": "Risk level",
        },
        "confidence": {
            "type": "int",
            "required": True,
            "description": "Confidence score (1-5)",
        },
        "complexity": {
            "type": "str",
            "required": False,
            "enum": ["high", "medium", "low"],
            "description": "Complexity assessment",
        },
        "findings": {
            "type": "list",
            "required": True,
            "items": _FINDING_SCHEMA,
            "description": "List of findings",
        },
        "key_symbols": {
            "type": "list",
            "required": False,
            "items": {"type": "str"},
            "description": "Important symbols in the file",
        },
        "scope_boundaries": {
            "type": "list",
            "required": False,
            "items": {"type": "str"},
            "description": "Scope boundary markers",
        },
        "questions": {
            "type": "list",
            "required": True,
            "items": _QUESTION_SCHEMA,
            "description": "Cross-file questions",
        },
    },
}

TRIAGE_CARD_CLEAN_SCHEMA: dict[str, Any] = {
    "type": "dict",
    "fields": {
        "file": {
            "type": "str",
            "required": True,
            "description": "File path",
        },
        "lines": {
            "type": "int",
            "required": True,
            "description": "Line count",
        },
        "risk": {
            "type": "str",
            "required": True,
            "enum": ["low"],
            "description": "Risk level (always low for clean-bill)",
        },
        "confidence": {
            "type": "int",
            "required": True,
            "description": "Confidence score (1-5)",
        },
        "status": {
            "type": "str",
            "required": True,
            "enum": ["clean"],
            "description": "Clean-bill status marker",
        },
    },
}

TRIAGE_MANIFEST_SCHEMA: dict[str, Any] = {
    "type": "dict",
    "fields": {
        "version": {
            "type": "int",
            "required": True,
            "description": "Schema version",
        },
        "stats": {
            "type": "dict",
            "required": True,
            "fields": {
                "files_reviewed": {
                    "type": "int",
                    "required": True,
                    "description": "Number of files reviewed",
                },
                "high_risk": {
                    "type": "int",
                    "required": True,
                    "description": "Number of high-risk files",
                },
                "medium_risk": {
                    "type": "int",
                    "required": True,
                    "description": "Number of medium-risk files",
                },
                "low_risk": {
                    "type": "int",
                    "required": True,
                    "description": "Number of low-risk files",
                },
                "total_questions": {
                    "type": "int",
                    "required": True,
                    "description": "Total cross-file questions",
                },
            },
            "description": "Triage statistics",
        },
        "cards": {
            "type": "list",
            "required": True,
            "items": {"type": "dict"},
            "description": "Triage cards (full or clean-bill format)",
        },
        "question_index": {
            "type": "list",
            "required": True,
            "items": _QUESTION_INDEX_ENTRY_SCHEMA,
            "description": "Flattened question index for routing",
        },
    },
}

COLLAPSED_MANIFEST_SCHEMA: dict[str, Any] = {
    "type": "dict",
    "fields": {
        "version": {
            "type": "int",
            "required": True,
            "description": "Schema version",
        },
        "stats": {
            "type": "dict",
            "required": True,
            "fields": {
                "total_cards": {
                    "type": "int",
                    "required": True,
                    "description": "Total triage cards before collapse",
                },
                "preserved": {
                    "type": "int",
                    "required": True,
                    "description": "Cards preserved in full",
                },
                "collapsed": {
                    "type": "int",
                    "required": True,
                    "description": "Cards collapsed into summaries",
                },
                "compression_ratio": {
                    "type": "float",
                    "required": True,
                    "description": "Ratio of collapsed to total",
                },
            },
            "description": "Collapse statistics",
        },
        "preserved_cards": {
            "type": "list",
            "required": True,
            "items": {"type": "dict"},
            "description": "Full triage cards that were preserved",
        },
        "collapsed_summaries": {
            "type": "list",
            "required": True,
            "items": {
                "type": "dict",
                "fields": {
                    "cluster_id": {
                        "type": "int",
                        "required": True,
                        "description": "Cluster identifier",
                    },
                    "file_count": {
                        "type": "int",
                        "required": True,
                        "description": "Number of files in the collapsed group",
                    },
                    "files": {
                        "type": "list",
                        "required": True,
                        "items": {"type": "str"},
                        "description": "File paths in the collapsed group",
                    },
                    "max_risk": {
                        "type": "str",
                        "required": True,
                        "description": "Highest risk level in the group",
                    },
                    "aggregate_signals": {
                        "type": "list",
                        "required": True,
                        "items": {"type": "str"},
                        "description": "Aggregated signal descriptions",
                    },
                },
            },
            "description": "Collapsed cluster summaries",
        },
        "question_index": {
            "type": "list",
            "required": True,
            "items": _QUESTION_INDEX_ENTRY_SCHEMA,
            "description": "Flattened question index for routing",
        },
    },
}

FINDINGS_BATCH_SCHEMA: dict[str, Any] = {
    "type": "dict",
    "fields": {
        "batch_id": {
            "type": "int",
            "required": True,
            "description": "Batch identifier",
        },
        "files_reviewed": {
            "type": "list",
            "required": True,
            "items": {"type": "str"},
            "description": "Files reviewed in this batch",
        },
        "findings": {
            "type": "list",
            "required": True,
            "items": {
                "type": "dict",
                "fields": {
                    "id": {
                        "type": "str",
                        "required": True,
                        "description": "Finding identifier",
                    },
                    "severity": {
                        "type": "str",
                        "required": True,
                        "enum": ["critical", "important", "improvement"],
                        "description": "Finding severity",
                    },
                    "category": {
                        "type": "str",
                        "required": True,
                        "enum": [
                            "structural",
                            "abstraction",
                            "naming",
                            "error_handling",
                            "performance",
                            "hygiene",
                        ],
                        "description": "Finding category",
                    },
                    "file": {
                        "type": "str",
                        "required": True,
                        "description": "File path",
                    },
                    "line_range": {
                        "type": "list",
                        "required": True,
                        "items": {"type": "int"},
                        "description": "Start and end line numbers",
                    },
                    "title": {
                        "type": "str",
                        "required": True,
                        "description": "Finding title",
                    },
                    "detail": {
                        "type": "str",
                        "required": True,
                        "description": "Detailed finding description",
                    },
                    "related_triage_findings": {
                        "type": "list",
                        "required": False,
                        "items": {"type": "str"},
                        "description": "IDs of related triage findings",
                    },
                    "fix_sketch": {
                        "type": "str",
                        "required": True,
                        "description": "Suggested fix approach",
                    },
                },
            },
            "description": "Review findings",
        },
        "answers": {
            "type": "list",
            "required": True,
            "items": {
                "type": "dict",
                "fields": {
                    "question_id": {
                        "type": "str",
                        "required": True,
                        "description": "ID of the answered question",
                    },
                    "status": {
                        "type": "str",
                        "required": True,
                        "enum": ["answered", "deferred", "not_applicable"],
                        "description": "Answer status",
                    },
                    "answer": {
                        "type": "str",
                        "required": True,
                        "description": "Answer text",
                    },
                    "spawned_finding": {
                        "type": "str",
                        "required": False,
                        "description": "ID of finding spawned from this answer",
                    },
                },
            },
            "description": "Answers to routed questions",
        },
        "new_questions": {
            "type": "list",
            "required": True,
            "items": _QUESTION_SCHEMA,
            "description": "New cross-file questions discovered during review",
        },
    },
}

BATCH_DEFINITION_SCHEMA: dict[str, Any] = {
    "type": "dict",
    "fields": {
        "batch_id": {
            "type": "int",
            "required": True,
            "description": "Batch identifier",
        },
        "files": {
            "type": "list",
            "required": True,
            "items": {"type": "str"},
            "description": "Files assigned to this batch",
        },
        "triage_cards": {
            "type": "list",
            "required": True,
            "items": {"type": "dict"},
            "description": "Triage cards for the batch files",
        },
        "cluster_context": {
            "type": "list",
            "required": True,
            "items": _CLUSTER_SCHEMA,
            "description": "Cluster context for the batch",
        },
        "routed_questions": {
            "type": "list",
            "required": True,
            "items": {
                "type": "dict",
                "fields": {
                    "id": {
                        "type": "str",
                        "required": True,
                        "description": "Question identifier",
                    },
                    "from_file": {
                        "type": "str",
                        "required": True,
                        "description": "File that raised the question",
                    },
                    "question": {
                        "type": "str",
                        "required": True,
                        "description": "Question text",
                    },
                },
            },
            "description": "Questions routed to this batch",
        },
        "estimated_tokens": {
            "type": "int",
            "required": True,
            "description": "Estimated token count for the batch",
        },
    },
}

PIPELINE_STATUS_SCHEMA: dict[str, Any] = {
    "type": "dict",
    "fields": {
        "version": {
            "type": "int",
            "required": True,
            "description": "Schema version",
        },
        "started_at": {
            "type": "str",
            "required": True,
            "description": "ISO-8601 pipeline start timestamp",
        },
        "rounds": {
            "type": "dict",
            "required": True,
            "description": "Pipeline round statuses keyed by round name",
        },
    },
}

# ---------------------------------------------------------------------------
# Schema registry
# ---------------------------------------------------------------------------

SCHEMA_REGISTRY: dict[str, dict[str, Any]] = {
    "structural_map": STRUCTURAL_MAP_SCHEMA,
    "triage_card": TRIAGE_CARD_SCHEMA,
    "triage_card_clean": TRIAGE_CARD_CLEAN_SCHEMA,
    "triage_manifest": TRIAGE_MANIFEST_SCHEMA,
    "collapsed_manifest": COLLAPSED_MANIFEST_SCHEMA,
    "findings_batch": FINDINGS_BATCH_SCHEMA,
    "batch_definition": BATCH_DEFINITION_SCHEMA,
    "pipeline_status": PIPELINE_STATUS_SCHEMA,
}

# ---------------------------------------------------------------------------
# Type map
# ---------------------------------------------------------------------------

_TYPE_MAP: dict[str, type | tuple[type, ...]] = {
    "str": str,
    "int": int,
    "float": (int, float),
    "bool": bool,
    "list": list,
    "dict": dict,
}

# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


def _validate_value(
    value: Any, spec: dict[str, Any], path: str
) -> list[str]:
    """Validate a single value against a field spec."""
    errors: list[str] = []
    expected_type = spec.get("type", "any")

    if expected_type == "any":
        return errors

    # Type check
    python_type = _TYPE_MAP.get(expected_type)
    if python_type is not None and not isinstance(value, python_type):
        errors.append(f"{path}: expected {expected_type}, got {type(value).__name__}")
        return errors  # skip deeper checks on type mismatch

    # For int type, reject booleans (bool is a subclass of int in Python)
    if expected_type == "int" and isinstance(value, bool):
        errors.append(f"{path}: expected int, got bool")
        return errors

    # Enum check
    if "enum" in spec and value not in spec["enum"]:
        errors.append(
            f"{path}: expected one of {spec['enum']}, got {value!r}"
        )

    # List items
    if expected_type == "list" and "items" in spec and isinstance(value, list):
        for i, item in enumerate(value):
            errors.extend(_validate_value(item, spec["items"], f"{path}[{i}]"))

    # Dict with known fields
    if expected_type == "dict" and "fields" in spec and isinstance(value, dict):
        errors.extend(_validate_fields(value, spec["fields"], path))

    return errors


def _validate_fields(
    data: dict[str, Any],
    fields: dict[str, Any],
    prefix: str = "",
) -> list[str]:
    """Validate a dict's fields against schema field definitions."""
    errors: list[str] = []

    for field_name, spec in fields.items():
        path = f"{prefix}.{field_name}" if prefix else field_name

        if field_name not in data:
            if spec.get("required", False):
                errors.append(f"{path}: required field is missing")
            continue

        errors.extend(_validate_value(data[field_name], spec, path))

    return errors


def validate_artifact(data: dict[str, Any], schema_name: str) -> list[str]:
    """Validate a PCD artifact against its schema.

    Args:
        data: The artifact dict to validate.
        schema_name: One of the schema constant names (e.g., "structural_map",
            "triage_card", etc.)

    Returns:
        List of error strings. Empty list means valid.
    """
    schema = SCHEMA_REGISTRY.get(schema_name)
    if schema is None:
        return [
            f"unknown schema: {schema_name!r} "
            f"(valid: {', '.join(sorted(SCHEMA_REGISTRY))})"
        ]

    if not isinstance(data, dict):
        return [f"expected dict, got {type(data).__name__}"]

    return _validate_fields(data, schema["fields"])
