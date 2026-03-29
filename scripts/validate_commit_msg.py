#!/usr/bin/env python3
"""Validate commit messages follow conventional commits with scopes from .prove.json."""

import json
import re
import sys
from pathlib import Path

TYPES = {"feat", "fix", "chore", "docs", "style", "refactor", "perf", "test", "build", "ci", "revert"}

# Built-in scopes always allowed (see skills/commit/SKILL.md)
BUILTIN_SCOPES = {"docs", "repo", "config", "release"}

# type(scope): description  OR  type: description
PATTERN = re.compile(
    r"^(?P<type>[a-z]+)"
    r"(?:\((?P<scope>[a-z][a-z0-9_-]*)\))?"
    r"!?"  # optional breaking change indicator
    r": "
    r"(?P<description>.+)"
)


def load_scopes() -> set[str]:
    prove_json = Path(__file__).resolve().parent.parent / ".claude" / ".prove.json"
    if not prove_json.exists():
        return set()
    with open(prove_json) as f:
        config = json.load(f)
    return set(config.get("scopes", {}).keys())


def validate(msg_file: str) -> int:
    with open(msg_file) as f:
        first_line = f.readline().strip()

    # Allow merge commits and revert auto-messages
    if first_line.startswith("Merge ") or first_line.startswith("Revert \""):
        return 0

    match = PATTERN.match(first_line)
    if not match:
        print(f"ERROR: commit message does not follow conventional commits format")
        print(f"  Expected: type(scope): description")
        print(f"  Got:      {first_line}")
        print(f"  Valid types: {', '.join(sorted(TYPES))}")
        return 1

    commit_type = match.group("type")
    scope = match.group("scope")

    if commit_type not in TYPES:
        print(f"ERROR: unknown commit type '{commit_type}'")
        print(f"  Valid types: {', '.join(sorted(TYPES))}")
        return 1

    if scope:
        allowed = load_scopes()
        if allowed and scope not in allowed and scope not in BUILTIN_SCOPES:
            all_allowed = sorted(allowed | BUILTIN_SCOPES)
            print(f"ERROR: scope '{scope}' is not registered in .claude/.prove.json")
            print(f"  Allowed scopes: {', '.join(all_allowed)}")
            print(f"  To add a new scope, update .claude/.prove.json 'scopes' field")
            return 1

    return 0


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: validate_commit_msg.py <commit-msg-file>")
        sys.exit(1)
    sys.exit(validate(sys.argv[1]))
