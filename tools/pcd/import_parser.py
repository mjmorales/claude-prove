"""Language-agnostic import extraction for Python, Rust, Go, JS/TS.

Regex-based parsing only — no AST, no external dependencies.
"""

from __future__ import annotations

import os
import re
from typing import NamedTuple

# ---------------------------------------------------------------------------
# Types
# ---------------------------------------------------------------------------


class ImportEntry(NamedTuple):
    """A single import extracted from a source file."""

    source_file: str
    imported_module: str
    import_type: str  # "stdlib" | "external" | "internal" | "unknown"
    raw_line: str


# ---------------------------------------------------------------------------
# Language detection
# ---------------------------------------------------------------------------

LANGUAGE_MAP: dict[str, str] = {
    ".py": "python",
    ".rs": "rust",
    ".go": "go",
    ".js": "javascript",
    ".jsx": "javascript",
    ".mjs": "javascript",
    ".ts": "typescript",
    ".tsx": "typescript",
}


def detect_language(file_path: str) -> str | None:
    """Return the language name for *file_path*, or ``None`` if unsupported."""
    ext = os.path.splitext(file_path)[1].lower()
    return LANGUAGE_MAP.get(ext)


# ---------------------------------------------------------------------------
# Python stdlib set (CPython 3.10+)
# ---------------------------------------------------------------------------

PYTHON_STDLIB: frozenset[str] = frozenset(
    {
        "__future__",
        "_thread",
        "abc",
        "aifc",
        "argparse",
        "array",
        "ast",
        "asynchat",
        "asyncio",
        "asyncore",
        "atexit",
        "audioop",
        "base64",
        "bdb",
        "binascii",
        "binhex",
        "bisect",
        "builtins",
        "bz2",
        "calendar",
        "cgi",
        "cgitb",
        "chunk",
        "cmath",
        "cmd",
        "code",
        "codecs",
        "codeop",
        "collections",
        "colorsys",
        "compileall",
        "concurrent",
        "configparser",
        "contextlib",
        "contextvars",
        "copy",
        "copyreg",
        "cProfile",
        "crypt",
        "csv",
        "ctypes",
        "curses",
        "dataclasses",
        "datetime",
        "dbm",
        "decimal",
        "difflib",
        "dis",
        "distutils",
        "doctest",
        "email",
        "encodings",
        "enum",
        "errno",
        "faulthandler",
        "fcntl",
        "filecmp",
        "fileinput",
        "fnmatch",
        "fractions",
        "ftplib",
        "functools",
        "gc",
        "getopt",
        "getpass",
        "gettext",
        "glob",
        "graphlib",
        "grp",
        "gzip",
        "hashlib",
        "heapq",
        "hmac",
        "html",
        "http",
        "idlelib",
        "imaplib",
        "imghdr",
        "imp",
        "importlib",
        "inspect",
        "io",
        "ipaddress",
        "itertools",
        "json",
        "keyword",
        "lib2to3",
        "linecache",
        "locale",
        "logging",
        "lzma",
        "mailbox",
        "mailcap",
        "marshal",
        "math",
        "mimetypes",
        "mmap",
        "modulefinder",
        "multiprocessing",
        "netrc",
        "nis",
        "nntplib",
        "numbers",
        "operator",
        "optparse",
        "os",
        "ossaudiodev",
        "pathlib",
        "pdb",
        "pickle",
        "pickletools",
        "pipes",
        "pkgutil",
        "platform",
        "plistlib",
        "poplib",
        "posix",
        "posixpath",
        "pprint",
        "profile",
        "pstats",
        "pty",
        "pwd",
        "py_compile",
        "pyclbr",
        "pydoc",
        "queue",
        "quopri",
        "random",
        "re",
        "readline",
        "reprlib",
        "resource",
        "rlcompleter",
        "runpy",
        "sched",
        "secrets",
        "select",
        "selectors",
        "shelve",
        "shlex",
        "shutil",
        "signal",
        "site",
        "smtpd",
        "smtplib",
        "sndhdr",
        "socket",
        "socketserver",
        "spwd",
        "sqlite3",
        "ssl",
        "stat",
        "statistics",
        "string",
        "stringprep",
        "struct",
        "subprocess",
        "sunau",
        "symtable",
        "sys",
        "sysconfig",
        "syslog",
        "tabnanny",
        "tarfile",
        "telnetlib",
        "tempfile",
        "termios",
        "test",
        "textwrap",
        "threading",
        "time",
        "timeit",
        "tkinter",
        "token",
        "tokenize",
        "tomllib",
        "trace",
        "traceback",
        "tracemalloc",
        "tty",
        "turtle",
        "turtledemo",
        "types",
        "typing",
        "unicodedata",
        "unittest",
        "urllib",
        "uu",
        "uuid",
        "venv",
        "warnings",
        "wave",
        "weakref",
        "webbrowser",
        "winreg",
        "winsound",
        "wsgiref",
        "xdrlib",
        "xml",
        "xmlrpc",
        "zipapp",
        "zipfile",
        "zipimport",
        "zlib",
        "zoneinfo",
    }
)


# ---------------------------------------------------------------------------
# Classification
# ---------------------------------------------------------------------------


def classify_import(
    module: str, language: str, project_files: set[str] | None = None
) -> str:
    """Classify *module* as ``stdlib``, ``external``, ``internal``, or ``unknown``.

    Parameters
    ----------
    module:
        The top-level module or import path string.
    language:
        One of the language names from :data:`LANGUAGE_MAP` values.
    project_files:
        Optional set of known project-relative file paths.  Used by some
        language classifiers to decide whether a module is internal.
    """
    if language == "python":
        return _classify_python(module)
    if language == "rust":
        return _classify_rust(module)
    if language == "go":
        return _classify_go(module)
    if language in ("javascript", "typescript"):
        return _classify_js_ts(module)
    return "unknown"


def _classify_python(module: str) -> str:
    if module.startswith("."):
        return "internal"
    top = module.split(".")[0]
    if top in PYTHON_STDLIB:
        return "stdlib"
    return "external"


def _classify_rust(module: str) -> str:
    if module.startswith(("std::", "core::", "alloc::")):
        return "stdlib"
    if module in ("std", "core", "alloc"):
        return "stdlib"
    if module.startswith(("crate::", "super::", "self::")):
        return "internal"
    if module in ("crate", "super", "self"):
        return "internal"
    return "external"


def _classify_go(module: str) -> str:
    # Go stdlib packages contain no dots in the path.
    if "." not in module:
        return "stdlib"
    return "external"


def _classify_js_ts(module: str) -> str:
    if module.startswith("./") or module.startswith("../"):
        return "internal"
    return "external"


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


def parse_imports(file_path: str, content: str) -> list[ImportEntry]:
    """Extract all imports from *content* for the file at *file_path*.

    Dispatches to a language-specific parser based on file extension.
    Returns an empty list for unsupported languages.
    """
    language = detect_language(file_path)
    if language is None:
        return []
    if language == "python":
        return _parse_python_imports(file_path, content)
    if language == "rust":
        return _parse_rust_imports(file_path, content)
    if language == "go":
        return _parse_go_imports(file_path, content)
    if language in ("javascript", "typescript"):
        return _parse_js_ts_imports(file_path, content)
    return []


# ---------------------------------------------------------------------------
# Python parser
# ---------------------------------------------------------------------------

# Matches: import foo, import foo as bar, import foo, bar
_PY_IMPORT_RE = re.compile(
    r"^import\s+(.+)$", re.MULTILINE
)
# Matches: from foo import bar, from . import bar, from ..foo import bar
_PY_FROM_IMPORT_RE = re.compile(
    r"^from\s+(\.{0,3}\w[\w.]*|\.+)\s+import\s+(.+)$", re.MULTILINE
)


def _parse_python_imports(file_path: str, content: str) -> list[ImportEntry]:
    entries: list[ImportEntry] = []
    # Strip comments to avoid false positives
    cleaned = _strip_python_comments(content)

    for m in _PY_FROM_IMPORT_RE.finditer(cleaned):
        module = m.group(1).strip()
        raw = m.group(0).strip()
        import_type = _classify_python(module)
        entries.append(ImportEntry(file_path, module, import_type, raw))

    for m in _PY_IMPORT_RE.finditer(cleaned):
        raw = m.group(0).strip()
        modules_str = m.group(1).strip()
        # Split on commas for multi-import: import os, sys
        for part in modules_str.split(","):
            part = part.strip()
            # Handle "import foo as bar" -> module is "foo"
            mod = part.split(" as ")[0].strip() if " as " in part else part
            if not mod:
                continue
            import_type = _classify_python(mod)
            entries.append(ImportEntry(file_path, mod, import_type, raw))

    return entries


def _strip_python_comments(content: str) -> str:
    """Remove ``#``-comments from each line (simplistic — may strip ``#`` inside strings)."""
    lines: list[str] = []
    for line in content.splitlines():
        idx = line.find("#")
        if idx >= 0:
            lines.append(line[:idx])
        else:
            lines.append(line)
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Rust parser
# ---------------------------------------------------------------------------

# Matches: use std::collections::HashMap;
_RS_USE_RE = re.compile(
    r"^\s*use\s+([\w:]+(?:::\{[^}]+\})?)\s*;", re.MULTILINE
)
# Matches: mod submodule;
_RS_MOD_RE = re.compile(r"^\s*mod\s+(\w+)\s*;", re.MULTILINE)


def _parse_rust_imports(file_path: str, content: str) -> list[ImportEntry]:
    entries: list[ImportEntry] = []
    cleaned = _strip_rust_comments(content)

    for m in _RS_USE_RE.finditer(cleaned):
        path = m.group(1).strip()
        raw = m.group(0).strip()
        # For classification, use the top-level crate/prefix
        import_type = _classify_rust(path)
        entries.append(ImportEntry(file_path, path, import_type, raw))

    for m in _RS_MOD_RE.finditer(cleaned):
        mod_name = m.group(1).strip()
        raw = m.group(0).strip()
        entries.append(ImportEntry(file_path, mod_name, "internal", raw))

    return entries


def _strip_rust_comments(content: str) -> str:
    """Remove ``//``-comments from each line (simplistic)."""
    lines: list[str] = []
    for line in content.splitlines():
        stripped = line.lstrip()
        if stripped.startswith("//"):
            lines.append("")
        else:
            lines.append(line)
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Go parser
# ---------------------------------------------------------------------------

# Single import: import "fmt"  or  import alias "fmt"
_GO_SINGLE_IMPORT_RE = re.compile(
    r'^\s*import\s+(?:(\w+)\s+)?"([^"]+)"', re.MULTILINE
)
# Block import: import ( ... )
_GO_BLOCK_IMPORT_RE = re.compile(
    r"^\s*import\s*\((.*?)\)", re.MULTILINE | re.DOTALL
)
# Individual line inside a block: optional alias + quoted path
_GO_BLOCK_LINE_RE = re.compile(r'(?:(\w+)\s+)?"([^"]+)"')


def _parse_go_imports(file_path: str, content: str) -> list[ImportEntry]:
    entries: list[ImportEntry] = []
    cleaned = _strip_go_comments(content)

    # Block imports first (so we can skip them when matching single imports)
    block_spans: list[tuple[int, int]] = []
    for m in _GO_BLOCK_IMPORT_RE.finditer(cleaned):
        block_spans.append((m.start(), m.end()))
        block_body = m.group(1)
        raw_block = m.group(0).strip()
        for line_m in _GO_BLOCK_LINE_RE.finditer(block_body):
            pkg = line_m.group(2)
            import_type = _classify_go(pkg)
            entries.append(ImportEntry(file_path, pkg, import_type, raw_block))

    for m in _GO_SINGLE_IMPORT_RE.finditer(cleaned):
        # Skip if this match falls inside a block import
        if any(start <= m.start() < end for start, end in block_spans):
            continue
        pkg = m.group(2)
        raw = m.group(0).strip()
        import_type = _classify_go(pkg)
        entries.append(ImportEntry(file_path, pkg, import_type, raw))

    return entries


def _strip_go_comments(content: str) -> str:
    """Remove ``//``-comments from each line (simplistic)."""
    lines: list[str] = []
    for line in content.splitlines():
        stripped = line.lstrip()
        if stripped.startswith("//"):
            lines.append("")
        else:
            lines.append(line)
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# JS / TS parser
# ---------------------------------------------------------------------------

# import foo from 'bar'  |  import { foo } from 'bar'  |  import * as foo from 'bar'
_JS_IMPORT_FROM_RE = re.compile(
    r"""^\s*import\s+.*?\s+from\s+['"]([^'"]+)['"]""", re.MULTILINE
)
# import 'bar'  (side-effect import)
_JS_IMPORT_BARE_RE = re.compile(
    r"""^\s*import\s+['"]([^'"]+)['"]""", re.MULTILINE
)
# const foo = require('bar')  |  require('bar')
_JS_REQUIRE_RE = re.compile(
    r"""require\(\s*['"]([^'"]+)['"]\s*\)"""
)
# dynamic import('./bar')
_JS_DYNAMIC_IMPORT_RE = re.compile(
    r"""import\(\s*['"]([^'"]+)['"]\s*\)"""
)


def _parse_js_ts_imports(file_path: str, content: str) -> list[ImportEntry]:
    entries: list[ImportEntry] = []
    cleaned = _strip_js_comments(content)
    seen: set[tuple[str, str]] = set()  # (module, raw_line) dedup

    def _add(module: str, raw: str) -> None:
        key = (module, raw)
        if key in seen:
            return
        seen.add(key)
        import_type = _classify_js_ts(module)
        entries.append(ImportEntry(file_path, module, import_type, raw))

    for m in _JS_IMPORT_FROM_RE.finditer(cleaned):
        _add(m.group(1), m.group(0).strip())

    for m in _JS_IMPORT_BARE_RE.finditer(cleaned):
        module = m.group(1)
        raw = m.group(0).strip()
        # Avoid double-matching lines already caught by _JS_IMPORT_FROM_RE
        if (module, raw) not in seen:
            # Check it's not actually a "from" import matched partially
            full_line = _get_full_line(cleaned, m.start())
            if " from " not in full_line:
                _add(module, raw)

    for m in _JS_REQUIRE_RE.finditer(cleaned):
        _add(m.group(1), m.group(0).strip())

    for m in _JS_DYNAMIC_IMPORT_RE.finditer(cleaned):
        _add(m.group(1), m.group(0).strip())

    return entries


def _get_full_line(content: str, pos: int) -> str:
    """Return the full line containing position *pos*."""
    start = content.rfind("\n", 0, pos) + 1
    end = content.find("\n", pos)
    if end == -1:
        end = len(content)
    return content[start:end]


def _strip_js_comments(content: str) -> str:
    """Remove ``//``-comments from each line (simplistic)."""
    lines: list[str] = []
    for line in content.splitlines():
        stripped = line.lstrip()
        if stripped.startswith("//"):
            lines.append("")
        else:
            lines.append(line)
    return "\n".join(lines)
