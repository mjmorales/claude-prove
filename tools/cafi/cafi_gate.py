#!/usr/bin/env python3
"""Claude Code PreToolUse hook for CAFI context injection.

Intercepts Glob and Grep tool calls, extracts a search keyword from the
tool input, runs a CAFI lookup, and injects matching file descriptions
as ``additionalContext`` so Claude sees relevant index entries before
search results arrive.

Install in ``.claude/settings.json``::

    {
      "hooks": {
        "PreToolUse": [
          {
            "matcher": "Glob|Grep",
            "hooks": [
              {
                "type": "command",
                "command": "python3 $PLUGIN_DIR/tools/cafi/cafi_gate.py"
              }
            ]
          }
        ]
      }
    }
"""

from __future__ import annotations

import json
import os
import re
import sys

_MIN_KEYWORD_LEN = 2

# -- Keyword extraction ------------------------------------------------------

# Glob wildcards and path separators to strip
_GLOB_STRIP_RE = re.compile(r"[*?{}\[\]]")
# Common file extensions
_EXT_RE = re.compile(r"\.[a-zA-Z0-9]{1,6}$")


def _extract_glob_keyword(tool_input: dict) -> str | None:
    """Extract a meaningful keyword from a Glob pattern.

    Strategy:
    1. Strip glob wildcards and extensions.
    2. Split on ``/`` and take the last non-empty segment that isn't
       purely a glob artifact (e.g. ``**``).
    3. Fall back to the ``path`` field's last directory segment.

    Examples:
        ``**/*.tsx``                    -> None (too generic)
        ``src/components/**/*.tsx``     -> ``components``
        ``**/user_repository.*``       -> ``user_repository``
        ``crates/flite-parser/**/*.rs`` -> ``flite-parser``
    """
    pattern = tool_input.get("pattern", "")

    # Strip wildcards, then extension (including bare trailing dot)
    cleaned = _GLOB_STRIP_RE.sub("", pattern)
    cleaned = _EXT_RE.sub("", cleaned)
    cleaned = cleaned.rstrip(".")
    segments = [s for s in cleaned.split("/") if s.strip(".")]

    if segments:
        # Last meaningful segment
        candidate = segments[-1]
        if len(candidate) >= _MIN_KEYWORD_LEN:
            return candidate

    # Fall back to path field
    path = tool_input.get("path", "")
    if path:
        path_segments = [s for s in path.rstrip("/").split("/") if s]
        if path_segments:
            candidate = path_segments[-1]
            if len(candidate) >= _MIN_KEYWORD_LEN:
                return candidate

    return None


_REGEX_META_RE = re.compile(r"[\\^$.|?*+(){}\[\]]")
_WHITESPACE_ESC_RE = re.compile(r"\\[sSwWdDbB]")


def _extract_grep_keyword(tool_input: dict) -> str | None:
    r"""Extract a meaningful keyword from a Grep pattern.

    Strategy:
    1. Strip common regex escape sequences (``\s``, ``\w``, etc.).
    2. Strip regex metacharacters.
    3. Split on whitespace and pick the longest remaining token.

    Examples:
        ``fn\s+parse_expr``    -> ``parse_expr``
        ``class\s+UserRepo``   -> ``UserRepo``
        ``log.*Error``         -> ``Error``
        ``interface\{\}``      -> ``interface``
    """
    pattern = tool_input.get("pattern", "")

    # Strip escape sequences, then metacharacters
    cleaned = _WHITESPACE_ESC_RE.sub(" ", pattern)
    cleaned = _REGEX_META_RE.sub(" ", cleaned)

    tokens = cleaned.split()
    if not tokens:
        return None

    # Longest token is most likely the meaningful identifier
    candidate = max(tokens, key=len)
    if len(candidate) >= _MIN_KEYWORD_LEN:
        return candidate

    return None


# -- CAFI lookup --------------------------------------------------------------

# Set up import path for cafi package
_hook_dir = os.path.dirname(os.path.abspath(__file__))
_tools_dir = os.path.dirname(_hook_dir)
if _tools_dir not in sys.path:
    sys.path.insert(0, _tools_dir)


def _run_lookup(project_root: str, keyword: str) -> str | None:
    """Run CAFI lookup and format results as a context string."""
    try:
        from cafi import indexer

        results = indexer.lookup(project_root, keyword)
    except Exception:
        return None

    if not results:
        return None

    lines = [f"CAFI index matches for '{keyword}':"]
    for r in results:
        desc = r.get("description") or "(no description)"
        lines.append(f"- `{r['path']}`: {desc}")
    return "\n".join(lines)


# -- Hook entry point ---------------------------------------------------------


def main() -> None:
    try:
        hook_input = json.load(sys.stdin)
    except (json.JSONDecodeError, EOFError):
        return

    tool_name = hook_input.get("tool_name", "")
    tool_input = hook_input.get("tool_input", {})

    if tool_name == "Glob":
        keyword = _extract_glob_keyword(tool_input)
    elif tool_name == "Grep":
        keyword = _extract_grep_keyword(tool_input)
    else:
        return

    if not keyword:
        return

    project_root = hook_input.get("cwd", os.getcwd())
    context = _run_lookup(project_root, keyword)

    if context:
        json.dump(
            {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "allow",
                    "additionalContext": context,
                }
            },
            sys.stdout,
        )


if __name__ == "__main__":
    main()
