"""Tests for the CAFI description generator."""

import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

# Ensure the parent package is importable when running via unittest discover
_cafi_dir = Path(__file__).resolve().parent
if str(_cafi_dir.parent) not in sys.path:
    sys.path.insert(0, str(_cafi_dir.parent))

from cafi.describer import (  # noqa: E402
    MAX_CONTENT_LENGTH,
    _call_claude_cli,
    describe_file,
    describe_files,
    generate_prompt,
    triage_files,
)


class TestGeneratePrompt(unittest.TestCase):
    """Tests for generate_prompt."""

    def test_generate_prompt(self):
        """Verify prompt template includes path and content."""
        prompt = generate_prompt("src/utils.py", "def helper(): pass")
        self.assertIn("src/utils.py", prompt)
        self.assertIn("def helper(): pass", prompt)
        self.assertIn("routing hint", prompt)

    def test_generate_prompt_truncation(self):
        """Verify content > 8000 chars is truncated with marker."""
        long_content = "x" * (MAX_CONTENT_LENGTH + 5000)
        prompt = generate_prompt("big.py", long_content)
        # The prompt should contain exactly MAX_CONTENT_LENGTH x's, not the full content
        self.assertIn("x" * MAX_CONTENT_LENGTH, prompt)
        self.assertNotIn("x" * (MAX_CONTENT_LENGTH + 1), prompt)
        self.assertIn("[... truncated at 8000 characters ...]", prompt)

    def test_generate_prompt_no_truncation_marker_when_short(self):
        """Verify no truncation marker when content fits."""
        prompt = generate_prompt("small.py", "short content")
        self.assertNotIn("truncated", prompt)


class TestCallClaudeCli(unittest.TestCase):
    """Tests for _call_claude_cli."""

    @patch("cafi.describer.subprocess.run")
    def test_call_claude_cli_success(self, mock_run):
        """Verify successful CLI call returns stripped stdout."""
        mock_run.return_value = MagicMock(stdout="  A description.\n")
        result = _call_claude_cli("some prompt")
        self.assertEqual(result, "A description.")
        mock_run.assert_called_once_with(
            ["claude", "-p", "-", "--output-format", "text", "--model", "haiku"],
            input="some prompt",
            capture_output=True,
            text=True,
            timeout=30,
            check=True,
        )

    @patch(
        "cafi.describer.subprocess.run",
        side_effect=FileNotFoundError("claude not found"),
    )
    def test_call_claude_cli_not_found(self, _mock_run):
        """Verify FileNotFoundError propagates."""
        with self.assertRaises(FileNotFoundError):
            _call_claude_cli("prompt")

    @patch(
        "cafi.describer.subprocess.run",
        side_effect=subprocess.TimeoutExpired(cmd="claude", timeout=30),
    )
    def test_call_claude_cli_timeout(self, _mock_run):
        """Verify timeout handling."""
        with self.assertRaises(subprocess.TimeoutExpired):
            _call_claude_cli("prompt")

    @patch(
        "cafi.describer.subprocess.run",
        side_effect=subprocess.CalledProcessError(returncode=1, cmd="claude"),
    )
    def test_call_claude_cli_nonzero_exit(self, _mock_run):
        """Verify CalledProcessError propagates."""
        with self.assertRaises(subprocess.CalledProcessError):
            _call_claude_cli("prompt")


class TestDescribeFiles(unittest.TestCase):
    """Tests for describe_file and describe_files."""

    @patch("cafi.describer.Path.read_text", side_effect=OSError("Permission denied"))
    def test_describe_file_unreadable(self, _mock_read):
        """Verify describe_file returns empty string when file is unreadable."""
        result = describe_file("secret.py", project_root=".")
        self.assertEqual(result, "")

    @patch("cafi.describer._call_claude_cli")
    @patch("cafi.describer.Path.read_text", return_value="some content")
    def test_describe_files_handles_errors(self, _mock_read, mock_cli):
        """Mock subprocess to simulate CLI failure; verify graceful degradation."""
        mock_cli.side_effect = subprocess.CalledProcessError(
            returncode=1, cmd="claude"
        )
        # describe_file catches the error and returns ""
        result = describe_files(["a.py", "b.py"], project_root=".", concurrency=2)
        # Both files should get empty descriptions, not raise
        self.assertEqual(result, {"a.py": "", "b.py": ""})

    @patch("cafi.describer._call_claude_cli")
    @patch("cafi.describer.Path.read_text", return_value="some content")
    def test_describe_files_success(self, _mock_read, mock_cli):
        """Verify successful describe_files returns descriptions."""
        mock_cli.return_value = "Read this file when testing."
        result = describe_files(["a.py"], project_root=".", concurrency=1)
        self.assertEqual(result, {"a.py": "Read this file when testing."})


class TestTriageFiles(unittest.TestCase):
    """Tests for triage_files."""

    def test_triage_empty_list(self):
        """Verify empty input returns empty output without calling CLI."""
        result = triage_files([])
        self.assertEqual(result, [])

    @patch("cafi.describer.subprocess.run")
    def test_triage_filters_files(self, mock_run):
        """Verify triage returns only the files Claude selects."""
        all_files = ["src/main.py", "src/utils.py", "tests/test_main.py", "logo.png"]
        mock_run.return_value = MagicMock(
            stdout='["src/main.py", "src/utils.py"]'
        )
        result = triage_files(all_files)
        self.assertEqual(result, ["src/main.py", "src/utils.py"])

    @patch("cafi.describer.subprocess.run")
    def test_triage_strips_markdown_fences(self, mock_run):
        """Verify markdown code fences are stripped from response."""
        all_files = ["src/app.py", "README.md"]
        mock_run.return_value = MagicMock(
            stdout='```json\n["src/app.py"]\n```'
        )
        result = triage_files(all_files)
        self.assertEqual(result, ["src/app.py"])

    @patch("cafi.describer.subprocess.run")
    def test_triage_ignores_unknown_paths(self, mock_run):
        """Verify paths not in the input list are filtered out."""
        all_files = ["src/main.py"]
        mock_run.return_value = MagicMock(
            stdout='["src/main.py", "src/ghost.py"]'
        )
        result = triage_files(all_files)
        self.assertEqual(result, ["src/main.py"])

    @patch(
        "cafi.describer.subprocess.run",
        side_effect=subprocess.TimeoutExpired(cmd="claude", timeout=60),
    )
    def test_triage_fallback_on_timeout(self, _mock_run):
        """Verify all files returned when CLI times out."""
        all_files = ["a.py", "b.py"]
        result = triage_files(all_files)
        self.assertEqual(result, all_files)

    @patch(
        "cafi.describer.subprocess.run",
        side_effect=FileNotFoundError("claude not found"),
    )
    def test_triage_fallback_on_missing_cli(self, _mock_run):
        """Verify all files returned when claude CLI not found."""
        all_files = ["a.py", "b.py"]
        result = triage_files(all_files)
        self.assertEqual(result, all_files)

    @patch("cafi.describer.subprocess.run")
    def test_triage_fallback_on_invalid_json(self, mock_run):
        """Verify all files returned when CLI returns invalid JSON."""
        all_files = ["a.py"]
        mock_run.return_value = MagicMock(stdout="not json at all")
        result = triage_files(all_files)
        self.assertEqual(result, all_files)

    @patch("cafi.describer.subprocess.run")
    def test_triage_fallback_on_non_list(self, mock_run):
        """Verify all files returned when CLI returns non-list JSON."""
        all_files = ["a.py"]
        mock_run.return_value = MagicMock(stdout='{"files": ["a.py"]}')
        result = triage_files(all_files)
        self.assertEqual(result, all_files)


if __name__ == "__main__":
    unittest.main()
