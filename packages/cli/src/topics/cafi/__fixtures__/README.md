# CAFI parity fixtures

Reference captures for the CAFI topic. Two consumers use this directory:

- `indexer.test.ts` — spawns the TS CAFI API against a synthetic project
  (stubbed `claude` CLI) and asserts output matches `ts-captures/`
  byte-for-byte.
- humans + reviewers — cross-check `python-captures/` vs `ts-captures/`
  when investigating port parity.

## Capture layout

```
__fixtures__/
  README.md             <- this file
  capture.sh            <- regenerates captures against a synthetic project
  python-captures/      <- historical captures from the retired Python CLI (pre-v0.38.0)
  ts-captures/          <- output of the TS indexer (via capture.sh harness)
```

## Synthetic project shape

`capture.sh` creates a throwaway project with three small text files:

- `README.md`
- `src/main.ts`
- `src/util.ts`

The `claude` CLI is stubbed via a shim on `$PATH` that returns a JSON map
of `{path: "stub description for <path>"}` for each file, so the cache
content is deterministic across runs.

## Python vs TS divergence

The current Python and TS CLIs render identical library-level data via
different presentation paths:

- `lookup` — Python renders `` - `path`: desc `` markdown bullets on
  stdout; the TS harness writes `path\n  description` blocks. The
  underlying library output (`indexer.lookup()`) is a list of
  `{path, description}` objects in both ports.
- `status` — Python emits `json.dumps(..., indent=2)` in insertion order;
  the TS harness emits alphabetically sorted keys so test diffs are
  stable. Same field set in both cases.
- `context` — Identical stdout between Python and TS once the stub
  description is the same.
- `index` — Both ports produce the same cache file shape; Python writes
  `last_indexed` only when the shared helper is used, TS always records
  it (matches the v1 shared-cache schema).

Full parity capture (including Python stdout captures) lands in task 4
when the `prove cafi` dispatcher is wired — at that point both CLIs go
through the same presentation layer. Task 2 pins only the TS captures
required by `indexer.test.ts`:

- `ts-captures/status.txt`
- `ts-captures/context.txt`
- `ts-captures/lookup_util.txt`

The `python-captures/` directory is intentionally empty for task 2 — do
not compare it against `ts-captures/` until task 4 reconciles the
presentation layer.

## Capture commands

```bash
bash packages/cli/src/topics/cafi/__fixtures__/capture.sh
```

## Capture provenance

- Date captured: 2026-04-22
- Python: `python3` (3.13+ on Darwin arm64)
- Bun: workspace pinned (`bun@1.2.22` per root `package.json`)
- Plugin version at capture: v0.37.0+ (`package.json` at repo root)
- Cache schema: v1 (`CACHE_VERSION = 1` in `@claude-prove/shared/cache`)
