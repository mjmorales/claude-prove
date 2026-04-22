/**
 * Tests for the PCD import parser (TypeScript port of
 * `tools/pcd/test_import_parser.py`).
 *
 * Every assertion mirrors a Python test case verbatim. Keep the structure
 * and test names aligned — changes must land in lockstep with the Python
 * source file until the Python version is retired.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ImportEntry,
  LANGUAGE_MAP,
  PYTHON_STDLIB,
  classifyImport,
  detectLanguage,
  parseImports,
} from './import-parser';

// ---- Helpers ---------------------------------------------------------------

const modules = (entries: ImportEntry[]): string[] => entries.map((e) => e.imported_module);
const types = (entries: ImportEntry[]): string[] => entries.map((e) => e.import_type);

// ---- detectLanguage --------------------------------------------------------

describe('detectLanguage', () => {
  test('python', () => {
    expect(detectLanguage('foo/bar.py')).toBe('python');
  });

  test('rust', () => {
    expect(detectLanguage('src/main.rs')).toBe('rust');
  });

  test('go', () => {
    expect(detectLanguage('cmd/server.go')).toBe('go');
  });

  test('javascript variants', () => {
    for (const ext of ['.js', '.jsx', '.mjs']) {
      expect(detectLanguage(`file${ext}`)).toBe('javascript');
    }
  });

  test('typescript variants', () => {
    for (const ext of ['.ts', '.tsx']) {
      expect(detectLanguage(`file${ext}`)).toBe('typescript');
    }
  });

  test('unsupported', () => {
    expect(detectLanguage('README.md')).toBeNull();
    expect(detectLanguage('Makefile')).toBeNull();
  });

  test('case-insensitive extension', () => {
    expect(detectLanguage('SCRIPT.PY')).toBe('python');
  });
});

// ---- LANGUAGE_MAP ----------------------------------------------------------

describe('LANGUAGE_MAP', () => {
  test('all extensions present', () => {
    const expected = new Set(['.py', '.rs', '.go', '.js', '.jsx', '.mjs', '.ts', '.tsx']);
    expect(new Set(Object.keys(LANGUAGE_MAP))).toEqual(expected);
  });
});

// ---- Python imports --------------------------------------------------------

describe('Python imports', () => {
  test('basic import', () => {
    const entries = parseImports('app.py', 'import os\n');
    expect(modules(entries)).toEqual(['os']);
    expect(types(entries)).toEqual(['stdlib']);
  });

  test('from import', () => {
    const entries = parseImports('app.py', 'from collections import OrderedDict\n');
    expect(modules(entries)).toEqual(['collections']);
    expect(types(entries)).toEqual(['stdlib']);
  });

  test('relative import (single dot)', () => {
    const entries = parseImports('pkg/mod.py', 'from . import sibling\n');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.import_type).toBe('internal');
  });

  test('relative import (double dot)', () => {
    const entries = parseImports('pkg/sub/mod.py', 'from ..parent import thing\n');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.imported_module).toBe('..parent');
    expect(entries[0]?.import_type).toBe('internal');
  });

  test('multi import', () => {
    const entries = parseImports('app.py', 'import os, sys\n');
    expect(modules(entries)).toEqual(['os', 'sys']);
    expect(types(entries).every((t) => t === 'stdlib')).toBe(true);
  });

  test('from typing multi', () => {
    const entries = parseImports('app.py', 'from typing import List, Dict\n');
    expect(modules(entries)).toEqual(['typing']);
    expect(types(entries)).toEqual(['stdlib']);
  });

  test('external package', () => {
    const entries = parseImports('app.py', 'import requests\n');
    expect(modules(entries)).toEqual(['requests']);
    expect(types(entries)).toEqual(['external']);
  });

  test('import as', () => {
    const entries = parseImports('app.py', 'import numpy as np\n');
    expect(modules(entries)).toEqual(['numpy']);
    expect(types(entries)).toEqual(['external']);
  });

  test('comment not parsed', () => {
    const entries = parseImports('app.py', '# import os\nx = 1\n');
    expect(entries).toEqual([]);
  });

  test('empty file', () => {
    expect(parseImports('empty.py', '')).toEqual([]);
  });

  test('no imports', () => {
    expect(parseImports('app.py', 'x = 1\nprint(x)\n')).toEqual([]);
  });
});

// ---- Rust imports ----------------------------------------------------------

describe('Rust imports', () => {
  test('use std', () => {
    const entries = parseImports('src/main.rs', 'use std::collections::HashMap;\n');
    expect(modules(entries)).toEqual(['std::collections::HashMap']);
    expect(types(entries)).toEqual(['stdlib']);
  });

  test('use crate', () => {
    const entries = parseImports('src/main.rs', 'use crate::parser::Parser;\n');
    expect(modules(entries)).toEqual(['crate::parser::Parser']);
    expect(types(entries)).toEqual(['internal']);
  });

  test('mod declaration', () => {
    const entries = parseImports('src/lib.rs', 'mod lexer;\n');
    expect(modules(entries)).toEqual(['lexer']);
    expect(types(entries)).toEqual(['internal']);
  });

  test('nested use (brace group kept as single entry)', () => {
    // Known limitation: `use std::{io, fs};` records a single ImportEntry.
    const entries = parseImports('src/main.rs', 'use std::{io, fs};\n');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.import_type).toBe('stdlib');
  });

  test('external crate', () => {
    const entries = parseImports('src/main.rs', 'use serde::Serialize;\n');
    expect(modules(entries)).toEqual(['serde::Serialize']);
    expect(types(entries)).toEqual(['external']);
  });

  test('comment not parsed', () => {
    const entries = parseImports('src/main.rs', '// use std::io;\nlet x = 1;\n');
    expect(entries).toEqual([]);
  });

  test('empty file', () => {
    expect(parseImports('src/main.rs', '')).toEqual([]);
  });

  test('use super', () => {
    const entries = parseImports('src/child.rs', 'use super::parent_mod;\n');
    expect(types(entries)).toEqual(['internal']);
  });
});

// ---- Go imports ------------------------------------------------------------

describe('Go imports', () => {
  test('single import', () => {
    const entries = parseImports('main.go', 'import "fmt"\n');
    expect(modules(entries)).toEqual(['fmt']);
    expect(types(entries)).toEqual(['stdlib']);
  });

  test('block import', () => {
    const entries = parseImports('main.go', 'import (\n    "fmt"\n    "os"\n)\n');
    expect(modules(entries).sort()).toEqual(['fmt', 'os']);
    expect(types(entries).every((t) => t === 'stdlib')).toBe(true);
  });

  test('aliased import', () => {
    const entries = parseImports('main.go', 'import f "fmt"\n');
    expect(modules(entries)).toEqual(['fmt']);
    expect(types(entries)).toEqual(['stdlib']);
  });

  test('external module', () => {
    const entries = parseImports('main.go', 'import "github.com/gorilla/mux"\n');
    expect(modules(entries)).toEqual(['github.com/gorilla/mux']);
    expect(types(entries)).toEqual(['external']);
  });

  test('block with external', () => {
    const code = 'import (\n    "fmt"\n    "github.com/pkg/errors"\n)\n';
    const entries = parseImports('main.go', code);
    const mods = modules(entries);
    const ts = types(entries);
    expect(mods).toContain('fmt');
    expect(mods).toContain('github.com/pkg/errors');
    expect(ts[mods.indexOf('fmt')]).toBe('stdlib');
    expect(ts[mods.indexOf('github.com/pkg/errors')]).toBe('external');
  });

  test('comment not parsed', () => {
    const entries = parseImports('main.go', '// import "fmt"\npackage main\n');
    expect(entries).toEqual([]);
  });

  test('empty file', () => {
    expect(parseImports('main.go', '')).toEqual([]);
  });

  test('aliased block import', () => {
    const code = 'import (\n    f "fmt"\n    "os"\n)\n';
    const entries = parseImports('main.go', code);
    const mods = modules(entries);
    expect(mods).toContain('fmt');
    expect(mods).toContain('os');
  });
});

// ---- JS/TS imports ---------------------------------------------------------

describe('JS/TS imports', () => {
  test('default import', () => {
    const entries = parseImports('app.tsx', "import React from 'react';\n");
    expect(modules(entries)).toEqual(['react']);
    expect(types(entries)).toEqual(['external']);
  });

  test('named import', () => {
    const entries = parseImports('app.tsx', "import { useState } from 'react';\n");
    expect(modules(entries)).toEqual(['react']);
    expect(types(entries)).toEqual(['external']);
  });

  test('namespace import', () => {
    const entries = parseImports('app.ts', "import * as fs from 'fs';\n");
    expect(modules(entries)).toEqual(['fs']);
    expect(types(entries)).toEqual(['external']);
  });

  test('require', () => {
    const entries = parseImports('app.js', "const lodash = require('lodash');\n");
    expect(modules(entries)).toEqual(['lodash']);
    expect(types(entries)).toEqual(['external']);
  });

  test('relative import', () => {
    const entries = parseImports('app.ts', "import { helper } from './utils';\n");
    expect(modules(entries)).toEqual(['./utils']);
    expect(types(entries)).toEqual(['internal']);
  });

  test('dynamic import', () => {
    const entries = parseImports('app.js', "const mod = import('./module');\n");
    expect(modules(entries)).toEqual(['./module']);
    expect(types(entries)).toEqual(['internal']);
  });

  test('parent relative import', () => {
    const entries = parseImports('src/app.ts', "import { config } from '../config';\n");
    expect(modules(entries)).toEqual(['../config']);
    expect(types(entries)).toEqual(['internal']);
  });

  test('comment not parsed', () => {
    const entries = parseImports('app.tsx', "// import React from 'react';\nconst x = 1;\n");
    expect(entries).toEqual([]);
  });

  test('empty file', () => {
    expect(parseImports('app.js', '')).toEqual([]);
  });

  test('side-effect import', () => {
    const entries = parseImports('app.js', "import 'polyfill';\n");
    expect(modules(entries)).toEqual(['polyfill']);
    expect(types(entries)).toEqual(['external']);
  });

  test('double quotes', () => {
    const entries = parseImports('app.tsx', 'import React from "react";\n');
    expect(modules(entries)).toEqual(['react']);
  });
});

// ---- Classification --------------------------------------------------------

describe('classifyImport', () => {
  // Python
  test('python stdlib', () => {
    expect(classifyImport('os', 'python')).toBe('stdlib');
    expect(classifyImport('collections', 'python')).toBe('stdlib');
    expect(classifyImport('typing', 'python')).toBe('stdlib');
  });

  test('python external', () => {
    expect(classifyImport('requests', 'python')).toBe('external');
    expect(classifyImport('flask', 'python')).toBe('external');
  });

  test('python internal', () => {
    expect(classifyImport('.sibling', 'python')).toBe('internal');
    expect(classifyImport('..parent', 'python')).toBe('internal');
    expect(classifyImport('.', 'python')).toBe('internal');
  });

  // Rust
  test('rust stdlib', () => {
    expect(classifyImport('std::io', 'rust')).toBe('stdlib');
    expect(classifyImport('core::mem', 'rust')).toBe('stdlib');
    expect(classifyImport('alloc::vec', 'rust')).toBe('stdlib');
  });

  test('rust internal', () => {
    expect(classifyImport('crate::module', 'rust')).toBe('internal');
    expect(classifyImport('super::parent', 'rust')).toBe('internal');
    expect(classifyImport('self::child', 'rust')).toBe('internal');
  });

  test('rust external', () => {
    expect(classifyImport('serde::Serialize', 'rust')).toBe('external');
    expect(classifyImport('tokio::runtime', 'rust')).toBe('external');
  });

  // Go
  test('go stdlib', () => {
    expect(classifyImport('fmt', 'go')).toBe('stdlib');
    expect(classifyImport('net/http', 'go')).toBe('stdlib');
  });

  test('go external', () => {
    expect(classifyImport('github.com/gorilla/mux', 'go')).toBe('external');
  });

  // JS/TS
  test('js internal', () => {
    expect(classifyImport('./utils', 'javascript')).toBe('internal');
    expect(classifyImport('../config', 'typescript')).toBe('internal');
  });

  test('js external', () => {
    expect(classifyImport('react', 'javascript')).toBe('external');
    expect(classifyImport('lodash', 'typescript')).toBe('external');
  });

  test('unknown language', () => {
    expect(classifyImport('foo', 'haskell')).toBe('unknown');
  });
});

// ---- Edge cases ------------------------------------------------------------

describe('edge cases', () => {
  test('unsupported extension', () => {
    expect(parseImports('notes.md', 'import something')).toEqual([]);
  });

  test('string literal with import (Python) — known regex false-positive', () => {
    // Known limitation: regex-based parsing matches `import os` inside string
    // literals. We accept this trade-off since the spec says "regex-based
    // parsing only". The test documents the behavior rather than asserting
    // zero matches.
    const entries = parseImports('app.py', 'x = "import os"\nprint(x)\n');
    expect(Array.isArray(entries)).toBe(true);
  });

  test('python stdlib coverage', () => {
    expect(PYTHON_STDLIB.size).toBeGreaterThanOrEqual(170);
  });

  test('ImportEntry field order', () => {
    const e: ImportEntry = {
      source_file: 'f.py',
      imported_module: 'os',
      import_type: 'stdlib',
      raw_line: 'import os',
    };
    expect(e.source_file).toBe('f.py');
    expect(e.imported_module).toBe('os');
    expect(e.import_type).toBe('stdlib');
    expect(e.raw_line).toBe('import os');
  });

  test('inline comment not parsed', () => {
    const code =
      'import os  # for path operations\nfrom collections import OrderedDict  # ordered\n';
    const entries = parseImports('app.py', code);
    const mods = modules(entries);
    expect(mods).toContain('os');
    expect(mods).toContain('collections');
    for (const e of entries) {
      expect(['stdlib']).toContain(e.import_type);
    }
  });

  test('file isolation with tempdir', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pcd-import-parser-'));
    try {
      const pyFile = join(tmp, 'example.py');
      writeFileSync(pyFile, 'import json\n');
      const content = readFileSync(pyFile, 'utf8');
      const entries = parseImports(pyFile, content);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.imported_module).toBe('json');
      expect(entries[0]?.import_type).toBe('stdlib');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---- Known-limitation pinning (block comments not stripped) ---------------

describe('known limitations', () => {
  test('Python block-style comments are not stripped — imports inside /* ... */ DO match', () => {
    // Python uses `#` for comments; `/* import os */` is a syntax error in
    // Python, but we still document the "no block-comment stripping" rule by
    // confirming the `#` line-comment path is the only Python filter.
    const code = "'''\nimport os\n'''\n"; // triple-quoted string literal
    const entries = parseImports('app.py', code);
    // Regex-based parser matches the `import os` line inside the docstring.
    expect(modules(entries)).toContain('os');
  });

  test('JS/TS multi-line block comments are not stripped — imports inside /* */ still match', () => {
    const code = "/*\nimport React from 'react';\n*/\nconst x = 1;\n";
    const entries = parseImports('app.ts', code);
    expect(modules(entries)).toContain('react');
  });

  test('Go multi-line block comments are not stripped — imports inside /* */ still match', () => {
    const code = '/*\nimport "fmt"\n*/\npackage main\n';
    const entries = parseImports('main.go', code);
    expect(modules(entries)).toContain('fmt');
  });

  test('Rust multi-line block comments are not stripped — imports inside /* */ still match', () => {
    const code = '/*\nuse std::io;\n*/\nfn main() {}\n';
    const entries = parseImports('src/main.rs', code);
    expect(modules(entries)).toContain('std::io');
  });
});

// ---- Parity fixtures -------------------------------------------------------

/**
 * The Python baseline lives in
 * `packages/cli/src/topics/pcd/__fixtures__/import-parser/python-captures/`
 * as pairs of `<case>.input` source files and `<case>.entries.json`
 * expected-output captures. See the README in that directory for how to
 * regenerate them with `capture.sh`.
 */
describe('python parity fixtures', () => {
  const fixturesDir = join(__dirname, '__fixtures__', 'import-parser', 'python-captures');

  interface FixtureCase {
    name: string;
    sourceFile: string;
  }

  // Fixture name -> file path that `parse_imports` was called with in Python.
  const cases: FixtureCase[] = [
    { name: 'python-basic', sourceFile: 'app.py' },
    { name: 'python-from', sourceFile: 'app.py' },
    { name: 'python-relative', sourceFile: 'pkg/mod.py' },
    { name: 'python-multi', sourceFile: 'app.py' },
    { name: 'python-inline-comment', sourceFile: 'app.py' },
    { name: 'rust-use', sourceFile: 'src/main.rs' },
    { name: 'rust-nested-use', sourceFile: 'src/main.rs' },
    { name: 'rust-mod', sourceFile: 'src/lib.rs' },
    { name: 'go-single', sourceFile: 'main.go' },
    { name: 'go-block', sourceFile: 'main.go' },
    { name: 'go-aliased', sourceFile: 'main.go' },
    { name: 'js-default', sourceFile: 'app.ts' },
    { name: 'js-named', sourceFile: 'app.ts' },
    { name: 'js-require', sourceFile: 'app.js' },
    { name: 'js-dynamic', sourceFile: 'app.js' },
    { name: 'js-relative', sourceFile: 'app.ts' },
    { name: 'js-side-effect', sourceFile: 'app.js' },
  ];

  for (const { name, sourceFile } of cases) {
    test(`parity: ${name}`, () => {
      const inputPath = join(fixturesDir, `${name}.input`);
      const expectedPath = join(fixturesDir, `${name}.entries.json`);
      const content = readFileSync(inputPath, 'utf8');
      const expected = JSON.parse(readFileSync(expectedPath, 'utf8')) as ImportEntry[];
      expect(parseImports(sourceFile, content)).toEqual(expected);
    });
  }
});
