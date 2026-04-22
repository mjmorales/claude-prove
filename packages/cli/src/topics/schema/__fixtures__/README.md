# schema parity fixtures

Reference inputs and captured CLI outputs for the schema topic. Two
consumers use this directory:

- `integration.test.ts` — spawns the TS CLI against each fixture and
  asserts its output matches `ts-captures/<action>_<fixture>.txt`
  byte-for-byte, guarding against regressions in the port.
- humans + reviewers — compare `python-captures/` vs `ts-captures/` to
  verify the port stays faithful to the Python source.

## Input fixtures

| File      | Shape                                                                 |
|-----------|------------------------------------------------------------------------|
| `v0.json` | Pre-schema: no `schema_version`, has `validators` (phase) + `scopes`. |
| `v1.json` | `schema_version: "1"` with legacy `stage` field on validators.        |
| `v2.json` | `schema_version: "2"` with top-level `index` block.                   |
| `v3.json` | `schema_version: "3"` with `scopes.tools` + `tools.schema` entries.   |

Each fixture exercises a different migration hop so the CLI captures
cover the full `v0 -> v4` chain.

## Capture commands

Run the capture helper after any logic change in `schemas.ts`,
`validate.ts`, `migrate.ts`, or `diff.ts`:

```bash
bash packages/cli/src/topics/schema/__fixtures__/capture.sh
```

The helper copies each fixture to a temp dir as `.prove.json` (so
`auto-detect` fires and the filename in output is deterministic), runs
`validate`, `migrate --dry-run`, and `diff` under both the Python CLI
(`python3 -m tools.schema ...`) and the TS CLI (`bun run
packages/cli/bin/run.ts schema ...`), and substitutes the temp path with
the sentinel `<FIXTURE_PATH>` so captures are reproducible.

Outputs land in:

- `python-captures/<action>_<fixture>.txt`
- `ts-captures/<action>_<fixture>.txt`

## Python vs TS divergence (v3 -> v4 hop)

`CURRENT_SCHEMA_VERSION` is `"3"` in `tools/schema/schemas.py` but `"4"`
in `packages/cli/src/topics/schema/schemas.ts` (v3 -> v4 migration
landed in Task 2 of the packaging effort). As a result, parity is NOT
byte-identical for fixtures that transit through v3 or any output that
names `CURRENT_SCHEMA_VERSION`:

- `validate_v0..v2.txt` — identical (Python returns FAIL/warnings for
  pre-v3 configs; TS returns the same because v4 requirements are a
  superset of v3's).
- `validate_v3.txt` — IDENTICAL under Python (PASS at v3) and TS (PASS
  at v3; the v3 -> v4 hop is the migrator's concern, not the
  validator's).
- `migrate_dry_v0..v2.txt` — diverge by one extra hop: TS appends
  `schema_version: "3" -> "4"` + the v3 -> v4 drops.
- `migrate_dry_v3.txt` — Python says "no migration needed"; TS emits
  the v3 -> v4 plan.
- `diff_v3.txt` — Python says "up to date"; TS emits a migration plan
  + target JSON dump.
- `summary_repo.txt` — same flavour of divergence plus the live state
  of the repo's `.claude/.prove.json` + `.claude/settings.json`.

The integration test therefore asserts against `ts-captures/` (not
`python-captures/`); the Python captures are preserved as documentation
and cross-reference for future port authors. When Task 4 deletes
`tools/schema/` the Python captures become a historical artifact.

## Capture provenance

- Date captured: 2026-04-22
- Python: `python3` (3.13+ on Darwin arm64)
- Bun: workspace pinned (`bun@1.2.22` per root `package.json`)
- Plugin version at capture: v0.36.0 (`package.json` at repo root)
- Schema versions: Python `CURRENT_SCHEMA_VERSION = "3"`, TS `= "4"`

Re-run `capture.sh` after updating `CURRENT_SCHEMA_VERSION` or any
migration/validation/diff logic. Commit the refreshed captures alongside
the logic change.
