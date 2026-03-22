"""Description generator for CAFI using the Claude CLI.

Generates routing-hint descriptions for files by calling the `claude` CLI
with a structured prompt. Descriptions help LLM coding agents decide which
files are relevant for a given task.

LLM calls are reserved exclusively for description generation. File triage
(deciding what to index) is done with deterministic heuristics to save tokens.
Files are batched so that each CLI session describes multiple files at once,
reducing cold-start overhead.
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor, as_completed
from fnmatch import fnmatch
from pathlib import Path

logger = logging.getLogger(__name__)

MAX_CONTENT_LENGTH = 8000
CLI_TIMEOUT_SECONDS = 30
BATCH_TIMEOUT_SECONDS = 120
DEFAULT_BATCH_SIZE = 25

# --- Heuristic triage patterns (no LLM call needed) ---

# Files matching these patterns are excluded from indexing.
TRIAGE_EXCLUDE_PATTERNS: list[str] = [
    # Test files
    "test_*", "*_test.*", "*_spec.*", "*.test.*", "*.spec.*",
    "conftest.py", "jest.config.*", "vitest.config.*",
    # Asset files
    "*.png", "*.jpg", "*.jpeg", "*.gif", "*.svg", "*.ico",
    "*.woff", "*.woff2", "*.ttf", "*.eot",
    "*.mp3", "*.mp4", "*.wav", "*.webm",
    # Generated / lock files
    "*.lock", "*.min.js", "*.min.css", "*.map",
    "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
    "poetry.lock", "Pipfile.lock", "Cargo.lock", "go.sum",
    # Boilerplate
    "LICENSE", "LICENSE.*", "CHANGELOG*", "CHANGES*",
    ".gitignore", ".gitattributes", ".editorconfig",
    ".prettierrc*", ".eslintignore", ".stylelintrc*",
    ".dockerignore",
]

# Directories whose contents are excluded entirely.
TRIAGE_EXCLUDE_DIRS: list[str] = [
    "tests/", "test/", "__tests__/", "spec/",
    "vendor/", "node_modules/", "dist/", "build/",
    ".git/", "__pycache__/", ".mypy_cache/", ".pytest_cache/",
    ".tox/", ".venv/", "venv/", "env/",
]

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

BATCH_PROMPT_TEMPLATE = """\
Describe each file below as a routing hint for an LLM coding agent. For each file, \
produce a description following this exact format:

Read this file when [specific task/scenario]. Contains [what the file contains]. Key exports: [main functions/classes/constants].

Rules:
- Be specific about WHEN to read (not just "when working with X" but "when adding a new validator" or "when debugging test failures")
- Each description must be a single paragraph, max 3 sentences
- Focus on actionability: what task would make this file relevant?
- Do not include the file path in the description

Return ONLY a JSON object mapping each file path to its description string. \
No explanation, no markdown fences, just the JSON object.

Example output format:
{{"src/utils.py": "Read this file when adding helper functions. Contains utility methods for string parsing. Key exports: parse_url, slugify.", "src/main.py": "Read this file when modifying the CLI entry point. Contains argument parsing and command dispatch. Key exports: main, run_command."}}

{files_block}"""


def _truncate_content(content: str) -> str:
    """Truncate content to MAX_CONTENT_LENGTH with a marker if needed."""
    if len(content) <= MAX_CONTENT_LENGTH:
        return content
    return content[:MAX_CONTENT_LENGTH] + "\n\n[... truncated at 8000 characters ...]"


def generate_prompt(file_path: str, content: str) -> str:
    """Build the prompt that asks Claude to describe a file as a routing hint.

    Args:
        file_path: Path to the file being described.
        content: The raw file content. Truncated to MAX_CONTENT_LENGTH characters.

    Returns:
        The formatted prompt string.
    """
    truncated = _truncate_content(content)
    return PROMPT_TEMPLATE.format(path=file_path, content=truncated)


def _build_batch_prompt(file_entries: list[tuple[str, str]]) -> str:
    """Build a prompt for describing multiple files in one CLI call.

    Args:
        file_entries: List of (file_path, content) tuples.

    Returns:
        The formatted batch prompt string.
    """
    parts = []
    for path, content in file_entries:
        truncated = _truncate_content(content)
        parts.append(f"--- FILE: {path} ---\n{truncated}\n--- END FILE ---")

    files_block = "\n\n".join(parts)
    return BATCH_PROMPT_TEMPLATE.format(files_block=files_block)


def _is_triage_excluded(path: str) -> bool:
    """Check if a file path should be excluded by triage heuristics."""
    basename = os.path.basename(path)

    # Check directory prefixes
    for dir_pattern in TRIAGE_EXCLUDE_DIRS:
        if path.startswith(dir_pattern) or f"/{dir_pattern}" in f"/{path}":
            return True

    # Check file patterns
    for pattern in TRIAGE_EXCLUDE_PATTERNS:
        if fnmatch(basename, pattern) or fnmatch(path, pattern):
            return True

    return False


def triage_files(file_paths: list[str]) -> list[str]:
    """Filter file list to only index-worthy files using heuristics.

    Uses deterministic pattern matching instead of an LLM call to save
    tokens. Only files that pass triage are sent to the LLM for description.

    Args:
        file_paths: All candidate file paths (relative to project root).

    Returns:
        Filtered list of file paths that should be indexed.
    """
    if not file_paths:
        return []

    filtered = [fp for fp in file_paths if not _is_triage_excluded(fp)]
    logger.info(
        "Triage: %d/%d files selected for indexing (heuristic)",
        len(filtered),
        len(file_paths),
    )
    return filtered


def _strip_json_fences(raw: str) -> str:
    """Strip markdown code fences from a JSON response."""
    raw = raw.strip()
    if raw.startswith("```"):
        raw = "\n".join(raw.split("\n")[1:])
    if raw.endswith("```"):
        raw = "\n".join(raw.split("\n")[:-1])
    return raw.strip()


def _call_claude_cli(prompt: str, timeout: int = CLI_TIMEOUT_SECONDS) -> str:
    """Call the claude CLI to generate a description.

    Args:
        prompt: The prompt text to send to Claude.
        timeout: Timeout in seconds for the CLI call.

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
        timeout=timeout,
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


def _describe_batch(
    file_paths: list[str],
    project_root: str,
) -> dict[str, str]:
    """Describe a batch of files in a single Claude CLI call.

    Args:
        file_paths: List of file paths (relative to project_root).
        project_root: The root directory of the project.

    Returns:
        Dict mapping file paths to descriptions. Files that couldn't be read
        or described get empty strings.
    """
    # Read all file contents
    file_entries: list[tuple[str, str]] = []
    results: dict[str, str] = {}

    for fp in file_paths:
        full_path = Path(project_root) / fp
        try:
            content = full_path.read_text(errors="replace")
            file_entries.append((fp, content))
        except OSError as exc:
            logger.warning("Could not read %s: %s", fp, exc)
            results[fp] = ""

    if not file_entries:
        return results

    # Single-file batch can use the simpler per-file prompt
    if len(file_entries) == 1:
        fp, content = file_entries[0]
        prompt = generate_prompt(fp, content)
        try:
            results[fp] = _call_claude_cli(prompt)
        except (FileNotFoundError, subprocess.TimeoutExpired, subprocess.CalledProcessError) as exc:
            logger.warning("Claude CLI failed for %s: %s", fp, exc)
            results[fp] = ""
        return results

    prompt = _build_batch_prompt(file_entries)
    timeout = max(BATCH_TIMEOUT_SECONDS, len(file_entries) * 10)

    try:
        raw = _call_claude_cli(prompt, timeout=timeout)
        raw = _strip_json_fences(raw)
        parsed = json.loads(raw)

        if not isinstance(parsed, dict):
            logger.warning("Batch response was not a JSON object, falling back")
            for fp, _ in file_entries:
                results.setdefault(fp, "")
            return results

        for fp, _ in file_entries:
            desc = parsed.get(fp, "")
            results[fp] = desc if isinstance(desc, str) else ""

    except (
        FileNotFoundError,
        subprocess.TimeoutExpired,
        subprocess.CalledProcessError,
        json.JSONDecodeError,
    ) as exc:
        logger.warning("Batch CLI call failed (%s), all %d files get empty descriptions", exc, len(file_entries))
        for fp, _ in file_entries:
            results.setdefault(fp, "")

    return results


def _chunk_list(items: list, chunk_size: int) -> list[list]:
    """Split a list into chunks of at most chunk_size."""
    return [items[i : i + chunk_size] for i in range(0, len(items), chunk_size)]


def describe_files(
    file_paths: list[str],
    project_root: str,
    concurrency: int = 3,
    batch_size: int = DEFAULT_BATCH_SIZE,
    on_progress: Callable[[int, int, str], None] | None = None,
) -> dict[str, str]:
    """Batch-describe multiple files using parallel Claude CLI calls.

    Files are chunked into batches, and each batch is sent to a single Claude
    CLI session. Multiple batches run concurrently up to the concurrency limit.

    Args:
        file_paths: List of file paths to describe.
        project_root: The root directory of the project.
        concurrency: Maximum number of concurrent CLI calls.
        batch_size: Number of files per CLI session.
        on_progress: Optional callback invoked after each batch completes.
            Called with (completed_count, total_count, file_path) where
            file_path is the last file in the completed batch.

    Returns:
        Dict mapping each file path to its generated description.
        Files that fail get an empty-string description.
    """
    results: dict[str, str] = {}
    total = len(file_paths)
    completed = 0

    batches = _chunk_list(file_paths, batch_size)

    with ThreadPoolExecutor(max_workers=concurrency) as executor:
        future_to_batch = {
            executor.submit(_describe_batch, batch, project_root): batch
            for batch in batches
        }
        for future in as_completed(future_to_batch):
            batch = future_to_batch[future]
            try:
                batch_results = future.result()
                results.update(batch_results)
            except Exception as exc:  # noqa: BLE001
                logger.warning("Unexpected error describing batch: %s", exc)
                for fp in batch:
                    results.setdefault(fp, "")

            completed += len(batch)
            # Clamp to total in case of rounding
            completed = min(completed, total)
            if on_progress:
                on_progress(completed, total, batch[-1])

    return results
