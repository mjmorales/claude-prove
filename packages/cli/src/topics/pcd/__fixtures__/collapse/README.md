# collapse parity fixtures

Byte-parity captures of `tools/pcd/collapse.collapse_manifest(manifest, 8000)`
for every boundary case the TypeScript port must match. Consumed by the
`"python parity fixtures"` suite inside `collapse.test.ts`.

## Layout

```
__fixtures__/collapse/
  README.md            <- this file
  capture.sh           <- regenerates *.output.json from *.input.json
  python-captures/
    <case>.input.json    <- triage manifest fed to collapse_manifest()
    <case>.output.json   <- Python collapse_manifest(manifest, 8000) result
```

## Cases

| Fixture | Intent |
|---------|--------|
| `all-clean` | Every card `status: "clean"` — every card collapses. Cards carry explicit `cluster_id`s (see hash note below). |
| `all-critical` | Every card `risk: critical` — every card preserved, `collapsed_summaries` is empty. |
| `boundary-risk-low-conf-3` | `risk: low` + `confidence: 3` — preserved by the confidence threshold (`<= 3`). |
| `boundary-risk-low-conf-4` | `risk: low` + `confidence: 4` — collapsed (first step past the confidence boundary). |
| `boundary-risk-medium-conf-5` | `risk: medium` + `confidence: 5` — preserved by the risk threshold (`>= medium`). |
| `mixed` | Clean + low (cluster 3) + medium + critical in one manifest. Exercises the split between `preserved_cards` and `collapsed_summaries`. |
| `empty-manifest` | Zero cards — all stats zero, `compression_ratio: 0.0`, arrays empty. |

## Regenerating

```bash
bash packages/cli/src/topics/pcd/__fixtures__/collapse/capture.sh
```

The script calls `collapse_manifest(manifest, 8000)` and writes the result
via `json.dump(..., indent=2)` + a trailing newline so the TS port can
compare bytes (not just structure).

## Why fixtures pin `cluster_id` on every collapsed card

`collapse.py::_cluster_key` falls back to `hash(directory) % 10000` when a
card has no `cluster_id`. CPython's `hash(str)` is randomized per process
(PEP 456), so that fallback is not reproducible across runs — capture
output would shift every time PYTHONHASHSEED changes.

To keep byte parity stable, every fixture whose cards should collapse
carries an explicit integer `cluster_id`. The TS port's directory
fallback uses FNV-1a and is exercised only by unit tests, not by the
parity suite.

## Capture provenance

- Date captured: 2026-04-22
- Python: `python3` (3.13+ on Darwin arm64)
- Source: `tools/pcd/collapse.py` at the commit referenced in the sibling
  commit that introduced this directory.
