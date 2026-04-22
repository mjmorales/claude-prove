/**
 * Language-agnostic import extraction for Python, Rust, Go, JS/TS.
 *
 * Ported from `tools/pcd/import_parser.py`. Regex-based parsing only — no
 * AST, no external dependencies. Known limitations (block comments,
 * brace-group `use` statements, relative imports not resolved) are
 * preserved byte-for-byte with the Python implementation; do not "fix"
 * them without a matching parity update.
 */

import { extname } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single import extracted from a source file.
 *
 * Field order mirrors the Python `NamedTuple` `ImportEntry` — capture
 * fixtures serialize these as `[source_file, imported_module,
 * import_type, raw_line]` tuples / `{source_file, ...}` objects.
 */
export interface ImportEntry {
  source_file: string;
  imported_module: string;
  import_type: ImportType;
  raw_line: string;
}

export type ImportType = 'stdlib' | 'external' | 'internal' | 'unknown';

export type Language = 'python' | 'rust' | 'go' | 'javascript' | 'typescript';

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

const LANGUAGE_MAP: Record<string, Language> = {
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'typescript',
};

/** Return the language name for `filePath`, or `null` if unsupported. */
export function detectLanguage(filePath: string): Language | null {
  const ext = extname(filePath).toLowerCase();
  return LANGUAGE_MAP[ext] ?? null;
}

// ---------------------------------------------------------------------------
// Python stdlib set (CPython 3.10+)
// ---------------------------------------------------------------------------

/** CPython 3.10+ stdlib top-level module names. Port of `PYTHON_STDLIB`. */
const PYTHON_STDLIB: ReadonlySet<string> = new Set([
  '__future__',
  '_thread',
  'abc',
  'aifc',
  'argparse',
  'array',
  'ast',
  'asynchat',
  'asyncio',
  'asyncore',
  'atexit',
  'audioop',
  'base64',
  'bdb',
  'binascii',
  'binhex',
  'bisect',
  'builtins',
  'bz2',
  'calendar',
  'cgi',
  'cgitb',
  'chunk',
  'cmath',
  'cmd',
  'code',
  'codecs',
  'codeop',
  'collections',
  'colorsys',
  'compileall',
  'concurrent',
  'configparser',
  'contextlib',
  'contextvars',
  'copy',
  'copyreg',
  'cProfile',
  'crypt',
  'csv',
  'ctypes',
  'curses',
  'dataclasses',
  'datetime',
  'dbm',
  'decimal',
  'difflib',
  'dis',
  'distutils',
  'doctest',
  'email',
  'encodings',
  'enum',
  'errno',
  'faulthandler',
  'fcntl',
  'filecmp',
  'fileinput',
  'fnmatch',
  'fractions',
  'ftplib',
  'functools',
  'gc',
  'getopt',
  'getpass',
  'gettext',
  'glob',
  'graphlib',
  'grp',
  'gzip',
  'hashlib',
  'heapq',
  'hmac',
  'html',
  'http',
  'idlelib',
  'imaplib',
  'imghdr',
  'imp',
  'importlib',
  'inspect',
  'io',
  'ipaddress',
  'itertools',
  'json',
  'keyword',
  'lib2to3',
  'linecache',
  'locale',
  'logging',
  'lzma',
  'mailbox',
  'mailcap',
  'marshal',
  'math',
  'mimetypes',
  'mmap',
  'modulefinder',
  'multiprocessing',
  'netrc',
  'nis',
  'nntplib',
  'numbers',
  'operator',
  'optparse',
  'os',
  'ossaudiodev',
  'pathlib',
  'pdb',
  'pickle',
  'pickletools',
  'pipes',
  'pkgutil',
  'platform',
  'plistlib',
  'poplib',
  'posix',
  'posixpath',
  'pprint',
  'profile',
  'pstats',
  'pty',
  'pwd',
  'py_compile',
  'pyclbr',
  'pydoc',
  'queue',
  'quopri',
  'random',
  're',
  'readline',
  'reprlib',
  'resource',
  'rlcompleter',
  'runpy',
  'sched',
  'secrets',
  'select',
  'selectors',
  'shelve',
  'shlex',
  'shutil',
  'signal',
  'site',
  'smtpd',
  'smtplib',
  'sndhdr',
  'socket',
  'socketserver',
  'spwd',
  'sqlite3',
  'ssl',
  'stat',
  'statistics',
  'string',
  'stringprep',
  'struct',
  'subprocess',
  'sunau',
  'symtable',
  'sys',
  'sysconfig',
  'syslog',
  'tabnanny',
  'tarfile',
  'telnetlib',
  'tempfile',
  'termios',
  'test',
  'textwrap',
  'threading',
  'time',
  'timeit',
  'tkinter',
  'token',
  'tokenize',
  'tomllib',
  'trace',
  'traceback',
  'tracemalloc',
  'tty',
  'turtle',
  'turtledemo',
  'types',
  'typing',
  'unicodedata',
  'unittest',
  'urllib',
  'uu',
  'uuid',
  'venv',
  'warnings',
  'wave',
  'weakref',
  'webbrowser',
  'winreg',
  'winsound',
  'wsgiref',
  'xdrlib',
  'xml',
  'xmlrpc',
  'zipapp',
  'zipfile',
  'zipimport',
  'zlib',
  'zoneinfo',
]);

export { LANGUAGE_MAP, PYTHON_STDLIB };

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Classify `module` as `stdlib`, `external`, `internal`, or `unknown`.
 *
 * `projectFiles` is accepted for API parity with the Python helper but is
 * unused by the current classifier set; reserved for future resolution of
 * relative imports against a known file set.
 */
export function classifyImport(
  module: string,
  language: string,
  _projectFiles?: Set<string>,
): ImportType {
  if (language === 'python') return classifyPython(module);
  if (language === 'rust') return classifyRust(module);
  if (language === 'go') return classifyGo(module);
  if (language === 'javascript' || language === 'typescript') return classifyJsTs(module);
  return 'unknown';
}

function classifyPython(module: string): ImportType {
  if (module.startsWith('.')) return 'internal';
  const top = module.split('.')[0] ?? '';
  if (PYTHON_STDLIB.has(top)) return 'stdlib';
  return 'external';
}

function classifyRust(module: string): ImportType {
  if (module.startsWith('std::') || module.startsWith('core::') || module.startsWith('alloc::')) {
    return 'stdlib';
  }
  if (module === 'std' || module === 'core' || module === 'alloc') return 'stdlib';
  if (module.startsWith('crate::') || module.startsWith('super::') || module.startsWith('self::')) {
    return 'internal';
  }
  if (module === 'crate' || module === 'super' || module === 'self') return 'internal';
  return 'external';
}

function classifyGo(module: string): ImportType {
  // Go stdlib packages contain no dots in the path.
  if (!module.includes('.')) return 'stdlib';
  return 'external';
}

function classifyJsTs(module: string): ImportType {
  if (module.startsWith('./') || module.startsWith('../')) return 'internal';
  return 'external';
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Extract all imports from `content` for the file at `filePath`.
 *
 * Dispatches to a language-specific parser based on file extension.
 * Returns an empty array for unsupported languages.
 */
export function parseImports(filePath: string, content: string): ImportEntry[] {
  const language = detectLanguage(filePath);
  if (language === null) return [];
  if (language === 'python') return parsePythonImports(filePath, content);
  if (language === 'rust') return parseRustImports(filePath, content);
  if (language === 'go') return parseGoImports(filePath, content);
  return parseJsTsImports(filePath, content);
}

// ---------------------------------------------------------------------------
// Python parser
// ---------------------------------------------------------------------------

/** Matches `import foo`, `import foo as bar`, `import foo, bar`. */
const PY_IMPORT_RE = /^import\s+(.+)$/gm;
/** Matches `from foo import bar`, `from . import bar`, `from ..foo import bar`. */
const PY_FROM_IMPORT_RE = /^from\s+(\.{0,3}\w[\w.]*|\.+)\s+import\s+(.+)$/gm;

function parsePythonImports(filePath: string, content: string): ImportEntry[] {
  const entries: ImportEntry[] = [];
  const cleaned = stripPythonComments(content);

  for (const m of cleaned.matchAll(PY_FROM_IMPORT_RE)) {
    const module = (m[1] ?? '').trim();
    const raw = m[0].trim();
    entries.push({
      source_file: filePath,
      imported_module: module,
      import_type: classifyPython(module),
      raw_line: raw,
    });
  }

  for (const m of cleaned.matchAll(PY_IMPORT_RE)) {
    const raw = m[0].trim();
    const modulesStr = (m[1] ?? '').trim();
    for (const rawPart of modulesStr.split(',')) {
      const part = rawPart.trim();
      // Handle `import foo as bar` -> module is `foo`
      const mod = part.includes(' as ') ? (part.split(' as ')[0] ?? '').trim() : part;
      if (!mod) continue;
      entries.push({
        source_file: filePath,
        imported_module: mod,
        import_type: classifyPython(mod),
        raw_line: raw,
      });
    }
  }

  return entries;
}

function stripPythonComments(content: string): string {
  const lines: string[] = [];
  for (const line of content.split('\n')) {
    const idx = line.indexOf('#');
    lines.push(idx >= 0 ? line.slice(0, idx) : line);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Rust parser
// ---------------------------------------------------------------------------

/** Matches `use std::collections::HashMap;` and `use std::{io, fs};`. */
const RS_USE_RE = /^\s*use\s+([\w:]+(?:::\{[^}]+\})?)\s*;/gm;
/** Matches `mod submodule;`. */
const RS_MOD_RE = /^\s*mod\s+(\w+)\s*;/gm;

function parseRustImports(filePath: string, content: string): ImportEntry[] {
  const entries: ImportEntry[] = [];
  const cleaned = stripLineComments(content);

  for (const m of cleaned.matchAll(RS_USE_RE)) {
    const path = (m[1] ?? '').trim();
    const raw = m[0].trim();
    entries.push({
      source_file: filePath,
      imported_module: path,
      import_type: classifyRust(path),
      raw_line: raw,
    });
  }

  for (const m of cleaned.matchAll(RS_MOD_RE)) {
    const modName = (m[1] ?? '').trim();
    const raw = m[0].trim();
    entries.push({
      source_file: filePath,
      imported_module: modName,
      import_type: 'internal',
      raw_line: raw,
    });
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Go parser
// ---------------------------------------------------------------------------

/** Single import: `import "fmt"` or `import alias "fmt"`. */
const GO_SINGLE_IMPORT_RE = /^\s*import\s+(?:(\w+)\s+)?"([^"]+)"/gm;
/** Block import: `import ( ... )`. `[\s\S]` emulates Python's `re.DOTALL`. */
const GO_BLOCK_IMPORT_RE = /^\s*import\s*\(([\s\S]*?)\)/gm;
/** Individual line inside a block: optional alias + quoted path. */
const GO_BLOCK_LINE_RE = /(?:(\w+)\s+)?"([^"]+)"/g;

function parseGoImports(filePath: string, content: string): ImportEntry[] {
  const entries: ImportEntry[] = [];
  const cleaned = stripLineComments(content);

  // Block imports first so single-import matches inside them can be skipped.
  const blockSpans: Array<[number, number]> = [];
  for (const m of cleaned.matchAll(GO_BLOCK_IMPORT_RE)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    blockSpans.push([start, end]);
    const blockBody = m[1] ?? '';
    const rawBlock = m[0].trim();
    for (const lineM of blockBody.matchAll(GO_BLOCK_LINE_RE)) {
      const pkg = lineM[2] ?? '';
      entries.push({
        source_file: filePath,
        imported_module: pkg,
        import_type: classifyGo(pkg),
        raw_line: rawBlock,
      });
    }
  }

  for (const m of cleaned.matchAll(GO_SINGLE_IMPORT_RE)) {
    const pos = m.index ?? 0;
    if (blockSpans.some(([s, e]) => s <= pos && pos < e)) continue;
    const pkg = m[2] ?? '';
    const raw = m[0].trim();
    entries.push({
      source_file: filePath,
      imported_module: pkg,
      import_type: classifyGo(pkg),
      raw_line: raw,
    });
  }

  return entries;
}

// ---------------------------------------------------------------------------
// JS / TS parser
// ---------------------------------------------------------------------------

/** `import foo from 'bar'` | `import { foo } from 'bar'` | `import * as foo from 'bar'`. */
const JS_IMPORT_FROM_RE = /^\s*import\s+.*?\s+from\s+['"]([^'"]+)['"]/gm;
/** `import 'bar'` (side-effect import). */
const JS_IMPORT_BARE_RE = /^\s*import\s+['"]([^'"]+)['"]/gm;
/** `const foo = require('bar')` | `require('bar')`. */
const JS_REQUIRE_RE = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
/** Dynamic `import('./bar')`. */
const JS_DYNAMIC_IMPORT_RE = /import\(\s*['"]([^'"]+)['"]\s*\)/g;

function parseJsTsImports(filePath: string, content: string): ImportEntry[] {
  const entries: ImportEntry[] = [];
  const cleaned = stripLineComments(content);
  const seen = new Set<string>(); // `${module} ${raw}` dedup

  const add = (module: string, raw: string): void => {
    const key = `${module} ${raw}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({
      source_file: filePath,
      imported_module: module,
      import_type: classifyJsTs(module),
      raw_line: raw,
    });
  };

  for (const m of cleaned.matchAll(JS_IMPORT_FROM_RE)) {
    add(m[1] ?? '', m[0].trim());
  }

  for (const m of cleaned.matchAll(JS_IMPORT_BARE_RE)) {
    const module = m[1] ?? '';
    const raw = m[0].trim();
    const key = `${module} ${raw}`;
    if (!seen.has(key)) {
      // Avoid double-matching lines already caught by JS_IMPORT_FROM_RE.
      const fullLine = getFullLine(cleaned, m.index ?? 0);
      if (!fullLine.includes(' from ')) add(module, raw);
    }
  }

  for (const m of cleaned.matchAll(JS_REQUIRE_RE)) {
    add(m[1] ?? '', m[0].trim());
  }

  for (const m of cleaned.matchAll(JS_DYNAMIC_IMPORT_RE)) {
    add(m[1] ?? '', m[0].trim());
  }

  return entries;
}

function getFullLine(content: string, pos: number): string {
  const prevNewline = content.lastIndexOf('\n', pos - 1);
  const start = prevNewline + 1;
  const nextNewline = content.indexOf('\n', pos);
  const end = nextNewline === -1 ? content.length : nextNewline;
  return content.slice(start, end);
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Strip `//` line comments by blanking any line whose first non-whitespace
 * chars are `//`. Used by Rust, Go, and JS/TS. Block comments (`/* ... *\/`)
 * are intentionally NOT stripped — this mirrors the Python implementation.
 */
function stripLineComments(content: string): string {
  const lines: string[] = [];
  for (const line of content.split('\n')) {
    const stripped = line.trimStart();
    lines.push(stripped.startsWith('//') ? '' : line);
  }
  return lines.join('\n');
}
