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


MANAGED_START = "<!-- prove:managed:start -->"
MANAGED_END = "<!-- prove:managed:end -->"


def compose(project_scan: dict, plugin_dir: str | None = None) -> str:
    """Compose CLAUDE.md from scan results.

    Args:
        project_scan: Output from scanner.scan_project().
        plugin_dir: Path to prove plugin. Falls back to project_scan["plugin_dir"].

    Returns:
        The full CLAUDE.md content as a string.
    """
    if plugin_dir is None:
        plugin_dir = project_scan.get("plugin_dir", "")

    parts: list[str] = []

    # Header
    parts.append(_header(project_scan))

    # Plugin version check (always, if prove is configured)
    plugin_version = project_scan.get("plugin_version", "unknown")
    prove = project_scan.get("prove_config", {})
    if prove.get("exists") and plugin_version != "unknown":
        parts.append(_section_version_check(plugin_version, plugin_dir))

    # Always include: project identity + tech stack
    parts.append(_section_identity(project_scan))

    # Structure (if key dirs found)
    if project_scan.get("key_dirs"):
        parts.append(_section_structure(project_scan))

    # Conventions (if detected)
    conventions = project_scan.get("conventions", {})
    if conventions.get("naming") and conventions["naming"] != "unknown":
        parts.append(_section_conventions(project_scan))

    # Validation (if .prove.json has validators)
    if prove.get("validators"):
        parts.append(_section_validation(project_scan))

    # Discovery (if CAFI is available)
    cafi = project_scan.get("cafi", {})
    if cafi.get("available") or prove.get("has_index"):
        parts.append(_section_discovery(project_scan, plugin_dir))

    # External references (if configured in .prove.json)
    references = prove.get("references", [])
    if references:
        parts.append(_section_references(references, plugin_dir))

    # Prove tools (if prove is configured)
    core_commands = project_scan.get("core_commands", [])
    if prove.get("exists"):
        parts.append(_section_tools(core_commands))

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
    tech_stack = scan.get("tech_stack", {})
    langs = ", ".join(tech_stack.get("languages", [])) or "unknown"
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


def _section_version_check(plugin_version: str, plugin_dir: str) -> str:
    """Render a version verification directive.

    Embeds the plugin version that generated this CLAUDE.md so Claude Code
    can detect stale cached plugins. Placed early for primacy positioning.
    """
    lines = [
        f"<!-- prove:plugin-version:{plugin_version} -->",
        f"**Prove plugin v{plugin_version}** — if the installed plugin version "
        f"(`cat {plugin_dir}/.claude-plugin/plugin.json | grep version`) does not "
        f"match v{plugin_version}, run `/prove:update` to sync.",
        "",
    ]
    return "\n".join(lines)


def _section_identity(scan: dict) -> str:
    tech_stack = scan.get("tech_stack", {})
    lines: list[str] = []

    langs = tech_stack.get("languages", [])
    frameworks = tech_stack.get("frameworks", [])
    build_systems = tech_stack.get("build_systems", [])

    stack_parts: list[str] = []
    if langs:
        stack_parts.append(", ".join(langs))
    if frameworks:
        stack_parts.append("+ " + ", ".join(frameworks))
    if build_systems:
        stack_parts.append(f"({', '.join(build_systems)})")

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
        "Before broad Glob/Grep searches, check the file index first:",
        "",
        f"- `python3 {plugin_dir}/tools/cafi/__main__.py context` — full index with routing hints",
        f"- `python3 {plugin_dir}/tools/cafi/__main__.py lookup <keyword>` — search by keyword",
        "",
        "Only fall back to Glob/Grep when the index doesn't cover what you need.",
    ]
    return "\n".join(lines)


def _section_tools(core_commands: list[dict]) -> str:
    """Render Prove Commands section from core command metadata.

    core_commands is a list of {name, summary} dicts from scanner._scan_core_commands().
    Falls back to a minimal entry if no core commands are detected.
    """
    lines = ["## Prove Commands", ""]
    if core_commands:
        for cmd in core_commands:
            lines.append(f"- `/prove:{cmd['name']}` — {cmd['summary']}")
    else:
        lines.append("- `/prove:claude-md` — Regenerate this file")
    lines.append("")
    return "\n".join(lines)


def _section_references(references: list[dict], plugin_dir: str) -> str:
    """Render @ file references for external standards/guidelines.

    Each reference becomes a labeled @ inclusion that Claude Code resolves
    at load time. Stored in .prove.json under claude_md.references.

    Paths containing $PLUGIN_DIR are resolved to the actual plugin directory,
    enabling bundled references that ship with the plugin.
    """
    lines = ["## References", ""]
    for ref in references:
        label = ref.get("label", "")
        path = ref.get("path", "")
        resolved = path.replace("$PLUGIN_DIR", plugin_dir) if path else ""
        if label:
            lines.append(f"### {label}")
            lines.append("")
        lines.append(f"@{resolved}")
        lines.append("")
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
