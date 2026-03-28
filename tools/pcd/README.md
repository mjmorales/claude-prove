# PCD — Progressive Context Distillation

Pipeline tooling for multi-round code audits. PCD solves the **single-pass attention dilution problem**: feeding an entire codebase to a single LLM call causes shallow coverage because the model's attention spreads across thousands of lines. PCD instead runs a structured pipeline that compresses low-signal files, targets expensive model capacity at high-risk code, and routes cross-file questions to the batch that can answer them.

The pipeline is consumed by the `steward` skill, which orchestrates agents over the intermediary artifacts produced here.

## Pipeline Overview

Six rounds alternate between deterministic (no LLM) and LLM-driven steps:

```
Round 0a  [deterministic]  map        structural-map.json
Round 0b  [LLM — optional] annotate   structural-map.json (mutated)
Round 1   [LLM — parallel] triage     triage-batch-{id}.json -> triage-manifest.json
Round 1b  [deterministic]  collapse   collapsed-manifest.json
Round 2   [LLM — targeted] review     findings-batch-{id}.json
Round 3   [LLM]            synthesize findings.md + fix-plan.md
```

Deterministic rounds (`map`, `collapse`, `batch`) are implemented in this package and invoked via CLI. LLM rounds are invoked by the steward skill as agent launches; this package provides the artifact schemas they must conform to.

## Quick Start

```bash
# From the project under audit
python3 $PLUGIN_DIR/tools/pcd/__main__.py --project-root . map
python3 $PLUGIN_DIR/tools/pcd/__main__.py --project-root . status
```

## Artifact Layout

All artifacts land under `.prove/steward/pcd/` in the project under audit.

```
.prove/steward/pcd/
├── structural-map.json       # Round 0a — file metadata, clusters, edges
├── triage-batch-{id}.json    # Round 1 per-cluster output (LLM-written)
├── triage-manifest.json      # Round 1 merged — all triage cards + question index
├── collapsed-manifest.json   # Round 1b — compressed manifest
├── batch-definitions.json    # Round 2 input — review batches with routed questions
├── findings-batch-{id}.json  # Round 2 per-batch output (LLM-written)
└── pipeline-status.json      # Optional — pipeline progress tracking
```

## CLI Reference

All subcommands share a `--project-root` flag that defaults to cwd. JSON goes to stdout; human-readable summaries go to stderr.

### `map` — Generate structural map (Round 0a)

```
python3 tools/pcd/__main__.py [--project-root DIR] map [--scope FILE1,FILE2,...]
```

Walks the project, parses imports, builds a dependency graph, clusters files by connectivity, and enriches module entries with CAFI descriptions if a `.prove/file-index.json` cache exists.

| Flag | Description | Default |
|------|-------------|---------|
| `--project-root DIR` | Project root to analyze | `cwd` |
| `--scope FILE,...` | Comma-separated file list to restrict analysis | all files |

### `collapse` — Compress triage manifest (Round 1b)

```
python3 tools/pcd/__main__.py [--project-root DIR] collapse [--token-budget N]
```

Reads `triage-manifest.json`. Preserves full triage cards for files with risk `medium` or above, or confidence score 3 or below. Collapses the rest into per-cluster summaries.

| Flag | Description | Default |
|------|-------------|---------|
| `--token-budget N` | Approximate token target (recorded in stats only) | `8000` |

### `batch` — Form review batches (Round 2 input)

```
python3 tools/pcd/__main__.py [--project-root DIR] batch [--max-files N]
```

Reads `collapsed-manifest.json` and `structural-map.json`. Groups preserved triage cards by cluster. Splits clusters exceeding the per-batch file limit by sub-directory. Routes cross-file questions to the batch containing the target files.

| Flag | Description | Default |
|------|-------------|---------|
| `--max-files N` | Maximum files per review batch | `15` |

### `status` — Show pipeline state

```
python3 tools/pcd/__main__.py [--project-root DIR] status
```

If `pipeline-status.json` exists, prints round-by-round state. Otherwise reports which intermediate artifacts are present or missing.

## Module Reference

### `import_parser.py`

Regex-based import extraction. No AST, no external dependencies.

```python
from pcd.import_parser import parse_imports, ImportEntry
entries: list[ImportEntry] = parse_imports("src/main.py", content)
```

**`ImportEntry`** (NamedTuple):

| Field | Type | Description |
|-------|------|-------------|
| `source_file` | `str` | Path of the importing file |
| `imported_module` | `str` | Raw module string as written in source |
| `import_type` | `str` | `"stdlib"`, `"external"`, `"internal"`, or `"unknown"` |
| `raw_line` | `str` | The original import statement |

Public helpers: `detect_language(file_path)`, `classify_import(module, language, project_files)`.

### `structural_map.py`

Round 0a implementation. Walks source files (via CAFI's `walk_project`), parses imports, resolves internal targets to file paths, and clusters by connected components.

```python
from pcd.structural_map import generate_structural_map
result: dict = generate_structural_map(project_root, scope=None)
```

### `collapse.py`

Round 1b deterministic compression.

```python
from pcd.collapse import collapse_manifest
result: dict = collapse_manifest(triage_manifest, token_budget=8000)
```

**Preserve/collapse rules:**
- `status: "clean"` cards are always collapsed
- Risk `medium`/`high`/`critical` cards are preserved
- Confidence `<= 3` cards are preserved regardless of risk
- `question_index` is always copied in full — questions are never dropped

### `batch_former.py`

Round 2 batch formation. Groups preserved cards by cluster, splits oversized clusters, routes questions.

```python
from pcd.batch_former import form_batches
batches: list[dict] = form_batches(collapsed_manifest, structural_map, max_files_per_batch=15)
```

### `schemas.py`

Schema definitions and validator for all PCD artifacts.

```python
from pcd.schemas import validate_artifact, SCHEMA_REGISTRY
errors: list[str] = validate_artifact(data, "structural_map")
```

**Registry keys:** `structural_map`, `triage_card`, `triage_card_clean`, `triage_manifest`, `collapsed_manifest`, `findings_batch`, `batch_definition`, `pipeline_status`.

## Supported Languages

| Language | Extensions | Import forms | Notes |
|----------|-----------|--------------|-------|
| Python | `.py` | `import X`, `from X import Y`, relative | stdlib set from CPython 3.10+ |
| Rust | `.rs` | `use X;`, `mod X;` | brace groups as single entry |
| Go | `.go` | single/block `import`, aliased | reads `go.mod` for module prefix |
| JS/TS | `.js`, `.jsx`, `.mjs`, `.ts`, `.tsx` | ESM imports, `require()`, dynamic `import()` | |

**Known limitations:**
- Multi-line block comments (`/* ... */`) not stripped — imports inside them will match
- Python relative imports classified as `internal` but not resolved to file paths
- Rust `use X::{A, B}` recorded as single import entry
- Go vendored paths and `replace` directives not handled
- Export extraction not implemented — all files emit `exports: []`

## Testing

```bash
docker run --rm -v "$PWD":/project prove-validators python -m pytest tools/pcd/ -v
```

| Test file | Covers |
|-----------|--------|
| `test_import_parser.py` | All 4 language parsers, classification, edge cases |
| `test_structural_map.py` | Dependency graph, clustering, CAFI integration |
| `test_collapse.py` | Preserve/collapse thresholds, question passthrough |
| `test_batch_former.py` | Cluster grouping, splitting, question routing |
| `test_schemas.py` | All 8 schema keys — valid/invalid fixtures |
