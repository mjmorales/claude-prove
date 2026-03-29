"""ACB v2 schemas — validation for manifests, ACB documents, and review state."""

from __future__ import annotations

CURRENT_MANIFEST_VERSION = "0.2"
CURRENT_ACB_VERSION = "0.2"

CLASSIFICATIONS = ("explicit", "inferred", "speculative")
AMBIGUITY_TAGS = (
    "underspecified",
    "conflicting_signals",
    "assumption",
    "scope_creep",
    "convention",
)
ANNOTATION_TYPES = ("judgment_call", "note", "flag")
NEGATIVE_SPACE_REASONS = (
    "out_of_scope",
    "possible_other_callers",
    "intentionally_preserved",
    "would_require_escalation",
)
VERDICT_VALUES = ("accepted", "rejected", "needs_discussion", "pending")
OVERALL_VERDICTS = ("approved", "changes_requested", "pending")


def validate_manifest(data: object) -> list[str]:
    """Validate an intent manifest dict. Returns error strings (empty = valid)."""
    errors: list[str] = []
    if not isinstance(data, dict):
        return ["Manifest must be a JSON object"]

    for field in ("acb_manifest_version", "commit_sha", "timestamp", "intent_groups"):
        if field not in data:
            errors.append(f"Missing required field: {field}")

    groups = data.get("intent_groups")
    if groups is not None:
        if not isinstance(groups, list):
            errors.append("intent_groups must be an array")
        elif len(groups) == 0:
            errors.append("intent_groups must not be empty")
        else:
            seen_ids: set[str] = set()
            for i, group in enumerate(groups):
                pfx = f"intent_groups[{i}]"
                if not isinstance(group, dict):
                    errors.append(f"{pfx}: must be an object")
                    continue
                for f in ("id", "title", "classification", "file_refs"):
                    if f not in group:
                        errors.append(f"{pfx}: missing required field '{f}'")
                gid = group.get("id")
                if gid is not None:
                    if gid in seen_ids:
                        errors.append(f"{pfx}: duplicate id '{gid}'")
                    seen_ids.add(gid)
                cls = group.get("classification")
                if cls is not None and cls not in CLASSIFICATIONS:
                    errors.append(f"{pfx}: invalid classification '{cls}'")
                refs = group.get("file_refs")
                if refs is not None and (not isinstance(refs, list) or len(refs) == 0):
                    errors.append(f"{pfx}: file_refs must be a non-empty array")

    return errors


def validate_review_state(data: object) -> list[str]:
    """Validate a review state document. Returns error strings (empty = valid)."""
    errors: list[str] = []
    if not isinstance(data, dict):
        return ["Review state must be a JSON object"]

    for field in ("acb_version", "acb_hash", "acb_id", "group_verdicts", "overall_verdict"):
        if field not in data:
            errors.append(f"Missing required field: {field}")

    verdicts = data.get("group_verdicts")
    if verdicts is not None:
        if not isinstance(verdicts, list):
            errors.append("group_verdicts must be an array")
        else:
            for i, v in enumerate(verdicts):
                pfx = f"group_verdicts[{i}]"
                if not isinstance(v, dict):
                    errors.append(f"{pfx}: must be an object")
                    continue
                if "group_id" not in v:
                    errors.append(f"{pfx}: missing group_id")
                vrd = v.get("verdict")
                if vrd is None:
                    errors.append(f"{pfx}: missing verdict")
                elif vrd not in VERDICT_VALUES:
                    errors.append(f"{pfx}: invalid verdict '{vrd}'")

    ov = data.get("overall_verdict")
    if ov is not None and ov not in OVERALL_VERDICTS:
        errors.append(f"Invalid overall_verdict: '{ov}'")

    return errors
