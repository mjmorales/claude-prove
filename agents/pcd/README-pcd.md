# PCD Agent Invocation Contracts

Reference for steward skills orchestrating the Progressive Context Distillation pipeline.

## Pipeline Data Flow

```
Codebase root
  |
  v
Round 0a (deterministic)     -> .prove/steward/pcd/structural-map.json
  |
  v
Round 0b (pcd-annotator)     -> annotated structural-map.json  [optional, skip if < 20 files]
  |
  v
Round 1  (pcd-triager x N)   -> .prove/steward/pcd/triage-batch-{cluster_id}.json
  |                              merged into triage-manifest.json
  v
Collapse (deterministic)     -> .prove/steward/pcd/collapsed-manifest.json
  |
  v
Round 2  (pcd-reviewer x N)  -> .prove/steward/pcd/findings-batch-{batch_id}.json
  |
  v
Round 3  (pcd-synthesizer)   -> .prove/steward/findings.md + fix-plan.md
```

## Agent Contracts

### pcd-annotator (Round 0b)

| Field | Value |
|-------|-------|
| **Name** | `pcd-annotator` |
| **Model** | haiku |
| **Tools** | Read, Glob, Grep |
| **When to skip** | Structural map has < 20 files |

**Input** (provide in prompt):
- Path to `structural-map.json`

**Output**:
- Overwrites `structural-map.json` with added fields per cluster: `semantic_label`, `module_purpose`
- Adds top-level `annotations` object with `hot_spots`, `generated_code`, `domain_notes`

**Prompt template**:
```
Annotate the structural map at .prove/steward/pcd/structural-map.json.
Add semantic labels and module-purpose descriptions to each cluster.
Write the annotated map back to the same file.
```

**Error handling**: Non-critical. If annotation fails, continue with unannotated map.

---

### pcd-triager (Round 1)

| Field | Value |
|-------|-------|
| **Name** | `pcd-triager` |
| **Model** | sonnet |
| **Tools** | Read, Grep |
| **Parallelism** | One agent per cluster, all in parallel |

**Input** (provide in prompt):
- File list for this cluster
- Cluster metadata (ID, member files, dependency edges)
- Output path for this batch

**Output** (`triage-batch-{cluster_id}.json`):
```json
{
  "cluster_id": 0,
  "triage_cards": [
    {
      "file": "str", "lines": "int", "risk": "low|medium|high|critical",
      "confidence": "int(1-5)", "complexity": "low|medium|high",
      "findings": [{"category": "str", "brief": "str", "line_range": [int,int]}],
      "key_symbols": ["str"], "scope_boundaries": ["str"],
      "questions": [{"id":"str", "referencing_file":"str", "referenced_symbol":"str",
                     "referenced_files":["str"], "question_type":"str", "text":"str"}]
    }
  ]
}
```

Clean-bill cards (risk=low, confidence>=4): `{"file":"str", "lines":int, "risk":"low", "confidence":int, "status":"clean"}`

**Prompt template**:
```
Triage these files: [file list].
Structural context: cluster {id}, edges: [dependency edges].
Write triage cards as JSON to .prove/steward/pcd/triage-batch-{cluster_id}.json.
```

**Post-processing** (orchestrator responsibility):
1. Wait for all triager agents to complete
2. Merge all `triage-batch-*.json` into `triage-manifest.json`:
   ```json
   {
     "version": 1,
     "stats": {"files_reviewed":N, "high_risk":N, "medium_risk":N, "low_risk":N, "total_questions":N},
     "cards": [... all cards ...],
     "question_index": [... all questions extracted from cards ...]
   }
   ```

**Error handling**: If a triager fails, assign default high-risk cards to all files in that cluster so they are not skipped in Round 2.

---

### pcd-reviewer (Round 2)

| Field | Value |
|-------|-------|
| **Name** | `pcd-reviewer` |
| **Model** | opus |
| **Tools** | Read, Grep, Glob |
| **Parallelism** | One agent per batch, max 3 concurrent |

**Input** (provide in prompt):
- Batch definition: file list, triage cards, routed questions, cluster context
- Questions must be interleaved with the files they reference (not appended)
- Output path for this batch

**Output** (`findings-batch-{batch_id}.json`):
```json
{
  "batch_id": 1,
  "findings": [
    {"id":"str", "severity":"critical|important|improvement",
     "category":"structural|abstraction|naming|error_handling|performance|hygiene",
     "file":"str", "line_range":[int,int], "title":"str", "detail":"str", "fix_sketch":"str"}
  ],
  "answers": [
    {"question_id":"str", "status":"answered|deferred|not_applicable",
     "answer":"str", "spawned_finding":"str (optional)"}
  ],
  "new_questions": [... same question schema as triager ...]
}
```

**Prompt template**:
```
Review batch {batch_id}.
Files: [file list].
Triage context: [cards for these files].
Routed questions (present each before the file it references):
  - Q-0-001 (for src/auth.py): "Do callers handle None return?"
Cluster context: [cluster metadata].
Write findings to .prove/steward/pcd/findings-batch-{batch_id}.json.
```

**Error handling**: If a reviewer fails, other batches proceed. Missing findings noted in pipeline-status.json. Synthesis works with partial data.

---

### pcd-synthesizer (Round 3)

| Field | Value |
|-------|-------|
| **Name** | `pcd-synthesizer` |
| **Model** | sonnet |
| **Tools** | Read (ONLY) |
| **Parallelism** | Single agent |
| **Critical constraint** | Must NOT read source files |

**Input** (provide in prompt):
- Paths to all artifacts in `.prove/steward/pcd/`
- Explicit instruction to not read source files

**Output**:
- `.prove/steward/findings.md` — standard steward format (Critical Issues, Structural Refactors, Naming & Readability, Code Hygiene, Performance, Systemic Recommendations)
- `.prove/steward/fix-plan.md` — parallelizable work packages with file lists and finding IDs

**Prompt template**:
```
Synthesize all review artifacts in .prove/steward/pcd/:
- structural-map.json (codebase structure)
- collapsed-manifest.json (triage summary)
- findings-batch-*.json (detailed findings)

DO NOT read any source files directly.

Produce:
- .prove/steward/findings.md (standard steward findings format)
- .prove/steward/fix-plan.md (parallelizable work packages)
```

**Error handling**: Critical — no findings.md means downstream phases cannot proceed. Retry once. If still failing, fall back to single-pass `code-steward` agent.

## Deterministic Rounds (CLI)

These are not agents — they are invoked via Bash by the orchestrating skill.

| Round | Command | Input | Output |
|-------|---------|-------|--------|
| 0a | `prove pcd map --project-root "$PROJECT_ROOT" [--scope files]` | Codebase | `structural-map.json` |
| Collapse | `prove pcd collapse --project-root "$PROJECT_ROOT"` | `triage-manifest.json` | `collapsed-manifest.json` |
| Batch | `prove pcd batch --project-root "$PROJECT_ROOT"` | collapsed + structural map | `batch-definitions.json` |

## Fallback Protocol

If any critical PCD round fails (Round 1 no output, Round 2 all batches fail, Round 3 fails to produce findings.md):

```
Launch code-steward agent:
> Audit [scope] in document-only mode. Produce findings and fix plan.
```

Log the PCD failure reason in `.prove/steward/pcd/pipeline-status.json`.
