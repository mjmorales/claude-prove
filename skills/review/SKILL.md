---
name: review
description: >
  Generate an Agent Change Brief (ACB) from the current branch diff. Assembles per-commit
  intent manifests when available, falls back to LLM analysis for uncovered changes.
  Produces a .acb.json document for review in the ACB VS Code extension.
argument-hint: "[base-branch (default: main)]"
---

# ACB Branch Review: $ARGUMENTS

Generate an Agent Change Brief from the current branch. Prefers assembling from per-commit intent manifests (first-party agent declarations) over post-hoc reconstruction.

## Phase 1: Extract Diff Context

1. **Determine base branch**
   - If `$ARGUMENTS` is provided, use it as the base branch
   - Otherwise, default to `main`
   - Verify the base branch exists: `git rev-parse --verify <base>`
   - If not found, try `master`, then halt with an error

2. **Gather diff data** — run these in parallel:
   ```bash
   # File-level summary
   git diff --stat <base>...HEAD

   # Change types per file
   git diff --name-status <base>...HEAD

   # Changed line ranges per file (unified=0 for precise ranges)
   git diff --unified=0 <base>...HEAD

   # Commit log on this branch
   git log --oneline <base>..HEAD

   # Resolve refs for change_set_ref
   git rev-parse <base>
   git rev-parse HEAD
   ```

3. **Handle edge cases**:
   - **Empty diff**: Inform user "No changes between current branch and `<base>`." and stop
   - **Binary files**: Note them in the ACB's `negative_space` as `out_of_scope`
   - **Generated files** (dist/, build/, lock files): Exclude from intent groups, note in `negative_space`

## Phase 2: Check for Intent Manifests

Look for per-commit intent manifests in `.acb/intents/`:

```bash
ls .acb/intents/*.json 2>/dev/null
```

**If manifests exist**, proceed to Phase 2a (assembly path).
**If no manifests exist**, proceed to Phase 2b (reconstruction fallback).

### Phase 2a: Assemble from Manifests

When intent manifests are present, the implementing agents already declared their intent at commit time. Use the assembler to merge them.

1. Read all `.acb/intents/*.json` files
2. Parse each as an IntentManifest (skip files with parse errors, warn the user)
3. Identify which changed files are **covered** by manifests and which are **uncovered**:
   - For each changed file+range from the diff, check if any manifest's intent groups reference it
   - Uncovered files need reconstruction (Phase 2b) for just those files

4. If all files are covered:
   - The manifests are the complete source of truth
   - Skip Phase 2b entirely
   - Merge manifests: groups with the same `id` across commits get their file_refs combined

5. If some files are uncovered:
   - Assemble covered files from manifests
   - Run Phase 2b reconstruction **only for uncovered files**
   - Merge both sets of intent groups into the final ACB

### Phase 2b: Reconstruct Intent Groups (Fallback)

This is the reconstruction path — used when no manifests exist or to fill gaps for files not covered by any manifest.

Analyze the diff (full diff if no manifests, or just the uncovered portion) and create intent groups.

**Grouping criteria** (in priority order):
1. **Shared purpose** — files that implement the same feature or fix the same bug
2. **Layer alignment** — files at the same architectural layer (data, logic, presentation, config)
3. **Change coupling** — files whose changes reference each other (imports, function calls)

**For each intent group, determine:**

- **`id`**: Unique slug (e.g., `auth-middleware`, `schema-changes`)
- **`title`**: Short, descriptive name
- **`classification`**: One of `explicit`, `inferred`, `speculative`
- **`ambiguity_tags`**: Any applicable tags from: `underspecified`, `conflicting_signals`, `assumption`, `scope_creep`, `convention`
- **`task_grounding`**: One sentence explaining how this group connects to the task/branch purpose
- **`file_refs`**: List of files with `path`, `ranges`, and `view_hint`
- **`annotations`** (optional): `judgment_call`, `note`, or `flag`
- **`causal_links`** (optional): References to other groups this depends on

**Mark reconstructed groups**: When generating groups via reconstruction (not from manifests), add an annotation with type `note` and body: "This intent group was reconstructed post-hoc, not declared by the implementing agent."

**Group ordering** (suggested review priority):
1. Configuration and infrastructure changes
2. Data layer (schemas, models)
3. Core logic (business logic, services)
4. Interface layer (API endpoints, CLI, UI)
5. Supporting files (utilities, helpers)
6. Documentation changes
7. Test files (always last)

**Rules:**
- A file belongs to exactly one intent group (no duplicates)
- Every changed line must be covered by exactly one group's file_refs
- Groups with a single file are fine — don't force-merge unrelated files
- If the diff is small (<=3 files), use a single group
- Maximum ~8 groups — merge the least important ones if needed

## Phase 3: Build Task Statement

Construct the `task_statement` from available context:

1. Read commit messages from `git log <base>..HEAD`
2. Check for `.prove/PRD.md` or `.prove/TASK_PLAN.md` for task context
3. Build `turns` array:
   - If PRD exists: one turn with role `user` containing the PRD summary
   - Otherwise: one turn with role `user` containing the branch name + commit summary

## Phase 4: Generate ACB Document

Construct the full `.acb.json` document:

```json
{
  "acb_version": "0.1",
  "id": "<uuid>",
  "change_set_ref": {
    "base_ref": "<resolved base SHA>",
    "head_ref": "<resolved HEAD SHA>"
  },
  "task_statement": { "turns": [...] },
  "intent_groups": [...],
  "open_questions": [...],
  "negative_space": [...],
  "generated_at": "<ISO timestamp>",
  "agent_id": "prove-review"
}
```

**Open questions**: Add any ambiguities or decisions you'd want the reviewer to weigh in on.

**Negative space**: Add entries for:
- Files that look related but were intentionally not changed (with reason)
- Binary/generated files excluded from grouping

Write the document to `.prove/reviews/<branch-slug>.acb.json` (overwrite if exists).

Validate the document structure before writing — every changed file must appear in exactly one intent group, all required fields present.

## Phase 5: Present Results

1. Output a compact summary:
   - Total files, insertions/deletions
   - Number of intent groups
   - How many groups came from manifests vs reconstruction
   - List of group titles in review order with classification badges
   - Any open questions or flags

2. Tell the user where the ACB is and how to review:
   ```
   ACB written to: .prove/reviews/<branch-slug>.acb.json

   Open in VS Code/Cursor to use the ACB review extension:
     code .prove/reviews/<branch-slug>.acb.json

   The extension shows intent groups with:
   - "Show Changes" to view diffs per group
   - Accept/Reject per intent group
   - Clickable file refs for navigation
   ```

## Rules

- **Read-only with respect to project code** — this skill only reads diffs and writes the ACB
- **Prefer manifests over reconstruction** — first-party agent declarations are always richer than third-party analysis
- **Deterministic grouping** — given the same diff + manifests, output should be consistent
- **No validation** — this is review organization, not testing or linting
- **Overwrite ACB** — each run replaces the previous ACB for this branch
- **Respect .gitignore** — don't include ignored files even if they show in diff
- **Valid ACB** — the output must be a valid ACB document per the spec

**Interaction patterns**: See `references/interaction-patterns.md` for when to use `AskUserQuestion` vs free-form discussion.
