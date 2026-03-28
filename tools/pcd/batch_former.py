"""Round 2 batch formation from collapsed manifest and structural map.

Groups preserved triage cards into review batches by cluster, routes
cross-file questions to the batch containing target files, and attaches
cluster context for deep review.
"""

from __future__ import annotations

import os
from collections import defaultdict
from typing import Any


# ---------------------------------------------------------------------------
# Token estimation
# ---------------------------------------------------------------------------


def _estimate_tokens(files: list[str], project_root: str) -> int:
    """Rough token estimate for batch input (file content chars / 4).

    Falls back to line-count heuristic from triage card data when files
    are not readable on disk.
    """
    total_chars = 0
    for file_path in files:
        full_path = os.path.join(project_root, file_path)
        try:
            total_chars += os.path.getsize(full_path)
        except OSError:
            # Fallback: assume ~80 chars per line, ~200 lines
            total_chars += 16000
    return max(total_chars // 4, 1) if total_chars > 0 else 0


# ---------------------------------------------------------------------------
# Question routing
# ---------------------------------------------------------------------------


def _route_questions(
    question_index: list[dict[str, Any]],
    batches: list[dict[str, Any]],
) -> None:
    """Route questions from triage manifest to appropriate batches in-place.

    For each question, find the batch containing any of the target_files.
    If no batch contains the target, add to the batch with the most file
    overlap with the question's from_file directory.
    """
    if not batches:
        return

    for q in question_index:
        target_files: list[str] = q.get("target_files", [])
        from_file: str = q.get("from_file", "")
        q_text: str = q.get("text", q.get("question", ""))
        q_id: str = q.get("id", "")

        routed_question = {
            "id": q_id,
            "from_file": from_file,
            "question": q_text,
        }

        # Try direct match: batch contains a target file
        routed = False
        for batch in batches:
            batch_files = set(batch["files"])
            if batch_files & set(target_files):
                batch["routed_questions"].append(routed_question)
                routed = True
                break

        if routed:
            continue

        # Fallback: batch with most overlap by directory
        from_dir = os.path.dirname(from_file)
        best_batch = batches[0]
        best_overlap = -1
        for batch in batches:
            overlap = sum(
                1
                for f in batch["files"]
                if os.path.dirname(f) == from_dir
            )
            if overlap > best_overlap:
                best_overlap = overlap
                best_batch = batch

        best_batch["routed_questions"].append(routed_question)


# ---------------------------------------------------------------------------
# Cluster helpers
# ---------------------------------------------------------------------------


def _build_file_to_cluster(structural_map: dict[str, Any]) -> dict[str, int]:
    """Map each file path to its cluster_id from the structural map."""
    mapping: dict[str, int] = {}
    for module in structural_map.get("modules", []):
        path = module.get("path", "")
        cluster_id = module.get("cluster_id", 0)
        mapping[path] = cluster_id
    return mapping


def _get_cluster_by_id(
    structural_map: dict[str, Any],
    cluster_id: int,
) -> dict[str, Any] | None:
    """Find a cluster dict by its id in the structural map."""
    for cluster in structural_map.get("clusters", []):
        if cluster.get("id") == cluster_id:
            return cluster
    return None


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def form_batches(
    collapsed_manifest: dict[str, Any],
    structural_map: dict[str, Any],
    max_files_per_batch: int = 15,
    project_root: str = ".",
) -> list[dict[str, Any]]:
    """Form Round 2 review batches from collapsed manifest and structural map.

    Strategy:
    1. Group preserved cards by cluster_id from structural map
    2. If a cluster group exceeds max_files_per_batch, split by sub-directory
    3. Route questions to the batch containing the target file
    4. Attach relevant cluster context

    Returns:
        List of batch definition dicts conforming to BATCH_DEFINITION_SCHEMA.
    """
    preserved_cards: list[dict[str, Any]] = collapsed_manifest.get(
        "preserved_cards", []
    )
    question_index: list[dict[str, Any]] = collapsed_manifest.get(
        "question_index", []
    )

    if not preserved_cards:
        return []

    file_to_cluster = _build_file_to_cluster(structural_map)

    # Group cards by cluster_id
    cluster_groups: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for card in preserved_cards:
        file_path = card.get("file", "")
        cluster_id = file_to_cluster.get(file_path, 0)
        cluster_groups[cluster_id].append(card)

    # Build batches
    raw_batches: list[dict[str, Any]] = []
    batch_id_counter = 1

    for cluster_id, cards in sorted(cluster_groups.items()):
        if len(cards) <= max_files_per_batch:
            files = [c["file"] for c in cards]
            cluster_ctx = _get_cluster_by_id(structural_map, cluster_id)
            raw_batches.append(
                {
                    "batch_id": batch_id_counter,
                    "files": files,
                    "triage_cards": cards,
                    "cluster_context": [cluster_ctx] if cluster_ctx else [],
                    "routed_questions": [],
                    "estimated_tokens": _estimate_tokens(files, project_root),
                }
            )
            batch_id_counter += 1
        else:
            # Split by sub-directory
            subdir_groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
            for card in cards:
                subdir = os.path.dirname(card.get("file", ""))
                subdir_groups[subdir].append(card)

            cluster_ctx = _get_cluster_by_id(structural_map, cluster_id)

            for _subdir, sub_cards in sorted(subdir_groups.items()):
                # Further split if a single subdir still exceeds the limit
                for i in range(0, len(sub_cards), max_files_per_batch):
                    chunk = sub_cards[i : i + max_files_per_batch]
                    files = [c["file"] for c in chunk]
                    raw_batches.append(
                        {
                            "batch_id": batch_id_counter,
                            "files": files,
                            "triage_cards": chunk,
                            "cluster_context": (
                                [cluster_ctx] if cluster_ctx else []
                            ),
                            "routed_questions": [],
                            "estimated_tokens": _estimate_tokens(
                                files, project_root
                            ),
                        }
                    )
                    batch_id_counter += 1

    # Route questions to batches
    _route_questions(question_index, raw_batches)

    return raw_batches
