"""Assemble per-commit intent manifests into a cumulative ACB review document."""

from __future__ import annotations

import hashlib
import json
import logging
import subprocess
import uuid
from datetime import datetime, timezone

from acb.schemas import CURRENT_ACB_VERSION, validate_manifest
from acb.store import Store

logger = logging.getLogger(__name__)


def load_manifests_from_store(store: Store, branch: str) -> list[dict]:
    """Load and validate all intent manifests for *branch* from the store."""
    manifests: list[dict] = []

    for data in store.list_manifests(branch):
        errors = validate_manifest(data)
        if errors:
            logger.warning("Skipping invalid manifest: %s", "; ".join(errors))
            continue
        manifests.append(data)

    return manifests


def merge_intent_groups(manifests: list[dict]) -> list[dict]:
    """Merge intent groups across manifests. Same-id groups are combined."""
    merged: dict[str, dict] = {}

    for manifest in manifests:
        for group in manifest.get("intent_groups", []):
            gid = group["id"]
            if gid not in merged:
                merged[gid] = {
                    "id": gid,
                    "title": group["title"],
                    "classification": group["classification"],
                    "ambiguity_tags": list(group.get("ambiguity_tags", [])),
                    "task_grounding": group.get("task_grounding", ""),
                    "file_refs": list(group.get("file_refs", [])),
                    "annotations": list(group.get("annotations", [])),
                }
                continue

            existing = merged[gid]

            # Merge file refs — combine, dedup by path, merge ranges for same path.
            existing_paths = {r["path"] for r in existing["file_refs"]}
            for ref in group.get("file_refs", []):
                if ref["path"] not in existing_paths:
                    existing["file_refs"].append(ref)
                    existing_paths.add(ref["path"])
                else:
                    for eref in existing["file_refs"]:
                        if eref["path"] == ref["path"]:
                            seen_ranges = set(eref.get("ranges", []))
                            for r in ref.get("ranges", []):
                                if r not in seen_ranges:
                                    eref.setdefault("ranges", []).append(r)
                            break

            # Annotations — dedup by id (first wins).
            ann_ids = {a["id"] for a in existing["annotations"]}
            for ann in group.get("annotations", []):
                if ann["id"] not in ann_ids:
                    existing["annotations"].append(ann)
                    ann_ids.add(ann["id"])

            # Ambiguity tags — union.
            tag_set = set(existing["ambiguity_tags"])
            for tag in group.get("ambiguity_tags", []):
                if tag not in tag_set:
                    existing["ambiguity_tags"].append(tag)
                    tag_set.add(tag)

    return list(merged.values())


def collect_negative_space(manifests: list[dict]) -> list[dict]:
    """Collect and deduplicate negative-space entries across manifests."""
    seen: set[str] = set()
    entries: list[dict] = []
    for m in manifests:
        for entry in m.get("negative_space", []):
            p = entry["path"]
            if p not in seen:
                entries.append(entry)
                seen.add(p)
    return entries


def collect_open_questions(manifests: list[dict]) -> list[dict]:
    """Collect and deduplicate open questions across manifests."""
    seen: set[str] = set()
    questions: list[dict] = []
    for m in manifests:
        for q in m.get("open_questions", []):
            qid = q["id"]
            if qid not in seen:
                questions.append(q)
                seen.add(qid)
    return questions


def get_diff_files(base_ref: str) -> list[str]:
    """Return list of files changed between *base_ref* and HEAD."""
    try:
        result = subprocess.run(
            ["git", "diff", "--name-only", f"{base_ref}...HEAD"],
            capture_output=True,
            text=True,
            check=True,
        )
        return [f.strip() for f in result.stdout.strip().split("\n") if f.strip()]
    except subprocess.CalledProcessError:
        return []


def detect_uncovered_files(intent_groups: list[dict], diff_files: list[str]) -> list[str]:
    """Return files in the diff not covered by any intent group."""
    covered: set[str] = set()
    for group in intent_groups:
        for ref in group.get("file_refs", []):
            covered.add(ref["path"])
    return [f for f in diff_files if f not in covered]


def compute_acb_hash(acb: dict) -> str:
    """SHA-256 hash of an ACB document for linking review state."""
    content = json.dumps(acb, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(content.encode()).hexdigest()


def assemble(
    store: Store,
    branch: str,
    base_ref: str,
    head_ref: str = "HEAD",
    task_statement: dict | None = None,
) -> dict:
    """Assemble manifests for *branch* from the store into a single ACB document.

    Args:
        store: SQLite store instance.
        branch: Branch name to load manifests for.
        base_ref: Git ref for the merge-base (e.g. resolved SHA of main).
        head_ref: Git ref for HEAD (default ``"HEAD"``).
        task_statement: Optional ``{"turns": [...]}`` task context.

    Returns:
        A complete ACB document dict ready for serialisation.
    """
    manifests = load_manifests_from_store(store, branch)
    intent_groups = merge_intent_groups(manifests)
    negative_space = collect_negative_space(manifests)
    open_questions = collect_open_questions(manifests)
    diff_files = get_diff_files(base_ref)
    uncovered = detect_uncovered_files(intent_groups, diff_files)

    return {
        "acb_version": CURRENT_ACB_VERSION,
        "id": str(uuid.uuid4()),
        "change_set_ref": {
            "base_ref": base_ref,
            "head_ref": head_ref,
        },
        "task_statement": task_statement or {"turns": []},
        "intent_groups": intent_groups,
        "negative_space": negative_space,
        "open_questions": open_questions,
        "uncovered_files": uncovered,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "agent_id": "prove-acb-v2",
        "manifest_count": len(manifests),
    }
