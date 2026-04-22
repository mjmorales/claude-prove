# structural-map parity fixtures

Byte-parity captures of
`tools/pcd/structural_map.generate_structural_map` for the fixture
projects consumed by `structural-map.test.ts` ("python parity fixtures"
suite).

## Layout

```
__fixtures__/structural-map/
  README.md            <- this file
  capture.sh           <- regenerates python-captures/*.json
  projects/
    small/               <- 3-file Python project, single cluster
    medium/              <- ~9 files across Python, TypeScript, Rust
    edge/                <- single-file / scope-degenerate cases
  python-captures/
    <case>.json          <- generate_structural_map(project, scope) output,
                             timestamp normalized to "CAPTURED"
```

## Case -> scope mapping

The TS test and `capture.sh` share this mapping. Update both together.

| Case | Scope |
|------|-------|
| `small` | `app.py`, `helpers.py`, `models.py` |
| `medium` | `py/__init__.py`, `py/app.py`, `py/models.py`, `py/utils.py`, `ts/index.ts`, `ts/math.ts`, `ts/logger.ts`, `rs/src/main.rs`, `rs/src/parser.rs` |
| `edge` | `solo.py` |

## Known Python resolver limitations (preserved on purpose)

These are intentionally NOT fixed in either port. The TS version must
match these captures byte-for-byte.

- **JS/TS relative imports lose the importing file's directory context**.
  `ts/index.ts` has `import { add } from './math'`, but
  `_resolve_js_ts('./math', ...)` normalizes the module to `math` and
  looks for `math.ts` at project root — never finds `ts/math.ts`. No
  dependency edge is recorded.
- **Rust `crate::mod::func` with lowercase trailing segment does not
  round-trip**. `crate::parser::parse` is not trimmed (no uppercase type
  name) and resolves to `src/parser/parse.rs`, which doesn't exist.
- **`mod parser;` is not resolved**. The mod name has no
  `crate::`/`self::`/`super::` prefix, so the Rust resolver returns
  `None`.

## Regenerating

```bash
bash packages/cli/src/topics/pcd/__fixtures__/structural-map/capture.sh
```

The script imports `tools/pcd/structural_map.generate_structural_map`
directly and writes the result as JSON with `indent=2`. Timestamps are
replaced with the literal string `"CAPTURED"` so comparisons stay
byte-stable across runs.

## Capture provenance

- Date captured: 2026-04-22
- Python: `python3` (3.13+ on Darwin arm64)
- Source: `tools/pcd/structural_map.py` at the commit referenced in the
  sibling commit that introduced this file.

## Why `python-captures/` when the TS port is the source of truth?

Until `tools/pcd/` is retired, the Python generator is the reference
implementation. These captures pin that reference so the TS port can be
audited byte-for-byte without rerunning Python. The naming mirrors
`packages/cli/src/topics/pcd/__fixtures__/import-parser/python-captures/`
so reviewers can find cross-fixture captures by convention.
