---
name: review
description: >
  Generate an Agent Change Brief (ACB) from the current branch diff. Groups changes by
  semantic intent, produces a .acb.json document, and opens it for review in the ACB
  VS Code extension. Use when reviewing AI-generated branches or any large feature branch.
argument-hint: "[base-branch (default: main)]"
---

# ACB Branch Review: $ARGUMENTS

Generate an Agent Change Brief from the current branch diff. Groups changes by declared intent, produces a structured `.acb.json`, and directs the user to open it in the ACB review extension.

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

   # Full diff (for semantic analysis)
   git diff <base>...HEAD

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

## Phase 2: Semantic Grouping into Intent Groups

Analyze the full diff and create intent groups. This is the core LLM analysis step — the same analysis the old review manifest did, but now structured as ACB intent groups.

**Grouping criteria** (in priority order):
1. **Shared purpose** — files that implement the same feature or fix the same bug
2. **Layer alignment** — files at the same architectural layer (data, logic, presentation, config)
3. **Change coupling** — files whose changes reference each other (imports, function calls)

**For each intent group, determine:**

- **`id`**: Unique slug (e.g., `auth-middleware`, `schema-changes`)
- **`title`**: Short, descriptive name (e.g., "Authentication middleware", "Database schema changes")
- **`classification`**: One of:
  - `explicit` — directly requested by the task/user
  - `inferred` — logically follows from the task but not explicitly stated
  - `speculative` — went beyond what was asked (cleanup, refactoring, etc.)
- **`ambiguity_tags`**: Any applicable tags from: `underspecified`, `conflicting_signals`, `assumption`, `scope_creep`, `convention`
- **`task_grounding`**: One sentence explaining how this group connects to the task/branch purpose
- **`file_refs`**: List of files with:
  - `path`: Relative file path
  - `ranges`: Line ranges from the diff (parsed from `@@ +start,count @@` hunks)
  - `view_hint`: `changed_region` (default for most files), `full_file` (for new/deleted files or config), `context` (referenced but unchanged files)
- **`annotations`** (optional): Add when there's something notable:
  - `judgment_call` — a non-trivial decision was made; state alternatives
  - `note` — factual context the reviewer would need to reconstruct
  - `flag` — quality concern, deviation, or code smell
- **`causal_links`** (optional): References to other groups this depends on

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
- **Deterministic grouping** — given the same diff, grouping should be consistent
- **No validation** — this is review organization, not testing or linting
- **Overwrite ACB** — each run replaces the previous ACB for this branch
- **Respect .gitignore** — don't include ignored files even if they show in diff
- **Valid ACB** — the output must be a valid ACB document per the spec

**Interaction patterns**: See `references/interaction-patterns.md` for when to use `AskUserQuestion` vs free-form discussion.
