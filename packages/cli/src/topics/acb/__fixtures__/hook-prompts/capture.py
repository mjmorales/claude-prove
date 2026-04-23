#!/usr/bin/env python3
"""Capture MANIFEST_PROMPT outputs from Python's acb.hook module.

Run from the repo root:

    python3 packages/cli/src/topics/acb/__fixtures__/hook-prompts/capture.py

Writes byte-for-byte captures to python-captures/{A,B,C,D}.txt. The TS
test reads each capture, rewrites the single PYTHONPATH=... invocation
line to the bun-run equivalent, and asserts byte-equality against
generateManifestPrompt output.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

_fixture_dir = Path(__file__).resolve().parent
_captures_dir = _fixture_dir / "python-captures"
_captures_dir.mkdir(exist_ok=True)

# Add tools/ to sys.path so `from acb.hook import _MANIFEST_PROMPT` works.
_repo_root = _fixture_dir.parents[6]
_tools_dir = _repo_root / "tools"
sys.path.insert(0, str(_tools_dir))

from acb.hook import _MANIFEST_PROMPT  # noqa: E402

# Fixture plugin_dir + workspace_root + now_iso must match the TS test
# inputs byte-for-byte so the only delta is the invocation line.
FIXTURE_PLUGIN_DIR = "/plugin/root"
FIXTURE_WORKSPACE_ROOT = "/workspace"
FIXTURE_NOW_ISO = "2026-04-22T12:00:00+00:00"

FIXTURES = {
    "A": {
        "branch": "feat/x",
        "sha": "abc" * 13 + "def",
        "short_sha": ("abc" * 13 + "def")[:12],
        "diff_stat": " src/auth.py | 10 ++++\n 1 file changed",
        "slug_clause": "",
        "slug_flag": "",
        "plugin_dir": FIXTURE_PLUGIN_DIR,
        "workspace_root": FIXTURE_WORKSPACE_ROOT,
        "now_iso": FIXTURE_NOW_ISO,
    },
    "B": {
        "branch": "task/foo/1",
        "sha": "def" * 13 + "abc",
        "short_sha": ("def" * 13 + "abc")[:12],
        "diff_stat": " README.md | 2 +-\n 1 file changed",
        "slug_clause": " (run `some-slug`)",
        "slug_flag": " --slug some-slug",
        "plugin_dir": FIXTURE_PLUGIN_DIR,
        "workspace_root": FIXTURE_WORKSPACE_ROOT,
        "now_iso": FIXTURE_NOW_ISO,
    },
    "C": {
        "branch": "feature/y",
        "sha": "fff" * 13 + "aaa",
        "short_sha": ("fff" * 13 + "aaa")[:12],
        "diff_stat": " a.py | 1 +\n b.py | 1 +\n 2 files changed",
        "slug_clause": " (run `bar`)",
        "slug_flag": " --slug bar",
        "plugin_dir": FIXTURE_PLUGIN_DIR,
        "workspace_root": FIXTURE_WORKSPACE_ROOT,
        "now_iso": FIXTURE_NOW_ISO,
    },
    "D": {
        "branch": "fix/z",
        "sha": "000" * 13 + "bbb",
        "short_sha": ("000" * 13 + "bbb")[:12],
        # diff_stat empty in params -> hook passes "(no diff stat available)"
        "diff_stat": "(no diff stat available)",
        "slug_clause": "",
        "slug_flag": "",
        "plugin_dir": FIXTURE_PLUGIN_DIR,
        "workspace_root": FIXTURE_WORKSPACE_ROOT,
        "now_iso": FIXTURE_NOW_ISO,
    },
}

for name, params in FIXTURES.items():
    out = _MANIFEST_PROMPT.format(**params)
    (_captures_dir / f"{name}.txt").write_text(out, encoding="utf-8")
    print(f"wrote {name}.txt ({len(out)} bytes)")
