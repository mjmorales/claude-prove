"""CLAUDE.md composer — assembles scan results into an LLM-optimized CLAUDE.md.

Selects relevant sections based on scan data, populates templates,
and outputs the final file. All output is written as behavioral directives
(imperative, short, actionable) not documentation.

The managed block (between sentinel markers) is owned by prove and can be
safely regenerated.  Content outside the markers is user-owned and preserved
across updates.
"""

from __future__ import annotations

import os
from pathlib import Path


SECTIONS_DIR = Path(__file__).resolve().parent / "sections"

MANAGED_START = "<!-- prove:managed:start -->"
MANAGED_END = "<!-- prove:managed:end -->"


def compose(scan: dict, plugin_dir: str | None = None) -> str:
    """Compose CLAUDE.md from scan results.

    Args:
        scan: Output from scanner.scan_project().
        plugin_dir: Path to prove plugin. Falls back to scan["plugin_dir"].

    Returns:
        The full CLAUDE.md content as a string.
    """
    if plugin_dir is None:
        plugin_dir = scan.get("plugin_dir", "")

    parts: list[str] = []

    # Header
    parts.append(_header(scan))

    # Always include: project identity + tech stack
    parts.append(_section_identity(scan))

    # Structure (if key dirs found)
    if scan.get("key_dirs"):
        parts.append(_section_structure(scan))

    # Conventions (if detected)
    conventions = scan.get("conventions", {})
    if conventions.get("naming") and conventions["naming"] != "unknown":
        parts.append(_section_conventions(scan))

    # Validation (if .prove.json has validators)
    prove = scan.get("prove_config", {})
    if prove.get("validators"):
        parts.append(_section_validation(scan))

    # Discovery (if CAFI is available)
    cafi = scan.get("cafi", {})
    if cafi.get("available") or prove.get("has_index"):
        parts.append(_section_discovery(scan, plugin_dir))

    # Prove tools (if prove is configured)
    if prove.get("exists"):
        parts.append(_section_tools(plugin_dir))

    body = "\n".join(parts) + "\n"
    return f"{MANAGED_START}\n{body}{MANAGED_END}\n"


def compose_subagent_context(scan: dict, plugin_dir: str | None = None) -> str:
    """Compose a compact discovery context block for injection into subagent prompts.

    This is a subset of the full CLAUDE.md focused on discovery and validation.

    Args:
        scan: Output from scanner.scan_project().
        plugin_dir: Path to prove plugin.

    Returns:
        Compact context string for subagent prompt injection.
    """
    if plugin_dir is None:
        plugin_dir = scan.get("plugin_dir", "")

    parts: list[str] = []
    parts.append("## Project Context")
    parts.append("")

    # Tech stack one-liner
    ts = scan.get("tech_stack", {})
    langs = ", ".join(ts.get("languages", [])) or "unknown"
    parts.append(f"**Stack**: {langs}")

    # Discovery
    cafi = scan.get("cafi", {})
    if cafi.get("available"):
        parts.append("")
        parts.append("**Discovery**: Before broad Glob/Grep searches, check the file index:")
        parts.append(f"- `python3 {plugin_dir}/tools/cafi/__main__.py context` — full index with routing hints")
        parts.append(f"- `python3 {plugin_dir}/tools/cafi/__main__.py get <path>` — single file description")

    # Validation
    prove = scan.get("prove_config", {})
    if prove.get("validators"):
        parts.append("")
        parts.append("**Validation**: Run before committing:")
        for v in prove["validators"]:
            parts.append(f"- {v['phase']}: `{v['command']}`")

    parts.append("")
    return "\n".join(parts)


def _header(scan: dict) -> str:
    name = scan.get("project", {}).get("name", "Project")
    return f"# {name}\n"


def _section_identity(scan: dict) -> str:
    ts = scan.get("tech_stack", {})
    lines: list[str] = []

    langs = ts.get("languages", [])
    fws = ts.get("frameworks", [])
    bs = ts.get("build_systems", [])

    stack_parts: list[str] = []
    if langs:
        stack_parts.append(", ".join(langs))
    if fws:
        stack_parts.append("+ " + ", ".join(fws))
    if bs:
        stack_parts.append(f"({', '.join(bs)})")

    if stack_parts:
        lines.append(" ".join(stack_parts))
    lines.append("")
    return "\n".join(lines)


def _section_structure(scan: dict) -> str:
    dirs = scan.get("key_dirs", {})
    lines = ["## Structure", ""]
    for dirname, purpose in dirs.items():
        lines.append(f"- `{dirname}/` — {purpose}")
    lines.append("")
    return "\n".join(lines)


def _section_conventions(scan: dict) -> str:
    conv = scan.get("conventions", {})
    lines = ["## Conventions", ""]

    naming = conv.get("naming", "unknown")
    if naming != "unknown":
        lines.append(f"- File naming: {naming}")

    test_patterns = conv.get("test_patterns", [])
    if test_patterns:
        lines.append(f"- Test files: {', '.join(test_patterns)}")

    lines.append("")
    return "\n".join(lines)


def _section_validation(scan: dict) -> str:
    prove = scan.get("prove_config", {})
    validators = prove.get("validators", [])
    lines = ["## Validation", "", "Run before committing:", ""]

    for v in validators:
        lines.append(f"- **{v['phase']}**: `{v['command']}`")

    lines.append("")
    return "\n".join(lines)


def _section_discovery(scan: dict, plugin_dir: str) -> str:
    lines = [
        "## Discovery Protocol",
        "",
        "Before using Glob or Grep for broad codebase exploration:",
        "",
        "1. Check the file index first — it has routing hints for every file",
        f"2. Run `python3 {plugin_dir}/tools/cafi/__main__.py context` for the full index",
        f"3. Run `python3 {plugin_dir}/tools/cafi/__main__.py lookup <keyword>` to search by keyword",
        "4. Only fall back to Glob/Grep when the index doesn't cover what you need",
        "",
        "The index describes *when* to read each file, not just what it contains.",
        "",
    ]
    return "\n".join(lines)


def _section_tools(plugin_dir: str) -> str:
    lines = [
        "## Prove Commands",
        "",
        "- `/prove:index` — Update the file index (run after significant changes)",
        "- `/prove:claude-md` — Regenerate this file",
        "- `/prove:task-planner` — Plan implementation for a task",
        "- `/prove:orchestrator` — Autonomous execution with validation gates",
        "- `/prove:brainstorm` — Explore options and record decisions",
        "",
    ]
    return "\n".join(lines)


def write_claude_md(project_root: str, content: str) -> str:
    """Write CLAUDE.md to the project root.

    If the file already exists and contains the managed-block markers,
    only the managed block is replaced — user content outside the markers
    is preserved.  Otherwise the full file is written (first-time generation).

    Args:
        project_root: Project root directory.
        content: The composed CLAUDE.md content (must include sentinel markers).

    Returns:
        Absolute path to the written file.
    """
    path = os.path.join(project_root, "CLAUDE.md")

    if os.path.isfile(path):
        existing = _read(path)
        merged = _replace_managed_block(existing, content)
        if merged is not None:
            _write(path, merged)
            return path

    # First-time write or file missing markers — write entire content
    _write(path, content)
    return path


def _read(path: str) -> str:
    with open(path) as f:
        return f.read()


def _write(path: str, content: str) -> None:
    with open(path, "w") as f:
        f.write(content)


def _replace_managed_block(existing: str, new_block: str) -> str | None:
    """Replace the managed block in *existing* with *new_block*.

    Returns the merged content, or None if the markers aren't found.
    """
    start_idx = existing.find(MANAGED_START)
    end_idx = existing.find(MANAGED_END)
    if start_idx == -1 or end_idx == -1:
        return None

    # Include everything after the end marker line
    end_of_marker = existing.index("\n", end_idx) + 1 if "\n" in existing[end_idx:] else len(existing)

    before = existing[:start_idx]
    after = existing[end_of_marker:]
    return before + new_block + after
