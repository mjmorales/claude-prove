"""Tests for acb.hook — Claude Code PostToolUse hook logic."""

import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

_tool_dir = Path(__file__).resolve().parent
if str(_tool_dir.parent) not in sys.path:
    sys.path.insert(0, str(_tool_dir.parent))

from acb.hook import (
    _COMMIT_RE,
    _SKIP_BRANCHES,
    _commit_succeeded,
    _effective_cwd,
    main,
)


class TestCommitRegex(unittest.TestCase):
    def test_matches_git_commit(self):
        self.assertIsNotNone(_COMMIT_RE.search("git commit -m 'fix'"))

    def test_matches_git_commit_amend(self):
        self.assertIsNotNone(_COMMIT_RE.search("git commit --amend"))

    def test_no_match_git_push(self):
        self.assertIsNone(_COMMIT_RE.search("git push origin main"))

    def test_no_match_git_log(self):
        self.assertIsNone(_COMMIT_RE.search("git log --oneline"))


class TestSkipBranches(unittest.TestCase):
    def test_main_in_skip(self):
        self.assertIn("main", _SKIP_BRANCHES)

    def test_master_in_skip(self):
        self.assertIn("master", _SKIP_BRANCHES)


class TestEffectiveCwd(unittest.TestCase):
    """Parse `cd X && git commit` for effective cwd resolution."""

    def setUp(self):
        self._ctx = tempfile.TemporaryDirectory()
        self.root = Path(self._ctx.name)
        self.fallback = str(self.root)
        (self.root / "main").mkdir()
        (self.root / "wt").mkdir()
        (self.root / "wt with space").mkdir()

    def tearDown(self):
        self._ctx.cleanup()

    def test_no_cd_returns_fallback(self):
        cmd = "git commit -m 'msg'"
        self.assertEqual(_effective_cwd(cmd, self.fallback), self.fallback)

    def test_cd_absolute_path_resolves(self):
        wt = str(self.root / "wt")
        cmd = f"cd {wt} && git commit -m 'msg'"
        self.assertEqual(_effective_cwd(cmd, self.fallback), wt)

    def test_cd_relative_path_resolves_against_fallback(self):
        cmd = "cd wt && git commit -m 'msg'"
        self.assertEqual(
            _effective_cwd(cmd, self.fallback),
            str(self.root / "wt"),
        )

    def test_cd_double_quoted_path(self):
        wt = str(self.root / "wt with space")
        cmd = f'cd "{wt}" && git commit -m "msg"'
        self.assertEqual(_effective_cwd(cmd, self.fallback), wt)

    def test_cd_single_quoted_path(self):
        wt = str(self.root / "wt")
        cmd = f"cd '{wt}' && git commit -m msg"
        self.assertEqual(_effective_cwd(cmd, self.fallback), wt)

    def test_cd_with_env_var_falls_back(self):
        cmd = "cd $WORKTREE && git commit -m msg"
        self.assertEqual(_effective_cwd(cmd, self.fallback), self.fallback)

    def test_cd_to_nonexistent_path_falls_back(self):
        cmd = f"cd {self.root}/bogus && git commit"
        self.assertEqual(_effective_cwd(cmd, self.fallback), self.fallback)

    def test_last_cd_before_commit_wins(self):
        wt = str(self.root / "wt")
        other = str(self.root / "main")
        cmd = f"cd {other} && cd {wt} && git commit"
        self.assertEqual(_effective_cwd(cmd, self.fallback), wt)

    def test_cd_after_commit_ignored(self):
        # A `cd` that comes AFTER `git commit` isn't the target of the commit.
        wt = str(self.root / "wt")
        cmd = f"git commit -m msg && cd {wt}"
        self.assertEqual(_effective_cwd(cmd, self.fallback), self.fallback)

    def test_subshell_cd(self):
        wt = str(self.root / "wt")
        cmd = f"(cd {wt} && git commit -m msg)"
        self.assertEqual(_effective_cwd(cmd, self.fallback), wt)

    def test_semicolon_separator(self):
        wt = str(self.root / "wt")
        cmd = f"cd {wt}; git commit -m msg"
        self.assertEqual(_effective_cwd(cmd, self.fallback), wt)


class TestCommitSucceeded(unittest.TestCase):
    def test_none_response_treated_as_success(self):
        self.assertTrue(_commit_succeeded(None))

    def test_non_dict_response_treated_as_success(self):
        self.assertTrue(_commit_succeeded("ok"))

    def test_is_error_flag_fails(self):
        self.assertFalse(_commit_succeeded({"is_error": True}))

    def test_camel_case_is_error_fails(self):
        self.assertFalse(_commit_succeeded({"isError": True}))

    def test_nonzero_exit_code_fails(self):
        self.assertFalse(_commit_succeeded({"exit_code": 1}))

    def test_nonzero_camel_case_exit_code_fails(self):
        self.assertFalse(_commit_succeeded({"exitCode": 128}))

    def test_zero_exit_code_passes(self):
        self.assertTrue(_commit_succeeded({"exit_code": 0}))


class TestHookMain(unittest.TestCase):
    def _run_hook(self, hook_input: dict, workspace_root: str = "/tmp/repo") -> str:
        stdin = io.StringIO(json.dumps(hook_input))
        stdout = io.StringIO()
        with patch.object(sys, "stdin", stdin), patch.object(sys, "stdout", stdout):
            try:
                main(["--workspace-root", workspace_root])
            except SystemExit:
                pass
        return stdout.getvalue()

    def test_ignores_non_bash_tool(self):
        result = self._run_hook({"tool_name": "Read", "tool_input": {}})
        self.assertEqual(result, "")

    def test_ignores_non_commit_command(self):
        result = self._run_hook({
            "tool_name": "Bash",
            "tool_input": {"command": "git push origin main"},
        })
        self.assertEqual(result, "")

    def test_ignores_failed_commit(self):
        with patch("acb._git.current_branch", return_value="feature/auth"), \
             patch("acb._git.head_sha", return_value="abc123"), \
             patch("acb._git.main_worktree_root", return_value=Path("/tmp")):
            result = self._run_hook({
                "tool_name": "Bash",
                "tool_input": {"command": "git commit -m 'test'"},
                "tool_response": {"exit_code": 1},
            })
        self.assertEqual(result, "")

    @patch("acb._git.current_branch", return_value="main")
    def test_skips_main_branch(self, _branch):
        result = self._run_hook({
            "tool_name": "Bash",
            "tool_input": {"command": "git commit -m 'test'"},
        })
        self.assertEqual(result, "")

    @patch("acb._slug.resolve_run_slug", return_value=None)
    @patch("acb.hook._head_diff_stat", return_value=" src/auth.py | 10 ++++\n 1 file changed")
    @patch("acb.hook._manifest_exists", return_value=False)
    @patch("acb._git.main_worktree_root", return_value=Path("/tmp/repo"))
    @patch("acb._git.head_sha", return_value="deadbeef1234")
    @patch("acb._git.current_branch", return_value="feature/auth")
    def test_blocks_when_manifest_missing(self, *_mocks):
        result = self._run_hook({
            "tool_name": "Bash",
            "tool_input": {"command": "git commit -m 'test'"},
            "tool_response": {"exit_code": 0},
        })
        self.assertNotEqual(result, "")
        data = json.loads(result)
        self.assertEqual(data["decision"], "block")
        self.assertIn("feature/auth", data["reason"])
        self.assertIn("deadbeef1234", data["reason"])
        self.assertIn("--workspace-root /tmp/repo", data["reason"])

    @patch("acb._slug.resolve_run_slug", return_value=None)
    @patch("acb.hook._manifest_exists", return_value=True)
    @patch("acb._git.main_worktree_root", return_value=Path("/tmp/repo"))
    @patch("acb._git.head_sha", return_value="deadbeef1234")
    @patch("acb._git.current_branch", return_value="feature/auth")
    def test_allows_when_manifest_present(self, *_mocks):
        result = self._run_hook({
            "tool_name": "Bash",
            "tool_input": {"command": "git commit -m 'test'"},
            "tool_response": {"exit_code": 0},
        })
        self.assertEqual(result, "")

    @patch("acb._slug.resolve_run_slug", return_value="run-42")
    @patch("acb.hook._head_diff_stat", return_value="")
    @patch("acb.hook._manifest_exists", return_value=False)
    @patch("acb._git.main_worktree_root", return_value=Path("/tmp/repo"))
    @patch("acb._git.head_sha", return_value="deadbeef1234")
    @patch("acb._git.current_branch", return_value="feature/auth")
    def test_passes_slug_to_manifest_check_and_prompt(self, _b, _s, _r, exists_mock, _ds, _sl):
        result = self._run_hook({
            "tool_name": "Bash",
            "tool_input": {"command": "git commit -m 'test'"},
            "tool_response": {"exit_code": 0},
        })
        # Slug forwarded to the existence check.
        exists_mock.assert_called_once()
        self.assertEqual(exists_mock.call_args.kwargs.get("run_slug"), "run-42")
        # Prompt includes the slug and the save-manifest flag.
        data = json.loads(result)
        self.assertIn("run-42", data["reason"])
        self.assertIn("--slug run-42", data["reason"])

    @patch("acb._slug.resolve_run_slug", return_value=None)
    @patch("acb.hook._manifest_exists", return_value=False)
    @patch("acb._git.main_worktree_root", return_value=Path("/tmp/repo"))
    @patch("acb._git.head_sha", return_value="deadbeef1234")
    @patch("acb._git.current_branch", return_value="orchestrator/demo")
    def test_orchestrator_branch_requires_slug(self, *_mocks):
        result = self._run_hook({
            "tool_name": "Bash",
            "tool_input": {"command": "git commit -m 'test'"},
            "tool_response": {"exit_code": 0},
        })
        data = json.loads(result)
        self.assertEqual(data["decision"], "block")
        self.assertIn("orchestrator/demo", data["reason"])
        self.assertIn(".prove-wt-slug.txt", data["reason"])
        self.assertIn("no run slug resolved", data["reason"])

    @patch("acb._slug.resolve_run_slug", return_value=None)
    @patch("acb.hook._manifest_exists", return_value=False)
    @patch("acb._git.main_worktree_root", return_value=Path("/tmp/repo"))
    @patch("acb._git.head_sha", return_value="deadbeef1234")
    @patch("acb._git.current_branch", return_value="task/demo/1.1")
    def test_task_branch_requires_slug(self, *_mocks):
        result = self._run_hook({
            "tool_name": "Bash",
            "tool_input": {"command": "git commit -m 'test'"},
            "tool_response": {"exit_code": 0},
        })
        data = json.loads(result)
        self.assertEqual(data["decision"], "block")
        self.assertIn("task/demo/1.1", data["reason"])
        self.assertIn(".prove-wt-slug.txt", data["reason"])

    @patch("acb._slug.resolve_run_slug", return_value="demo")
    @patch("acb.hook._head_diff_stat", return_value="")
    @patch("acb.hook._manifest_exists", return_value=False)
    @patch("acb._git.main_worktree_root", return_value=Path("/tmp/repo"))
    @patch("acb._git.head_sha", return_value="deadbeef1234")
    @patch("acb._git.current_branch", return_value="orchestrator/demo")
    def test_orchestrator_branch_with_slug_falls_through(self, *_mocks):
        result = self._run_hook({
            "tool_name": "Bash",
            "tool_input": {"command": "git commit -m 'test'"},
            "tool_response": {"exit_code": 0},
        })
        # Slug resolved — hook should emit the normal manifest prompt, not the slug error.
        data = json.loads(result)
        self.assertEqual(data["decision"], "block")
        self.assertNotIn("no run slug resolved", data["reason"])
        self.assertIn("--slug demo", data["reason"])

    def test_cd_in_command_flows_through_to_git_cwd(self):
        """The cwd parsed from `cd X && git commit` must reach _git calls.

        Reproduces the sub-agent bug: session cwd = main worktree, the
        commit lives inside a worktree reached via `cd`. Without cd
        parsing, _git.current_branch is called with the main cwd and
        sees the wrong HEAD.
        """
        with tempfile.TemporaryDirectory() as tmp:
            main_root = Path(tmp) / "main"
            wt = Path(tmp) / "wt"
            main_root.mkdir()
            wt.mkdir()

            seen_cwds: list[str] = []

            def _fake_branch(cwd=None):
                seen_cwds.append(str(cwd))
                return "orchestrator/demo"

            def _fake_sha(cwd=None):
                seen_cwds.append(str(cwd))
                return "deadbeef"

            with patch("acb._git.current_branch", side_effect=_fake_branch), \
                 patch("acb._git.head_sha", side_effect=_fake_sha), \
                 patch("acb._git.main_worktree_root", return_value=main_root), \
                 patch("acb.hook._manifest_exists", return_value=True), \
                 patch("acb._slug.resolve_run_slug", return_value="demo"):
                self._run_hook({
                    "tool_name": "Bash",
                    "tool_input": {"command": f"cd {wt} && git commit -m msg"},
                    "tool_response": {"exit_code": 0},
                    "cwd": str(main_root),
                })

            # Every _git call should see the WORKTREE cwd, not the main cwd
            self.assertTrue(seen_cwds, "at least one _git call expected")
            for cwd in seen_cwds:
                self.assertEqual(cwd, str(wt))

    @patch("acb._git.head_sha", return_value=None)
    @patch("acb._git.current_branch", return_value="feature/auth")
    def test_bails_when_head_unresolvable(self, *_mocks):
        result = self._run_hook({
            "tool_name": "Bash",
            "tool_input": {"command": "git commit -m 'test'"},
            "tool_response": {"exit_code": 0},
        })
        self.assertEqual(result, "")

    def test_workspace_root_arg_is_required(self):
        stdin = io.StringIO(json.dumps({
            "tool_name": "Bash",
            "tool_input": {"command": "git commit -m 'test'"},
            "tool_response": {"exit_code": 0},
        }))
        stderr = io.StringIO()
        with patch.object(sys, "stdin", stdin), patch.object(sys, "stderr", stderr):
            with self.assertRaises(SystemExit) as cm:
                main([])
        self.assertNotEqual(cm.exception.code, 0)
        self.assertIn("--workspace-root", stderr.getvalue())

    def test_handles_invalid_json_stdin(self):
        stdin = io.StringIO("not json")
        stdout = io.StringIO()
        with patch.object(sys, "stdin", stdin), patch.object(sys, "stdout", stdout):
            main(["--workspace-root", "/tmp/repo"])
        self.assertEqual(stdout.getvalue(), "")


class TestManifestExistsHelper(unittest.TestCase):
    def test_no_store(self):
        from acb.hook import _manifest_exists
        with tempfile.TemporaryDirectory() as tmp:
            self.assertFalse(_manifest_exists(tmp, "deadbeef"))

    def test_empty_store(self):
        from acb.hook import _manifest_exists
        from acb.store import open_store
        with tempfile.TemporaryDirectory() as tmp:
            store = open_store(tmp)
            store.close()
            self.assertFalse(_manifest_exists(tmp, "deadbeef"))

    def test_store_with_matching_sha(self):
        from acb.hook import _manifest_exists
        from acb.store import open_store
        with tempfile.TemporaryDirectory() as tmp:
            store = open_store(tmp)
            store.save_manifest("feat/x", "abc123def456", {
                "acb_manifest_version": "0.2",
                "commit_sha": "abc123def456",
                "timestamp": "2026-01-01T00:00:00Z",
                "intent_groups": [{
                    "id": "g1", "title": "t", "classification": "explicit",
                    "file_refs": [{"path": "a.py"}],
                }],
            })
            store.close()
            # Full SHA matches.
            self.assertTrue(_manifest_exists(tmp, "abc123def456"))
            # Prefix matches.
            self.assertTrue(_manifest_exists(tmp, "abc123"))
            # Non-matching SHA does not.
            self.assertFalse(_manifest_exists(tmp, "ffffff"))


if __name__ == "__main__":
    unittest.main()
