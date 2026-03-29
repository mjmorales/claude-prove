---
name: review
description: >
  Assemble per-commit intent manifests into a review document. Launch the
  browser-based review UI for structured accept/reject per intent group.
  Falls back to LLM reconstruction when manifests are missing.
argument-hint: "[base-branch (default: main)]"
---

# Review: $ARGUMENTS

Assemble intent manifests and launch the review UI. When manifests are missing, reconstruct intent groups from the diff.

`$PLUGIN_DIR` refers to this plugin's root.

## Phase 1: Extract Diff Context

1. **Determine base branch**
   - If `$ARGUMENTS` is provided, use it as the base branch
   - Otherwise, default to `main`
   - Verify the base branch exists: `git rev-parse --verify <base>`
   - If not found, try `master`, then halt with an error

2. **Gather diff data** (run in parallel):
   ```bash
   git diff --stat <base>...HEAD
   git diff --name-status <base>...HEAD
   git log --oneline <base>..HEAD
   git rev-parse <base>
   git rev-parse HEAD
   ```

3. **Handle edge cases**:
   - **Empty diff**: Print "No changes between current branch and `<base>`." and stop
   - **Binary files**: Exclude from intent groups
   - **Generated files** (dist/, build/, lock files): Exclude from intent groups

## Phase 2: Assemble or Reconstruct

Check for per-commit intent manifests:

```bash
ls .prove/intents/*.json 2>/dev/null
```

### Path A: Manifests exist

Run the assembler:

```bash
PYTHONPATH="$PLUGIN_DIR" python3 -m tools.acb assemble \
  --intents-dir .prove/intents \
  --base <base> \
  --output-dir .prove/reviews
```

The assembler merges manifests, detects uncovered files, and writes the ACB to `.prove/reviews/<branch-slug>.acb.json`.

If there are **uncovered files** (changed but not declared in any manifest), proceed to Path B for just those files and merge the results.

### Path B: Reconstruction fallback

When no manifests exist, or for files not covered by manifests, reconstruct intent groups from the diff.

**Grouping criteria** (priority order):
1. Shared purpose — files implementing the same feature or fix
2. Layer alignment — files at the same architectural layer
3. Change coupling — files whose changes reference each other

**For each intent group, determine:**
- `id`: Unique slug (e.g., `auth-middleware`)
- `title`: Short descriptive name
- `classification`: `explicit` | `inferred` | `speculative`
- `ambiguity_tags`: From `underspecified`, `conflicting_signals`, `assumption`, `scope_creep`, `convention`
- `task_grounding`: One sentence connecting this group to the task
- `file_refs`: Files with `path`, `ranges`, `view_hint`
- `annotations`: `judgment_call`, `note`, or `flag` entries

**Mark reconstructed groups** with an annotation: type `note`, body `"Reconstructed post-hoc, not declared by the implementing agent."`

**Rules:**
- Each file belongs to exactly one group
- Every changed line must be covered
- Maximum ~8 groups — merge least important if needed
- If diff is small (<=3 files), use a single group

Write the ACB document to `.prove/reviews/<branch-slug>.acb.json`:

```json
{
  "acb_version": "0.2",
  "id": "<uuid>",
  "change_set_ref": { "base_ref": "<sha>", "head_ref": "<sha>" },
  "task_statement": { "turns": [...] },
  "intent_groups": [...],
  "negative_space": [...],
  "open_questions": [...],
  "uncovered_files": [],
  "generated_at": "<ISO timestamp>",
  "agent_id": "prove-review",
  "manifest_count": 0
}
```

## Phase 3: Build Task Statement

Construct `task_statement` from available context:
1. Check for `.prove/PRD.md` or `.prove/TASK_PLAN.md`
2. Fall back to `git log <base>..HEAD`
3. Build `turns` array with role `user` and the context

## Phase 4: Launch Review UI

Start the review server:

```bash
PYTHONPATH="$PLUGIN_DIR" python3 -m tools.acb serve \
  --acb .prove/reviews/<branch-slug>.acb.json \
  --base <base> \
  --port 0
```

The server prints the URL to stdout. Open it in the user's browser:

```bash
open <url>  # macOS
```

Tell the user the review is available at the URL. The UI supports:
- Expanding intent groups to see files, annotations, and classifications
- Clicking file refs to view diffs
- Accepting, rejecting, or marking groups for discussion
- Adding comments per group
- Progress tracking and overall verdict

Review state is auto-saved to `.prove/reviews/<branch-slug>.review.json`.

## Phase 5: Present Summary

After launching, output a compact summary:
- Total files changed, insertions/deletions
- Number of intent groups
- How many from manifests vs reconstruction
- Group titles with classification badges
- Any uncovered files or open questions
- The review URL

## Rules

- **Read-only** — only read diffs and write the ACB/review; never modify project code
- **No validation** — this is review organization, not testing or linting
- **Respect .gitignore** — exclude ignored files
