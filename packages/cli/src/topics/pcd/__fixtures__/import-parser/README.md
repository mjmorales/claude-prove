# import-parser parity fixtures

Byte-parity captures of `tools/pcd/import_parser.parse_imports` for every
language the TypeScript port needs to match. Used by
`import-parser.test.ts`'s "python parity fixtures" suite.

## Layout

```
__fixtures__/import-parser/
  README.md            <- this file
  capture.sh           <- regenerates *.entries.json from *.input
  python-captures/
    <case>.input         <- source code fed to parse_imports()
    <case>.entries.json  <- NamedTuple list as {source_file, imported_module,
                            import_type, raw_line}
```

## Case -> source file mapping

`parse_imports` takes the file path as its first argument and returns
entries keyed by that path. The fixture name encodes the language; the
accompanying source file path used in the capture is listed below and
must match the `cases` array in `import-parser.test.ts`.

| Fixture | source_file argument | Notes |
|---------|----------------------|-------|
| `python-basic` | `app.py` | `import os` |
| `python-from` | `app.py` | `from X import Y` |
| `python-relative` | `pkg/mod.py` | `.` and `..parent` relative forms |
| `python-multi` | `app.py` | `import a, b`, `from X import A, B`, `import X as Y` |
| `python-inline-comment` | `app.py` | Trailing `# ...` stripped before regex |
| `rust-use` | `src/main.rs` | `std::`, `serde::`, `crate::`, `super::` |
| `rust-nested-use` | `src/main.rs` | Known limit: `use X::{A, B};` is one entry |
| `rust-mod` | `src/lib.rs` | `mod X;` |
| `go-single` | `main.go` | Stdlib + external single imports |
| `go-block` | `main.go` | Block import mixing stdlib + external |
| `go-aliased` | `main.go` | `import f "fmt"` + aliased block import |
| `js-default` | `app.ts` | Single/double quote parity |
| `js-named` | `app.ts` | Named + namespace import |
| `js-require` | `app.js` | CommonJS `require(...)` |
| `js-dynamic` | `app.js` | Dynamic `import(...)` |
| `js-relative` | `app.ts` | `./` and `../` classified internal |
| `js-side-effect` | `app.js` | Bare `import 'mod'` |

## Regenerating

```bash
bash packages/cli/src/topics/pcd/__fixtures__/import-parser/capture.sh
```

The script imports `tools/pcd/import_parser.parse_imports` directly and
serializes `ImportEntry._asdict()` as JSON with `indent=2`.

## Capture provenance

- Date captured: 2026-04-22
- Python: `python3` (3.13+ on Darwin arm64)
- Source: `tools/pcd/import_parser.py` at the commit referenced in the
  sibling commit that introduced this file.

## Why `python-captures/` when the TS port is the source of truth?

Until `tools/pcd/` is retired, the Python parser is the reference
implementation. These captures pin that reference so the TS port can be
audited byte-for-byte without rerunning Python. The naming mirrors
`packages/cli/src/topics/cafi/__fixtures__/python-captures/` so reviewers
can find cross-topic fixtures by convention.
