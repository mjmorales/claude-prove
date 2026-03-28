"""Collapse round logic for PCD triage manifest compression.

Reduces token usage by compressing low-risk, high-confidence triage cards
into cluster summaries while preserving full cards that need deep review.
"""

from __future__ import annotations

from collections import defaultdict
from typing import Any

# ---------------------------------------------------------------------------
# Risk ordering
# ---------------------------------------------------------------------------

RISK_ORDER: dict[str, int] = {
    "critical": 4,
    "high": 3,
    "medium": 2,
    "low": 1,
}

_PRESERVE_RISK_THRESHOLD = RISK_ORDER["medium"]  # >= medium is preserved
_PRESERVE_CONFIDENCE_THRESHOLD = 3  # <= 3 is preserved


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _should_preserve(card: dict[str, Any]) -> bool:
    """Decide whether a triage card should be preserved in full.

    A card is preserved (not collapsed) if:
    - Its risk is >= medium (i.e. medium, high, or critical), OR
    - Its confidence is <= 3

    Cards with ``"status": "clean"`` are always collapsed.
    """
    if card.get("status") == "clean":
        return False

    risk_level = RISK_ORDER.get(card.get("risk", "low"), 1)
    if risk_level >= _PRESERVE_RISK_THRESHOLD:
        return True

    confidence = card.get("confidence", 5)
    if confidence <= _PRESERVE_CONFIDENCE_THRESHOLD:
        return True

    return False


def _cluster_key(card: dict[str, Any]) -> int | str:
    """Return a grouping key for a collapsed card.

    Uses ``cluster_id`` if present on the card, otherwise falls back to the
    parent directory of the file path.
    """
    if "cluster_id" in card:
        return card["cluster_id"]
    file_path: str = card.get("file", "")
    parts = file_path.rsplit("/", 1)
    return parts[0] if len(parts) > 1 else "."


def _max_risk(risks: list[str]) -> str:
    """Return the highest risk from a list of risk strings."""
    if not risks:
        return "low"
    return max(risks, key=lambda r: RISK_ORDER.get(r, 0))


def _aggregate_signals(cards: list[dict[str, Any]]) -> list[str]:
    """Collect deduplicated finding briefs from collapsed cards."""
    seen: set[str] = set()
    signals: list[str] = []
    for card in cards:
        for finding in card.get("findings", []):
            brief = finding.get("brief", "")
            if brief and brief not in seen:
                seen.add(brief)
                signals.append(brief)
    return signals


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def collapse_manifest(
    triage_manifest: dict[str, Any],
    token_budget: int = 8000,
) -> dict[str, Any]:
    """Collapse low-risk triage cards to reduce token usage.

    Preserves full cards for risk >= "medium" OR confidence <= 3.
    Compresses low-risk/high-confidence cards to clean-bill format.
    Preserves ALL questions regardless of source card risk.

    Args:
        triage_manifest: The triage-manifest.json from Round 1.
        token_budget: Approximate token target (used for stats only).

    Returns:
        Collapsed manifest dict conforming to COLLAPSED_MANIFEST_SCHEMA.
    """
    cards: list[dict[str, Any]] = triage_manifest.get("cards", [])
    question_index: list[dict[str, Any]] = triage_manifest.get(
        "question_index", []
    )

    preserved: list[dict[str, Any]] = []
    to_collapse: list[dict[str, Any]] = []

    for card in cards:
        if _should_preserve(card):
            preserved.append(card)
        else:
            to_collapse.append(card)

    # Group collapsed cards by cluster / directory
    groups: dict[int | str, list[dict[str, Any]]] = defaultdict(list)
    for card in to_collapse:
        key = _cluster_key(card)
        groups[key].append(card)

    collapsed_summaries: list[dict[str, Any]] = []
    for key, group_cards in groups.items():
        cluster_id = key if isinstance(key, int) else hash(key) % 10000
        collapsed_summaries.append(
            {
                "cluster_id": cluster_id,
                "file_count": len(group_cards),
                "files": [c.get("file", "") for c in group_cards],
                "max_risk": _max_risk(
                    [c.get("risk", "low") for c in group_cards]
                ),
                "aggregate_signals": _aggregate_signals(group_cards),
            }
        )

    total = len(cards)
    collapsed_count = len(to_collapse)
    compression_ratio = collapsed_count / total if total > 0 else 0.0

    return {
        "version": 1,
        "stats": {
            "total_cards": total,
            "preserved": len(preserved),
            "collapsed": collapsed_count,
            "compression_ratio": compression_ratio,
        },
        "preserved_cards": preserved,
        "collapsed_summaries": collapsed_summaries,
        "question_index": question_index,
    }
