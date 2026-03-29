#!/usr/bin/env python3
"""Estimate token counts for files using a regex-based heuristic tokenizer.

No external dependencies — stdlib only.

Usage:
    python3 scripts/token-count.py "**/*.md"              # glob pattern
    python3 scripts/token-count.py agents/llm-prompt-engineer.md  # single file
    python3 scripts/token-count.py "agents/**/*.md" "skills/**/SKILL.md"  # multiple patterns
    python3 scripts/token-count.py "**/*.md" --sort name   # sort by path
    python3 scripts/token-count.py "**/*.md" --json        # machine-readable
    python3 scripts/token-count.py "**/*.md" --no-strip    # include YAML frontmatter
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Heuristic tokenizer
# ---------------------------------------------------------------------------

# Approximates BPE tokenization by splitting on:
#   - word boundaries, punctuation, whitespace runs
#   - camelCase / PascalCase boundaries
#   - common programming tokens (::, ->, $$, etc.)
_TOKEN_RE = re.compile(
    r"""
      [A-Z]?[a-z]+        # words (including camelCase splits)
    | [A-Z]+(?=[A-Z][a-z]) # ALLCAPS before CamelCase transition
    | [A-Z]+               # remaining ALLCAPS
    | \d+\.?\d*            # numbers (int or float)
    | ---?|\.{2,3}         # markdown dashes, ellipsis
    | ->|=>|::|\*\*|```    # common multi-char tokens
    | [^\s\w]              # single punctuation / symbol
    """,
    re.VERBOSE,
)


def count_tokens(text: str) -> int:
    """Estimate token count using regex heuristic.

    Calibrated against Claude's tokenizer: typically within 10-15% for
    English prose with markdown/code. Tends to slightly overcount.
    """
    return len(_TOKEN_RE.findall(text))


# ---------------------------------------------------------------------------
# File discovery
# ---------------------------------------------------------------------------


def resolve_paths(patterns: list[str]) -> list[Path]:
    """Resolve glob patterns and literal paths to a deduplicated file list."""
    seen: set[Path] = set()
    results: list[Path] = []

    for pattern in patterns:
        p = Path(pattern)

        # Literal file path
        if p.is_file():
            resolved = p.resolve()
            if resolved not in seen:
                seen.add(resolved)
                results.append(p)
            continue

        # Glob pattern — resolve from cwd
        matched = sorted(Path(".").glob(pattern))
        for path in matched:
            if path.is_file():
                resolved = path.resolve()
                if resolved not in seen:
                    seen.add(resolved)
                    results.append(path)

    return results


def measure_files(paths: list[Path], strip_frontmatter: bool = True) -> list[dict]:
    results = []
    for path in paths:
        text = path.read_text(encoding="utf-8")

        if strip_frontmatter:
            stripped = re.sub(
                r"\A---\n.*?\n---\n?", "", text, count=1, flags=re.DOTALL
            )
        else:
            stripped = text

        tokens = count_tokens(stripped)
        lines = stripped.count("\n") + 1
        chars = len(stripped)

        results.append({
            "path": str(path),
            "tokens": tokens,
            "lines": lines,
            "chars": chars,
        })

    return results


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------


def print_table(entries: list[dict]) -> None:
    if not entries:
        print("No files found.")
        return

    max_path = max(len(e["path"]) for e in entries)
    max_path = max(max_path, 4)

    header = f"{'Path':<{max_path}}  {'Tokens':>7}  {'Lines':>6}  {'Chars':>7}"
    print(header)
    print("-" * len(header))

    for e in entries:
        print(
            f"{e['path']:<{max_path}}  {e['tokens']:>7,}  {e['lines']:>6,}  {e['chars']:>7,}"
        )

    total_tokens = sum(e["tokens"] for e in entries)
    total_lines = sum(e["lines"] for e in entries)
    total_chars = sum(e["chars"] for e in entries)
    print("-" * len(header))
    print(
        f"{'TOTAL':<{max_path}}  {total_tokens:>7,}  {total_lines:>6,}  {total_chars:>7,}  ({len(entries)} files)"
    )


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Estimate token counts for files"
    )
    parser.add_argument(
        "patterns",
        nargs="*",
        default=["**/*.md"],
        help="File paths or glob patterns (default: **/*.md)",
    )
    parser.add_argument(
        "--sort",
        choices=["tokens", "name", "lines"],
        default="tokens",
        help="Sort order (default: tokens desc)",
    )
    parser.add_argument(
        "--json", action="store_true", dest="json_output", help="JSON output"
    )
    parser.add_argument(
        "--no-strip",
        action="store_true",
        help="Include YAML frontmatter in token count",
    )
    args = parser.parse_args()

    paths = resolve_paths(args.patterns)
    entries = measure_files(paths, strip_frontmatter=not args.no_strip)

    if args.sort == "tokens":
        entries.sort(key=lambda e: e["tokens"], reverse=True)
    elif args.sort == "name":
        entries.sort(key=lambda e: e["path"])
    elif args.sort == "lines":
        entries.sort(key=lambda e: e["lines"], reverse=True)

    if args.json_output:
        json.dump(entries, sys.stdout, indent=2)
        print()
    else:
        print_table(entries)


if __name__ == "__main__":
    main()
