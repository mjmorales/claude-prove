"""Tests for the CAFI description generator."""

import json
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
    _build_batch_prompt,
    _call_claude_cli,
    _chunk_list,
    _describe_batch,
    _strip_json_fences,
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

    @patch("cafi.describer.subprocess.run")
    def test_call_claude_cli_custom_timeout(self, mock_run):
        """Verify custom timeout is passed through."""
        mock_run.return_value = MagicMock(stdout="desc")
        _call_claude_cli("prompt", timeout=120)
        mock_run.assert_called_once()
        call_kwargs = mock_run.call_args
        self.assertEqual(call_kwargs.kwargs.get("timeout") or call_kwargs[1].get("timeout"), 120)

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


class TestStripJsonFences(unittest.TestCase):
    """Tests for _strip_json_fences."""

    def test_no_fences(self):
        self.assertEqual(_strip_json_fences('{"a": "b"}'), '{"a": "b"}')

    def test_json_fences(self):
        self.assertEqual(_strip_json_fences('```json\n{"a": "b"}\n```'), '{"a": "b"}')

    def test_plain_fences(self):
        self.assertEqual(_strip_json_fences('```\n{"a": "b"}\n```'), '{"a": "b"}')


class TestChunkList(unittest.TestCase):
    """Tests for _chunk_list."""

    def test_even_split(self):
        self.assertEqual(_chunk_list([1, 2, 3, 4], 2), [[1, 2], [3, 4]])

    def test_uneven_split(self):
        self.assertEqual(_chunk_list([1, 2, 3], 2), [[1, 2], [3]])

    def test_single_chunk(self):
        self.assertEqual(_chunk_list([1, 2], 5), [[1, 2]])

    def test_empty(self):
        self.assertEqual(_chunk_list([], 3), [])


class TestBuildBatchPrompt(unittest.TestCase):
    """Tests for _build_batch_prompt."""

    def test_includes_all_files(self):
        entries = [("a.py", "code a"), ("b.py", "code b")]
        prompt = _build_batch_prompt(entries)
        self.assertIn("--- FILE: a.py ---", prompt)
        self.assertIn("--- FILE: b.py ---", prompt)
        self.assertIn("code a", prompt)
        self.assertIn("code b", prompt)
        self.assertIn("JSON object", prompt)

    def test_truncates_long_content(self):
        long = "x" * (MAX_CONTENT_LENGTH + 100)
        prompt = _build_batch_prompt([("big.py", long)])
        self.assertIn("[... truncated at 8000 characters ...]", prompt)


class TestDescribeBatch(unittest.TestCase):
    """Tests for _describe_batch."""

    @patch("cafi.describer._call_claude_cli")
    @patch("cafi.describer.Path.read_text", return_value="some content")
    def test_batch_success(self, _mock_read, mock_cli):
        """Verify batch returns parsed JSON descriptions."""
        response = json.dumps({
            "a.py": "Read this file when doing A.",
            "b.py": "Read this file when doing B.",
        })
        mock_cli.return_value = response
        result = _describe_batch(["a.py", "b.py"], ".")
        self.assertEqual(result["a.py"], "Read this file when doing A.")
        self.assertEqual(result["b.py"], "Read this file when doing B.")

    @patch("cafi.describer._call_claude_cli")
    @patch("cafi.describer.Path.read_text", return_value="some content")
    def test_batch_single_file_uses_simple_prompt(self, _mock_read, mock_cli):
        """Single-file batch should use per-file prompt, not batch prompt."""
        mock_cli.return_value = "Read this file when testing."
        result = _describe_batch(["a.py"], ".")
        self.assertEqual(result["a.py"], "Read this file when testing.")
        # Verify the prompt sent was the single-file format (contains "routing hint")
        prompt_sent = mock_cli.call_args[0][0]
        self.assertIn("routing hint", prompt_sent)
        self.assertNotIn("JSON object", prompt_sent)

    @patch("cafi.describer._call_claude_cli")
    @patch("cafi.describer.Path.read_text", return_value="some content")
    def test_batch_cli_failure(self, _mock_read, mock_cli):
        """Verify all files get empty descriptions on CLI failure."""
        mock_cli.side_effect = subprocess.CalledProcessError(returncode=1, cmd="claude")
        result = _describe_batch(["a.py", "b.py"], ".")
        self.assertEqual(result, {"a.py": "", "b.py": ""})

    @patch("cafi.describer._call_claude_cli")
    @patch("cafi.describer.Path.read_text", return_value="some content")
    def test_batch_invalid_json(self, _mock_read, mock_cli):
        """Verify graceful handling of non-JSON response."""
        mock_cli.return_value = "not valid json"
        result = _describe_batch(["a.py", "b.py"], ".")
        self.assertEqual(result, {"a.py": "", "b.py": ""})

    @patch("cafi.describer._call_claude_cli")
    @patch("cafi.describer.Path.read_text", return_value="some content")
    def test_batch_non_dict_json(self, _mock_read, mock_cli):
        """Verify graceful handling when response is JSON but not a dict."""
        mock_cli.return_value = '["a.py", "b.py"]'
        result = _describe_batch(["a.py", "b.py"], ".")
        self.assertEqual(result, {"a.py": "", "b.py": ""})

    @patch("cafi.describer.Path.read_text", side_effect=OSError("Permission denied"))
    def test_batch_unreadable_files(self, _mock_read):
        """Verify unreadable files get empty descriptions without CLI call."""
        result = _describe_batch(["secret.py"], ".")
        self.assertEqual(result, {"secret.py": ""})

    @patch("cafi.describer._call_claude_cli")
    @patch("cafi.describer.Path.read_text", return_value="content")
    def test_batch_strips_markdown_fences(self, _mock_read, mock_cli):
        """Verify markdown fences are stripped from batch response."""
        response = '```json\n{"a.py": "desc a"}\n```'
        mock_cli.return_value = response
        result = _describe_batch(["a.py"], ".")
        # Single file uses simple prompt, so let's test with 2 files
        result = _describe_batch(["a.py", "b.py"], ".")
        # The fenced response only has a.py, b.py should be empty
        self.assertEqual(result["a.py"], "desc a")
        self.assertEqual(result["b.py"], "")


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
        result = describe_files(["a.py", "b.py"], project_root=".", concurrency=2, batch_size=5)
        # Both files should get empty descriptions, not raise
        self.assertEqual(result, {"a.py": "", "b.py": ""})

    @patch("cafi.describer._call_claude_cli")
    @patch("cafi.describer.Path.read_text", return_value="some content")
    def test_describe_files_success_batched(self, _mock_read, mock_cli):
        """Verify successful batched describe_files returns descriptions."""
        response = json.dumps({
            "a.py": "Read this file when testing.",
            "b.py": "Read this file when building.",
        })
        mock_cli.return_value = response
        result = describe_files(
            ["a.py", "b.py"], project_root=".", concurrency=1, batch_size=5
        )
        self.assertEqual(result["a.py"], "Read this file when testing.")
        self.assertEqual(result["b.py"], "Read this file when building.")

    @patch("cafi.describer._call_claude_cli")
    @patch("cafi.describer.Path.read_text", return_value="some content")
    def test_describe_files_multiple_batches(self, _mock_read, mock_cli):
        """Verify files are split across batches correctly."""
        # batch_size=1 means each file is its own batch (single-file path)
        mock_cli.return_value = "Read this file when testing."
        result = describe_files(
            ["a.py", "b.py", "c.py"],
            project_root=".",
            concurrency=2,
            batch_size=1,
        )
        self.assertEqual(len(result), 3)
        # With batch_size=1, _call_claude_cli should be called 3 times (once per file)
        self.assertEqual(mock_cli.call_count, 3)

    @patch("cafi.describer._call_claude_cli")
    @patch("cafi.describer.Path.read_text", return_value="some content")
    def test_describe_files_progress_callback(self, _mock_read, mock_cli):
        """Verify progress callback is called after each batch."""
        mock_cli.return_value = "desc"
        calls = []
        result = describe_files(
            ["a.py", "b.py", "c.py"],
            project_root=".",
            concurrency=1,
            batch_size=2,
            on_progress=lambda done, total, path: calls.append((done, total)),
        )
        # 2 batches: [a.py, b.py] and [c.py]
        self.assertEqual(len(calls), 2)
        # Final call should report all done
        self.assertTrue(any(done == 3 for done, total in calls))


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
