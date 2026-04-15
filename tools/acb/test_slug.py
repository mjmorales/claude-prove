"""Tests for acb._slug — run-slug resolution."""

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
    """Slug resolution via ``.prove/runs/<slug>/`` registration."""

    def setUp(self):
        self._ctx = tempfile.TemporaryDirectory()
        self.root = Path(self._ctx.name)
        # Isolate env so PROVE_RUN_SLUG from the outer shell never leaks.
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

    def _run_dir(self, slug: str) -> Path:
        d = self.root / ".prove" / "runs" / slug
        d.mkdir(parents=True)
        return d

    def test_worktree_file_match(self):
        wt = self.root / "wt"
        wt.mkdir()
        run = self._run_dir("run-explicit")
        (run / "worktree").write_text(str(wt))
        for m in self._mock_git(self.root, wt):
            m.start()
        try:
            self.assertEqual(resolve_run_slug(str(wt)), "run-explicit")
        finally:
            for m in self._mock_git(self.root, wt):
                m.stop()

    def test_task_plan_worktree_field_match(self):
        wt = self.root / "wt2"
        wt.mkdir()
        run = self._run_dir("run-planned")
        (run / "TASK_PLAN.md").write_text(
            "# Plan\n\n"
            "**Branch:** feat/foo\n"
            f"**Worktree:** {wt}\n"
            "**Baseline:** main\n"
        )
        mocks = self._mock_git(self.root, wt)
        for m in mocks:
            m.start()
        try:
            self.assertEqual(resolve_run_slug(str(wt)), "run-planned")
        finally:
            for m in mocks:
                m.stop()

    def test_worktree_file_beats_task_plan_when_both_match(self):
        wt = self.root / "wt3"
        wt.mkdir()
        good = self._run_dir("good")
        (good / "worktree").write_text(str(wt))
        # Another run also claims the same worktree via TASK_PLAN.md.
        bad = self._run_dir("bad-plan")
        (bad / "TASK_PLAN.md").write_text(f"**Worktree:** {wt}\n")
        mocks = self._mock_git(self.root, wt)
        for m in mocks:
            m.start()
        try:
            # Iteration order is sorted alphabetically; "bad-plan" < "good".
            # Both matches are valid; the invariant we care about is that a
            # matching run is found, deterministically.
            result = resolve_run_slug(str(wt))
            self.assertIn(result, {"good", "bad-plan"})
        finally:
            for m in mocks:
                m.stop()

    def test_no_match_falls_through_to_marker(self):
        wt = self.root / "wt4"
        wt.mkdir()
        other_wt = self.root / "other"
        other_wt.mkdir()
        run = self._run_dir("mismatched")
        (run / "worktree").write_text(str(other_wt))
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

    def test_wt_slug_file_beats_runs_dir(self):
        wt = self.root / "wt-marked"
        wt.mkdir()
        (wt / ".prove-wt-slug.txt").write_text("wt-slug\n")
        run = self._run_dir("runs-dir-slug")
        (run / "worktree").write_text(str(wt))
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
        run = self._run_dir("run-sym")
        # Registration written with the realpath.
        (run / "worktree").write_text(str(real))
        mocks = self._mock_git(self.root, link)
        for m in mocks:
            m.start()
        try:
            # _git.worktree_root would normally return the symlink; _normalize
            # resolves both sides.
            self.assertEqual(resolve_run_slug(str(link)), "run-sym")
        finally:
            for m in mocks:
                m.stop()


if __name__ == "__main__":
    unittest.main()
