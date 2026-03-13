"""Description generator for CAFI using the Claude CLI.

Generates routing-hint descriptions for files by calling the `claude` CLI
with a structured prompt. Descriptions help LLM coding agents decide which
files are relevant for a given task.
"""

from __future__ import annotations

import logging
import subprocess
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

logger = logging.getLogger(__name__)

MAX_CONTENT_LENGTH = 8000
CLI_TIMEOUT_SECONDS = 30

PROMPT_TEMPLATE = """\
Describe this file as a routing hint for an LLM coding agent. Your description must follow this exact format:

Read this file when [specific task/scenario]. Contains [what the file contains]. Key exports: [main functions/classes/constants].

Rules:
- Be specific about WHEN to read (not just "when working with X" but "when adding a new validator" or "when debugging test failures")
- The description must be a single paragraph, max 3 sentences
- Focus on actionability: what task would make this file relevant?
- Do not include the file path in the description

File path: {path}

File contents:
{content}"""


def generate_prompt(file_path: str, content: str) -> str:
    """Build the prompt that asks Claude to describe a file as a routing hint.

    Args:
        file_path: Path to the file being described.
        content: The raw file content. Truncated to MAX_CONTENT_LENGTH characters.

    Returns:
        The formatted prompt string.
    """
    truncated = content[:MAX_CONTENT_LENGTH]
    if len(content) > MAX_CONTENT_LENGTH:
        truncated += "\n\n[... truncated at 8000 characters ...]"
    return PROMPT_TEMPLATE.format(path=file_path, content=truncated)


def _call_claude_cli(prompt: str) -> str:
    """Call the claude CLI to generate a description.

    Args:
        prompt: The prompt text to send to Claude.

    Returns:
        The CLI stdout output, stripped of leading/trailing whitespace.

    Raises:
        FileNotFoundError: If the claude CLI is not found on PATH.
        subprocess.TimeoutExpired: If the CLI does not respond within the timeout.
        subprocess.CalledProcessError: If the CLI exits with a non-zero code.
    """
    result = subprocess.run(
        ["claude", "-p", "-", "--output-format", "text", "--model", "haiku"],
        input=prompt,
        capture_output=True,
        text=True,
        timeout=CLI_TIMEOUT_SECONDS,
        check=True,
    )
    return result.stdout.strip()


def describe_file(file_path: str, project_root: str) -> str:
    """Read a file and generate a routing-hint description via the Claude CLI.

    Args:
        file_path: Path to the file (relative or absolute).
        project_root: The root directory of the project.

    Returns:
        The generated description string, or an empty string on failure.
    """
    full_path = Path(project_root) / file_path
    try:
        content = full_path.read_text(errors="replace")
    except OSError as exc:
        logger.warning("Could not read %s: %s", file_path, exc)
        return ""

    prompt = generate_prompt(file_path, content)
    try:
        return _call_claude_cli(prompt)
    except (FileNotFoundError, subprocess.TimeoutExpired, subprocess.CalledProcessError) as exc:
        logger.warning("Claude CLI failed for %s: %s", file_path, exc)
        return ""


def describe_files(
    file_paths: list[str],
    project_root: str,
    concurrency: int = 3,
    on_progress: Callable[[int, int, str], None] | None = None,
) -> dict[str, str]:
    """Batch-describe multiple files using parallel Claude CLI calls.

    Args:
        file_paths: List of file paths to describe.
        project_root: The root directory of the project.
        concurrency: Maximum number of concurrent CLI calls.
        on_progress: Optional callback invoked after each file completes.
            Called with (completed_count, total_count, file_path).

    Returns:
        Dict mapping each file path to its generated description.
        Files that fail get an empty-string description.
    """
    results: dict[str, str] = {}
    total = len(file_paths)
    completed = 0

    with ThreadPoolExecutor(max_workers=concurrency) as executor:
        future_to_path = {
            executor.submit(describe_file, fp, project_root): fp
            for fp in file_paths
        }
        for future in as_completed(future_to_path):
            fp = future_to_path[future]
            try:
                results[fp] = future.result()
            except Exception as exc:  # noqa: BLE001
                logger.warning("Unexpected error describing %s: %s", fp, exc)
                results[fp] = ""
            completed += 1
            if on_progress:
                on_progress(completed, total, fp)

    return results
