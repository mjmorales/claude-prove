"""Generate structured prompts for the fix / discuss / resolve post-review commands.

All prompt text is rendered from Jinja2 templates in ``templates/``.
"""

from __future__ import annotations

from acb.templates import render


def generate_fix_prompt(acb: dict, review: dict) -> str:
    """Build a prompt describing rejected groups with reviewer feedback."""
    return render(
        "fix_prompt.j2",
        rejected=_groups_with_verdict(acb, review, "rejected"),
        discuss=_groups_with_verdict(acb, review, "needs_discussion"),
        pending=_groups_with_verdict(acb, review, "pending"),
        accepted=_groups_with_verdict(acb, review, "accepted"),
        unanswered=_unanswered_questions(acb, review),
        _format_group=_format_group,
    )


def generate_discuss_prompt(acb: dict, review: dict) -> str:
    """Build a prompt surfacing items that need discussion."""
    discussed = _groups_with_verdict(acb, review, "needs_discussion")
    commented = _groups_with_comments(acb, review)
    other_commented = [
        (g, v) for g, v in commented if v.get("verdict") != "needs_discussion"
    ]
    return render(
        "discuss_prompt.j2",
        discuss=discussed,
        other_commented=other_commented,
        unanswered=_unanswered_questions(acb, review),
        _format_group=_format_group,
    )


def generate_resolve_summary(acb: dict, review: dict) -> str:
    """Build a summary confirming review status."""
    total = len(acb.get("intent_groups", []))
    return render(
        "resolve_summary.j2",
        total=total,
        accepted=_groups_with_verdict(acb, review, "accepted"),
        rejected=_groups_with_verdict(acb, review, "rejected"),
        discuss=_groups_with_verdict(acb, review, "needs_discussion"),
        pending=_groups_with_verdict(acb, review, "pending"),
        responses=_annotation_responses(review),
        overall=review.get("overall_verdict", "pending"),
    )


# ── Helpers ────────────────────────────────────────────────────────────────


def _build_verdict_map(review: dict) -> dict[str, dict]:
    """Map group_id -> verdict entry from the review state."""
    return {v["group_id"]: v for v in review.get("group_verdicts", [])}


def _groups_with_verdict(
    acb: dict, review: dict, verdict: str
) -> list[tuple[dict, dict]]:
    vmap = _build_verdict_map(review)
    return [
        (group, vmap.get(group["id"], {}))
        for group in acb.get("intent_groups", [])
        if vmap.get(group["id"], {}).get("verdict") == verdict
    ]


def _groups_with_comments(acb: dict, review: dict) -> list[tuple[dict, dict]]:
    vmap = _build_verdict_map(review)
    return [
        (group, vmap.get(group["id"], {}))
        for group in acb.get("intent_groups", [])
        if vmap.get(group["id"], {}).get("comment")
    ]


def _unanswered_questions(acb: dict, review: dict) -> list[dict]:
    answered_ids = {
        a["question_id"]
        for a in review.get("question_answers", [])
        if a.get("answer")
    }
    return [q for q in acb.get("open_questions", []) if q["id"] not in answered_ids]


def _annotation_responses(review: dict) -> list[str]:
    responses: list[str] = []
    for v in review.get("group_verdicts", []):
        for resp in v.get("annotation_responses", []):
            responses.append(
                f"[{v.get('group_id', '?')}] "
                f"{resp.get('annotation_id', '?')}: "
                f"{resp.get('response', '')}"
            )
    return responses


def _format_group(group: dict, verdict_entry: dict) -> str:
    """Format a single intent group with reviewer feedback (used by templates)."""
    classification = group.get("classification", "unknown")
    parts: list[str] = [f"### {group['title']} (`{group['id']}`, {classification})"]

    comment = verdict_entry.get("comment")
    if comment:
        parts.append(f"\n> **Reviewer:** {comment}")

    files = group.get("file_refs", [])
    if files:
        parts.append("\n**Files:**")
        for ref in files:
            ranges = ", ".join(ref.get("ranges", []))
            suffix = f" L{ranges}" if ranges else ""
            parts.append(f"- `{ref['path']}`{suffix}")

    annotations = group.get("annotations", [])
    if annotations:
        ann_responses = {
            r.get("annotation_id"): r.get("response", "")
            for r in verdict_entry.get("annotation_responses", [])
        }
        parts.append("\n**Annotations:**")
        for ann in annotations:
            parts.append(f"- [{ann.get('type', 'note')}] {ann.get('body', '')}")
            resp = ann_responses.get(ann.get("id"))
            if resp:
                parts.append(f"  > Response: {resp}")

    return "\n".join(parts)
