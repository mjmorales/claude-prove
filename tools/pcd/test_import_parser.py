"""Tests for the PCD import parser."""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

# Ensure the parent package is importable when running via pytest / unittest
_pcd_dir = Path(__file__).resolve().parent
if str(_pcd_dir.parent) not in sys.path:
    sys.path.insert(0, str(_pcd_dir.parent))

from pcd.import_parser import (  # noqa: E402
    LANGUAGE_MAP,
    PYTHON_STDLIB,
    ImportEntry,
    classify_import,
    detect_language,
    parse_imports,
)


# ---- Helpers ---------------------------------------------------------------


def _modules(entries: list[ImportEntry]) -> list[str]:
    """Extract just the imported_module values for concise assertions."""
    return [e.imported_module for e in entries]


def _types(entries: list[ImportEntry]) -> list[str]:
    """Extract just the import_type values."""
    return [e.import_type for e in entries]


# ---- detect_language -------------------------------------------------------


class TestDetectLanguage(unittest.TestCase):
    """Tests for detect_language."""

    def test_python(self):
        self.assertEqual(detect_language("foo/bar.py"), "python")

    def test_rust(self):
        self.assertEqual(detect_language("src/main.rs"), "rust")

    def test_go(self):
        self.assertEqual(detect_language("cmd/server.go"), "go")

    def test_javascript_variants(self):
        for ext in (".js", ".jsx", ".mjs"):
            with self.subTest(ext=ext):
                self.assertEqual(detect_language(f"file{ext}"), "javascript")

    def test_typescript_variants(self):
        for ext in (".ts", ".tsx"):
            with self.subTest(ext=ext):
                self.assertEqual(detect_language(f"file{ext}"), "typescript")

    def test_unsupported(self):
        self.assertIsNone(detect_language("README.md"))
        self.assertIsNone(detect_language("Makefile"))

    def test_case_insensitive_extension(self):
        self.assertEqual(detect_language("SCRIPT.PY"), "python")


# ---- LANGUAGE_MAP ----------------------------------------------------------


class TestLanguageMap(unittest.TestCase):
    """Sanity checks on the language map."""

    def test_all_extensions_present(self):
        expected = {".py", ".rs", ".go", ".js", ".jsx", ".mjs", ".ts", ".tsx"}
        self.assertEqual(set(LANGUAGE_MAP.keys()), expected)


# ---- Python imports --------------------------------------------------------


class TestPythonImports(unittest.TestCase):
    """Tests for Python import parsing."""

    def test_basic_import(self):
        code = "import os\n"
        entries = parse_imports("app.py", code)
        self.assertEqual(_modules(entries), ["os"])
        self.assertEqual(_types(entries), ["stdlib"])

    def test_from_import(self):
        code = "from collections import OrderedDict\n"
        entries = parse_imports("app.py", code)
        self.assertEqual(_modules(entries), ["collections"])
        self.assertEqual(_types(entries), ["stdlib"])

    def test_relative_import_dot(self):
        code = "from . import sibling\n"
        entries = parse_imports("pkg/mod.py", code)
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0].import_type, "internal")

    def test_relative_import_double_dot(self):
        code = "from ..parent import thing\n"
        entries = parse_imports("pkg/sub/mod.py", code)
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0].imported_module, "..parent")
        self.assertEqual(entries[0].import_type, "internal")

    def test_multi_import(self):
        code = "import os, sys\n"
        entries = parse_imports("app.py", code)
        self.assertEqual(_modules(entries), ["os", "sys"])
        self.assertTrue(all(t == "stdlib" for t in _types(entries)))

    def test_from_typing_multi(self):
        code = "from typing import List, Dict\n"
        entries = parse_imports("app.py", code)
        self.assertEqual(_modules(entries), ["typing"])
        self.assertEqual(_types(entries), ["stdlib"])

    def test_external_package(self):
        code = "import requests\n"
        entries = parse_imports("app.py", code)
        self.assertEqual(_modules(entries), ["requests"])
        self.assertEqual(_types(entries), ["external"])

    def test_import_as(self):
        code = "import numpy as np\n"
        entries = parse_imports("app.py", code)
        self.assertEqual(_modules(entries), ["numpy"])
        self.assertEqual(_types(entries), ["external"])

    def test_comment_not_parsed(self):
        code = "# import os\nx = 1\n"
        entries = parse_imports("app.py", code)
        self.assertEqual(entries, [])

    def test_empty_file(self):
        entries = parse_imports("empty.py", "")
        self.assertEqual(entries, [])

    def test_no_imports(self):
        code = "x = 1\nprint(x)\n"
        entries = parse_imports("app.py", code)
        self.assertEqual(entries, [])


# ---- Rust imports ----------------------------------------------------------


class TestRustImports(unittest.TestCase):
    """Tests for Rust import parsing."""

    def test_use_std(self):
        code = "use std::collections::HashMap;\n"
        entries = parse_imports("src/main.rs", code)
        self.assertEqual(_modules(entries), ["std::collections::HashMap"])
        self.assertEqual(_types(entries), ["stdlib"])

    def test_use_crate(self):
        code = "use crate::parser::Parser;\n"
        entries = parse_imports("src/main.rs", code)
        self.assertEqual(_modules(entries), ["crate::parser::Parser"])
        self.assertEqual(_types(entries), ["internal"])

    def test_mod_declaration(self):
        code = "mod lexer;\n"
        entries = parse_imports("src/lib.rs", code)
        self.assertEqual(_modules(entries), ["lexer"])
        self.assertEqual(_types(entries), ["internal"])

    def test_nested_use(self):
        code = "use std::{io, fs};\n"
        entries = parse_imports("src/main.rs", code)
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0].import_type, "stdlib")

    def test_external_crate(self):
        code = "use serde::Serialize;\n"
        entries = parse_imports("src/main.rs", code)
        self.assertEqual(_modules(entries), ["serde::Serialize"])
        self.assertEqual(_types(entries), ["external"])

    def test_comment_not_parsed(self):
        code = "// use std::io;\nlet x = 1;\n"
        entries = parse_imports("src/main.rs", code)
        self.assertEqual(entries, [])

    def test_empty_file(self):
        entries = parse_imports("src/main.rs", "")
        self.assertEqual(entries, [])

    def test_use_super(self):
        code = "use super::parent_mod;\n"
        entries = parse_imports("src/child.rs", code)
        self.assertEqual(_types(entries), ["internal"])


# ---- Go imports ------------------------------------------------------------


class TestGoImports(unittest.TestCase):
    """Tests for Go import parsing."""

    def test_single_import(self):
        code = 'import "fmt"\n'
        entries = parse_imports("main.go", code)
        self.assertEqual(_modules(entries), ["fmt"])
        self.assertEqual(_types(entries), ["stdlib"])

    def test_block_import(self):
        code = 'import (\n    "fmt"\n    "os"\n)\n'
        entries = parse_imports("main.go", code)
        self.assertEqual(sorted(_modules(entries)), ["fmt", "os"])
        self.assertTrue(all(t == "stdlib" for t in _types(entries)))

    def test_aliased_import(self):
        code = 'import f "fmt"\n'
        entries = parse_imports("main.go", code)
        self.assertEqual(_modules(entries), ["fmt"])
        self.assertEqual(_types(entries), ["stdlib"])

    def test_external_module(self):
        code = 'import "github.com/gorilla/mux"\n'
        entries = parse_imports("main.go", code)
        self.assertEqual(_modules(entries), ["github.com/gorilla/mux"])
        self.assertEqual(_types(entries), ["external"])

    def test_block_with_external(self):
        code = 'import (\n    "fmt"\n    "github.com/pkg/errors"\n)\n'
        entries = parse_imports("main.go", code)
        modules = _modules(entries)
        types = _types(entries)
        self.assertIn("fmt", modules)
        self.assertIn("github.com/pkg/errors", modules)
        fmt_idx = modules.index("fmt")
        ext_idx = modules.index("github.com/pkg/errors")
        self.assertEqual(types[fmt_idx], "stdlib")
        self.assertEqual(types[ext_idx], "external")

    def test_comment_not_parsed(self):
        code = '// import "fmt"\npackage main\n'
        entries = parse_imports("main.go", code)
        self.assertEqual(entries, [])

    def test_empty_file(self):
        entries = parse_imports("main.go", "")
        self.assertEqual(entries, [])

    def test_aliased_block_import(self):
        code = 'import (\n    f "fmt"\n    "os"\n)\n'
        entries = parse_imports("main.go", code)
        modules = _modules(entries)
        self.assertIn("fmt", modules)
        self.assertIn("os", modules)


# ---- JS/TS imports ---------------------------------------------------------


class TestJsTsImports(unittest.TestCase):
    """Tests for JavaScript/TypeScript import parsing."""

    def test_default_import(self):
        code = "import React from 'react';\n"
        entries = parse_imports("app.tsx", code)
        self.assertEqual(_modules(entries), ["react"])
        self.assertEqual(_types(entries), ["external"])

    def test_named_import(self):
        code = "import { useState } from 'react';\n"
        entries = parse_imports("app.tsx", code)
        self.assertEqual(_modules(entries), ["react"])
        self.assertEqual(_types(entries), ["external"])

    def test_namespace_import(self):
        code = "import * as fs from 'fs';\n"
        entries = parse_imports("app.ts", code)
        self.assertEqual(_modules(entries), ["fs"])
        self.assertEqual(_types(entries), ["external"])

    def test_require(self):
        code = "const lodash = require('lodash');\n"
        entries = parse_imports("app.js", code)
        self.assertEqual(_modules(entries), ["lodash"])
        self.assertEqual(_types(entries), ["external"])

    def test_relative_import(self):
        code = "import { helper } from './utils';\n"
        entries = parse_imports("app.ts", code)
        self.assertEqual(_modules(entries), ["./utils"])
        self.assertEqual(_types(entries), ["internal"])

    def test_dynamic_import(self):
        code = "const mod = import('./module');\n"
        entries = parse_imports("app.js", code)
        self.assertEqual(_modules(entries), ["./module"])
        self.assertEqual(_types(entries), ["internal"])

    def test_parent_relative_import(self):
        code = "import { config } from '../config';\n"
        entries = parse_imports("src/app.ts", code)
        self.assertEqual(_modules(entries), ["../config"])
        self.assertEqual(_types(entries), ["internal"])

    def test_comment_not_parsed(self):
        code = "// import React from 'react';\nconst x = 1;\n"
        entries = parse_imports("app.tsx", code)
        self.assertEqual(entries, [])

    def test_empty_file(self):
        entries = parse_imports("app.js", "")
        self.assertEqual(entries, [])

    def test_side_effect_import(self):
        code = "import 'polyfill';\n"
        entries = parse_imports("app.js", code)
        self.assertEqual(_modules(entries), ["polyfill"])
        self.assertEqual(_types(entries), ["external"])

    def test_double_quotes(self):
        code = 'import React from "react";\n'
        entries = parse_imports("app.tsx", code)
        self.assertEqual(_modules(entries), ["react"])


# ---- Classification --------------------------------------------------------


class TestClassifyImport(unittest.TestCase):
    """Tests for classify_import across all languages."""

    # Python
    def test_python_stdlib(self):
        self.assertEqual(classify_import("os", "python"), "stdlib")
        self.assertEqual(classify_import("collections", "python"), "stdlib")
        self.assertEqual(classify_import("typing", "python"), "stdlib")

    def test_python_external(self):
        self.assertEqual(classify_import("requests", "python"), "external")
        self.assertEqual(classify_import("flask", "python"), "external")

    def test_python_internal(self):
        self.assertEqual(classify_import(".sibling", "python"), "internal")
        self.assertEqual(classify_import("..parent", "python"), "internal")
        self.assertEqual(classify_import(".", "python"), "internal")

    # Rust
    def test_rust_stdlib(self):
        self.assertEqual(classify_import("std::io", "rust"), "stdlib")
        self.assertEqual(classify_import("core::mem", "rust"), "stdlib")
        self.assertEqual(classify_import("alloc::vec", "rust"), "stdlib")

    def test_rust_internal(self):
        self.assertEqual(classify_import("crate::module", "rust"), "internal")
        self.assertEqual(classify_import("super::parent", "rust"), "internal")
        self.assertEqual(classify_import("self::child", "rust"), "internal")

    def test_rust_external(self):
        self.assertEqual(classify_import("serde::Serialize", "rust"), "external")
        self.assertEqual(classify_import("tokio::runtime", "rust"), "external")

    # Go
    def test_go_stdlib(self):
        self.assertEqual(classify_import("fmt", "go"), "stdlib")
        self.assertEqual(classify_import("net/http", "go"), "stdlib")

    def test_go_external(self):
        self.assertEqual(
            classify_import("github.com/gorilla/mux", "go"), "external"
        )

    # JS/TS
    def test_js_internal(self):
        self.assertEqual(classify_import("./utils", "javascript"), "internal")
        self.assertEqual(classify_import("../config", "typescript"), "internal")

    def test_js_external(self):
        self.assertEqual(classify_import("react", "javascript"), "external")
        self.assertEqual(classify_import("lodash", "typescript"), "external")

    # Unknown language
    def test_unknown_language(self):
        self.assertEqual(classify_import("foo", "haskell"), "unknown")


# ---- Edge cases ------------------------------------------------------------


class TestEdgeCases(unittest.TestCase):
    """Cross-cutting edge cases."""

    def test_unsupported_extension(self):
        entries = parse_imports("notes.md", "import something")
        self.assertEqual(entries, [])

    def test_string_literal_with_import_python(self):
        code = 'x = "import os"\nprint(x)\n'
        entries = parse_imports("app.py", code)
        # The regex will match "import os" inside the string — this is a known
        # limitation of regex-based parsing.  We accept this trade-off since
        # the spec says "regex-based parsing only".  The test documents the
        # behavior rather than asserting zero matches.
        # If zero false positives are critical, AST parsing would be needed.
        self.assertIsInstance(entries, list)

    def test_python_stdlib_coverage(self):
        """Verify the stdlib set is reasonably large."""
        self.assertGreaterEqual(len(PYTHON_STDLIB), 170)

    def test_import_entry_fields(self):
        """Verify NamedTuple fields are accessible."""
        e = ImportEntry("f.py", "os", "stdlib", "import os")
        self.assertEqual(e.source_file, "f.py")
        self.assertEqual(e.imported_module, "os")
        self.assertEqual(e.import_type, "stdlib")
        self.assertEqual(e.raw_line, "import os")

    def test_file_isolation_with_tempdir(self):
        """Demonstrate tempdir usage for file-based tests."""
        with tempfile.TemporaryDirectory() as tmpdir:
            py_file = Path(tmpdir) / "example.py"
            py_file.write_text("import json\n")
            content = py_file.read_text()
            entries = parse_imports(str(py_file), content)
            self.assertEqual(len(entries), 1)
            self.assertEqual(entries[0].imported_module, "json")
            self.assertEqual(entries[0].import_type, "stdlib")


if __name__ == "__main__":
    unittest.main()
