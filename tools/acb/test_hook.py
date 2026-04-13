"""Tests for acb.hook — Claude Code PreToolUse hook logic."""

import io
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

from acb.hook import main, _COMMIT_RE, _SKIP_BRANCHES


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


class TestHookMain(unittest.TestCase):
    def _run_hook(self, hook_input: dict) -> str:
        """Run main() with given input on stdin, return stdout."""
        stdin = io.StringIO(json.dumps(hook_input))
        stdout = io.StringIO()
        with patch.object(sys, "stdin", stdin), patch.object(sys, "stdout", stdout):
            try:
                main()
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

    @patch("acb.hook._current_branch", return_value="main")
    def test_skips_main_branch(self, _branch):
        result = self._run_hook({
            "tool_name": "Bash",
            "tool_input": {"command": "git commit -m 'test'"},
        })
        self.assertEqual(result, "")

    @patch("acb.hook._current_branch", return_value="feature/auth")
    @patch("acb.hook._staged_diff_stat", return_value=" src/auth.py | 10 ++++\n 1 file changed")
    @patch("acb.hook._manifest_exists", return_value=False)
    def test_blocks_commit_without_manifest(self, _exists, _stat, _branch):
        result = self._run_hook({
            "tool_name": "Bash",
            "tool_input": {"command": "git commit -m 'test'"},
        })
        self.assertNotEqual(result, "")
        data = json.loads(result)
        hook_output = data["hookSpecificOutput"]
        self.assertEqual(hook_output["permissionDecision"], "deny")
        self.assertIn("feature/auth", hook_output["permissionDecisionReason"])

    @patch("acb.hook._current_branch", return_value="feature/auth")
    @patch("acb.hook._manifest_exists", return_value=True)
    def test_allows_commit_with_manifest(self, _exists, _branch):
        result = self._run_hook({
            "tool_name": "Bash",
            "tool_input": {"command": "git commit -m 'test'"},
        })
        # Empty output = allow (no deny response)
        self.assertEqual(result, "")

    @patch("acb.hook._current_branch", return_value="feature/auth")
    @patch("acb.hook._staged_diff_stat", return_value="")
    @patch("acb.hook._manifest_exists", return_value=False)
    def test_allows_empty_staging(self, _exists, _stat, _branch):
        """No staged changes — let git commit fail naturally."""
        result = self._run_hook({
            "tool_name": "Bash",
            "tool_input": {"command": "git commit -m 'test'"},
        })
        self.assertEqual(result, "")

    def test_handles_invalid_json_stdin(self):
        stdin = io.StringIO("not json")
        stdout = io.StringIO()
        with patch.object(sys, "stdin", stdin), patch.object(sys, "stdout", stdout):
            main()
        self.assertEqual(stdout.getvalue(), "")


class TestManifestExists(unittest.TestCase):
    def test_no_store(self):
        from acb.hook import _manifest_exists
        with tempfile.TemporaryDirectory() as tmp:
            self.assertFalse(_manifest_exists(tmp, "feat/x"))

    def test_empty_store(self):
        from acb.hook import _manifest_exists
        from acb.store import open_store
        with tempfile.TemporaryDirectory() as tmp:
            store = open_store(tmp)
            store.close()
            self.assertFalse(_manifest_exists(tmp, "feat/x"))

    def test_store_with_manifest(self):
        from acb.hook import _manifest_exists
        from acb.store import open_store
        with tempfile.TemporaryDirectory() as tmp:
            store = open_store(tmp)
            store.save_manifest("feat/x", "abc", {
                "acb_manifest_version": "0.2",
                "commit_sha": "abc",
                "timestamp": "2026-01-01T00:00:00Z",
                "intent_groups": [{"id": "g1", "title": "t", "classification": "explicit",
                                   "file_refs": [{"path": "a.py"}]}],
            })
            store.close()
            self.assertTrue(_manifest_exists(tmp, "feat/x"))
            self.assertFalse(_manifest_exists(tmp, "feat/y"))


if __name__ == "__main__":
    unittest.main()
