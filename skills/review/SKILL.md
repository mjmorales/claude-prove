---
name: review
description: >
  Assemble per-commit intent manifests into a review document. Launch the
  browser-based review UI for structured accept/reject per intent group.
  Falls back to LLM reconstruction when manifests are missing.
argument-hint: "[base-branch (default: main)]"
---

# Review: $ARGUMENTS

**Read-only** -- write ACB/review artifacts only; never modify project code. Respect .gitignore.

## Phase 1: Extract Diff Context

1. **Base branch**: Use `$ARGUMENTS` if provided, otherwise `main`. Verify with `git rev-parse --verify <base>`. Fall back to `master`, then halt.

2. **Gather diff data** (parallel):
   ```bash
   git diff --stat <base>...HEAD
   git diff --name-status <base>...HEAD
   git log --oneline <base>..HEAD
   git rev-parse <base>
   git rev-parse HEAD
   ```

3. **Edge cases**: Empty diff -- inform and stop. Exclude binary and generated files (dist/, build/, lock files) from intent groups.

## Phase 2: Assemble or Reconstruct

Check for manifests in the SQLite store:
```bash
PYTHONPATH="$PLUGIN_DIR" python3 -c "
from tools.acb.store import open_store
s = open_store('.')
branch = '$(git rev-parse --abbrev-ref HEAD)'
print(len(s.list_manifests(branch)))
s.close()
"
```

### Path A: Manifests exist

```bash
PYTHONPATH="$PLUGIN_DIR" python3 -m tools.acb assemble --base <base>
```

The ACB document is saved to the SQLite store (`.prove/acb.db`). If **uncovered files** remain, use Path B for those files and merge.

### Path B: Reconstruction fallback

Reconstruct intent groups from the diff when no manifests exist or for uncovered files.

**Grouping criteria** (priority order):
1. Shared purpose -- files implementing the same feature/fix
2. Layer alignment -- same architectural layer
3. Change coupling -- changes that reference each other

**Per intent group:**
- `id`: slug (e.g., `auth-middleware`), `title`: short name
- `classification`: `explicit` | `inferred` | `speculative`
- `ambiguity_tags`: from `underspecified`, `conflicting_signals`, `assumption`, `scope_creep`, `convention`
- `task_grounding`: one sentence connecting group to task
- `file_refs`: files with `path`, `ranges`, `view_hint`
- `annotations`: `judgment_call`, `note`, or `flag` entries

Mark reconstructed groups with annotation: type `note`, body `"Reconstructed post-hoc, not declared by the implementing agent."`

**Constraints:**
- Each file in exactly one group; every changed line covered
- Max ~8 groups (merge least important); <=3 files = single group

Save the reconstructed ACB to the store:
```bash
PYTHONPATH="$PLUGIN_DIR" python3 -c "
import json
from tools.acb.store import open_store
s = open_store('.')
acb = json.load(open('.prove/reconstructed_acb.json'))
s.save_acb('$(git rev-parse --abbrev-ref HEAD)', acb)
s.close()
"
```

Build ACB with `acb_version: "0.2"`, `change_set_ref` (base/head SHAs), `task_statement`, `intent_groups`, `negative_space`, `open_questions`, `uncovered_files`, `generated_at` (ISO), `agent_id: "prove-review"`, `manifest_count`.

## Phase 3: Build Task Statement

Construct `task_statement.turns` (role `user`) from:
1. Active run's `prd.json` + `plan.json` (`scripts/prove-run show prd` / `show plan`)
2. Fall back to `git log <base>..HEAD`

## Phase 4: Launch Review UI

```bash
PYTHONPATH="$PLUGIN_DIR" python3 -m tools.acb serve --base <base>
```

Open the printed URL in the browser (`open <url>`). Tell the user the review is available. Review state auto-saves to the SQLite store.

## Phase 5: Present Summary

Output after launch:
- Files changed, insertions/deletions
- Intent group count (manifests vs reconstruction)
- Group titles with classification badges
- Uncovered files or open questions
- Review URL
