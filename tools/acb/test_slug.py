"""Tests for acb._slug — run-slug resolution."""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

_tool_dir = Path(__file__).resolve().parent
if str(_tool_dir.parent) not in sys.path:
    sys.path.insert(0, str(_tool_dir.parent))

from acb._slug import resolve_run_slug


def _write_plan(run_dir: Path, worktree_path: Path, task_id: str = "1.1") -> None:
    plan = {
        "schema_version": "1",
        "kind": "plan",
        "mode": "simple",
        "tasks": [
            {
                "id": task_id,
                "title": "t",
                "wave": 1,
                "deps": [],
                "description": "",
                "acceptance_criteria": [],
                "worktree": {"path": str(worktree_path), "branch": ""},
                "steps": [
                    {
                        "id": f"{task_id}.1",
                        "title": "s",
                        "description": "",
                        "acceptance_criteria": [],
                    }
                ],
            }
        ],
    }
    (run_dir / "plan.json").write_text(json.dumps(plan))


class TestResolveRunSlug(unittest.TestCase):
    def test_env_var_wins(self):
        with tempfile.TemporaryDirectory() as tmp, \
             patch.dict(os.environ, {"PROVE_RUN_SLUG": "env-slug"}, clear=False):
            self.assertEqual(resolve_run_slug(tmp), "env-slug")

    def test_env_var_overrides_marker(self):
        with tempfile.TemporaryDirectory() as tmp:
            prove = Path(tmp) / ".prove"
            prove.mkdir()
            (prove / "RUN_SLUG").write_text("marker-slug")
            with patch.dict(os.environ, {"PROVE_RUN_SLUG": "env-slug"}, clear=False):
                self.assertEqual(resolve_run_slug(tmp), "env-slug")

    def test_marker_file_fallback(self):
        with tempfile.TemporaryDirectory() as tmp:
            prove = Path(tmp) / ".prove"
            prove.mkdir()
            (prove / "RUN_SLUG").write_text("marker-slug\n")
            env = {k: v for k, v in os.environ.items() if k != "PROVE_RUN_SLUG"}
            with patch.dict(os.environ, env, clear=True):
                self.assertEqual(resolve_run_slug(tmp), "marker-slug")

    def test_empty_env_falls_through_to_marker(self):
        with tempfile.TemporaryDirectory() as tmp:
            prove = Path(tmp) / ".prove"
            prove.mkdir()
            (prove / "RUN_SLUG").write_text("marker-slug")
            with patch.dict(os.environ, {"PROVE_RUN_SLUG": "  "}, clear=False):
                self.assertEqual(resolve_run_slug(tmp), "marker-slug")

    def test_empty_marker_yields_none(self):
        with tempfile.TemporaryDirectory() as tmp:
            prove = Path(tmp) / ".prove"
            prove.mkdir()
            (prove / "RUN_SLUG").write_text("   \n")
            env = {k: v for k, v in os.environ.items() if k != "PROVE_RUN_SLUG"}
            with patch.dict(os.environ, env, clear=True):
                self.assertIsNone(resolve_run_slug(tmp))

    def test_no_env_no_marker_yields_none(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = {k: v for k, v in os.environ.items() if k != "PROVE_RUN_SLUG"}
            with patch.dict(os.environ, env, clear=True):
                self.assertIsNone(resolve_run_slug(tmp))


class TestRunDirectoryLookup(unittest.TestCase):
    """Slug resolution via ``.prove/runs/**/plan.json`` worktree registration."""

    def setUp(self):
        self._ctx = tempfile.TemporaryDirectory()
        self.root = Path(self._ctx.name)
        self._env_ctx = patch.dict(
            os.environ,
            {k: v for k, v in os.environ.items() if k != "PROVE_RUN_SLUG"},
            clear=True,
        )
        self._env_ctx.start()

    def tearDown(self):
        self._env_ctx.stop()
        self._ctx.cleanup()

    def _mock_git(self, main: Path, wt: Path):
        return [
            patch("acb._git.main_worktree_root", return_value=main),
            patch("acb._git.worktree_root", return_value=wt),
        ]

    def _run_dir(self, branch: str, slug: str) -> Path:
        d = self.root / ".prove" / "runs" / branch / slug
        d.mkdir(parents=True)
        return d

    def test_plan_worktree_match_branched_layout(self):
        wt = self.root / "wt"
        wt.mkdir()
        run = self._run_dir("feature", "run-planned")
        _write_plan(run, wt)
        mocks = self._mock_git(self.root, wt)
        for m in mocks:
            m.start()
        try:
            self.assertEqual(resolve_run_slug(str(wt)), "run-planned")
        finally:
            for m in mocks:
                m.stop()

    def test_plan_worktree_match_flat_layout(self):
        # Legacy runs created at .prove/runs/<slug>/plan.json are still scannable
        # via rglob — slug resolves to the containing dir name.
        wt = self.root / "wt-flat"
        wt.mkdir()
        run = self.root / ".prove" / "runs" / "flat-slug"
        run.mkdir(parents=True)
        _write_plan(run, wt)
        mocks = self._mock_git(self.root, wt)
        for m in mocks:
            m.start()
        try:
            self.assertEqual(resolve_run_slug(str(wt)), "flat-slug")
        finally:
            for m in mocks:
                m.stop()

    def test_no_match_falls_through_to_marker(self):
        wt = self.root / "wt4"
        wt.mkdir()
        other_wt = self.root / "other"
        other_wt.mkdir()
        run = self._run_dir("feature", "mismatched")
        _write_plan(run, other_wt)
        (wt / ".prove").mkdir()
        (wt / ".prove" / "RUN_SLUG").write_text("fallback-slug")
        mocks = self._mock_git(self.root, wt)
        for m in mocks:
            m.start()
        try:
            self.assertEqual(resolve_run_slug(str(wt)), "fallback-slug")
        finally:
            for m in mocks:
                m.stop()

    def test_wt_slug_file_beats_plan_scan(self):
        wt = self.root / "wt-marked"
        wt.mkdir()
        (wt / ".prove-wt-slug.txt").write_text("wt-slug\n")
        run = self._run_dir("feature", "plan-slug")
        _write_plan(run, wt)
        mocks = self._mock_git(self.root, wt)
        for m in mocks:
            m.start()
        try:
            self.assertEqual(resolve_run_slug(str(wt)), "wt-slug")
        finally:
            for m in mocks:
                m.stop()

    def test_symlink_worktree_still_matches(self):
        real = self.root / "real-wt"
        real.mkdir()
        link = self.root / "linked-wt"
        os.symlink(real, link)
        run = self._run_dir("feature", "run-sym")
        _write_plan(run, real)
        mocks = self._mock_git(self.root, link)
        for m in mocks:
            m.start()
        try:
            self.assertEqual(resolve_run_slug(str(link)), "run-sym")
        finally:
            for m in mocks:
                m.stop()

    def test_malformed_plan_ignored(self):
        wt = self.root / "wt-bad"
        wt.mkdir()
        run = self._run_dir("feature", "broken")
        (run / "plan.json").write_text("{not json")
        mocks = self._mock_git(self.root, wt)
        for m in mocks:
            m.start()
        try:
            self.assertIsNone(resolve_run_slug(str(wt)))
        finally:
            for m in mocks:
                m.stop()


if __name__ == "__main__":
    unittest.main()
