"""Tests for acb.hook — Claude Code PostToolUse hook logic."""

import io
import json
import sys
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
        result = self._run_hook({"tool_name": "Read", "tool_input": {}, "tool_result": {}})
        self.assertEqual(result, "")

    def test_ignores_non_commit_command(self):
        result = self._run_hook({
            "tool_name": "Bash",
            "tool_input": {"command": "git push origin main"},
            "tool_result": {"stdout": "", "stderr": ""},
        })
        self.assertEqual(result, "")

    def test_ignores_failed_commit(self):
        result = self._run_hook({
            "tool_name": "Bash",
            "tool_input": {"command": "git commit -m 'test'"},
            "tool_result": {"stdout": "nothing to commit", "stderr": ""},
        })
        self.assertEqual(result, "")

    @patch("acb.hook._current_branch", return_value="main")
    @patch("acb.hook._head_short_sha", return_value="abc1234")
    def test_skips_main_branch(self, _sha, _branch):
        result = self._run_hook({
            "tool_name": "Bash",
            "tool_input": {"command": "git commit -m 'test'"},
            "tool_result": {"stdout": "[feature abc1234] test", "stderr": ""},
        })
        self.assertEqual(result, "")

    @patch("acb.hook._current_branch", return_value="feature/auth")
    @patch("acb.hook._head_short_sha", return_value="abc1234")
    def test_returns_message_on_feature_branch(self, _sha, _branch):
        result = self._run_hook({
            "tool_name": "Bash",
            "tool_input": {"command": "git commit -m 'test'"},
            "tool_result": {"stdout": "[feature/auth abc1234] test", "stderr": ""},
        })
        self.assertNotEqual(result, "")
        data = json.loads(result)
        self.assertIn("systemMessage", data)
        self.assertIn("abc1234", data["systemMessage"])
        self.assertIn(".prove/intents/", data["systemMessage"])

    def test_handles_invalid_json_stdin(self):
        stdin = io.StringIO("not json")
        stdout = io.StringIO()
        with patch.object(sys, "stdin", stdin), patch.object(sys, "stdout", stdout):
            main()
        self.assertEqual(stdout.getvalue(), "")


if __name__ == "__main__":
    unittest.main()
