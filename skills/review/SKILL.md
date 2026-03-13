---
name: review
description: >
  Structured branch review that groups changes by semantic concern with VS Code-friendly
  file links. Takes a feature branch diff, analyzes it with LLM, and produces a review
  manifest organized by logical concern instead of alphabetical file order. Use when
  reviewing AI-generated branches or any large feature branch.
argument-hint: "[base-branch (default: main)]"
---

# Structured Branch Review: $ARGUMENTS

Analyze the current branch diff against a base branch, group changes by semantic concern, and produce a review manifest with VS Code-friendly file links.

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

   # Commit log on this branch
   git log --oneline <base>..HEAD
   ```

3. **Handle edge cases**:
   - **Empty diff**: Inform user "No changes between current branch and `<base>`." and stop
   - **Binary files**: Note them in the manifest but skip diff analysis
   - **Renames**: Show as `R: old → new` with similarity percentage

## Phase 2: Semantic Grouping

Analyze the full diff and group files by logical concern. This is the core LLM analysis step.

**Grouping criteria** (in priority order):
1. **Shared purpose** — files that implement the same feature or fix the same bug
2. **Layer alignment** — files at the same architectural layer (data, logic, presentation, config)
3. **Change coupling** — files whose changes reference each other (imports, function calls)

**For each group, determine:**
- **Title**: Short, descriptive name (e.g., "Authentication middleware", "Database schema changes")
- **Intent**: One sentence explaining what this group of changes accomplishes and why
- **Files**: List of files in this group with:
  - Change type: `A` (added), `M` (modified), `D` (deleted), `R` (renamed)
  - Lines added/removed
  - Key changed functions/classes/sections (first changed line number for the file link)
- **Review notes**: Anything the reviewer should pay attention to (breaking changes, security-sensitive code, complex logic)

**Group ordering** (suggested review priority):
1. Configuration and infrastructure changes (build, CI, config files)
2. Data layer (schemas, models, migrations)
3. Core logic (business logic, services, handlers)
4. Interface layer (API endpoints, CLI commands, UI)
5. Supporting files (utilities, helpers)
6. Documentation changes
7. Test files (always last — review the code first, then verify test coverage)

**Rules:**
- A file belongs to exactly one group (no duplicates)
- Groups with a single file are fine — don't force-merge unrelated files
- If the diff is small (<=3 files), use a single group named after the overall change
- Maximum ~8 groups — if more would be needed, merge the least important ones

## Phase 3: Generate Review Manifest

Create `.prove/reviews/review-manifest.md` (overwrite if exists):

```markdown
# Review Manifest: <branch-name>

**Base**: <base-branch>
**Branch**: <current-branch>
**Commits**: <count>
**Files changed**: <count> | **+<insertions>** / **-<deletions>**

## Review Order

<For each group, numbered by suggested review order:>

### 1. <Group Title>

> <Intent — one sentence explaining what these changes do and why>

| File | Change | Lines | Key Changes |
|------|--------|-------|-------------|
| `path/to/file.ext:42` | M | +15 / -3 | `functionName`, `ClassName` |
| `path/to/new_file.ext:1` | A | +80 | New: `MainHandler` |

<Review notes if any — security concerns, breaking changes, complex logic>

### 2. <Next Group Title>
...

## Quick Commands

​```bash
# View full diff
git diff <base>...<branch>

# View changes per commit
git log --oneline -p <base>..HEAD

# View specific group (example files)
git diff <base>...HEAD -- path/to/file1 path/to/file2
​```

## Files Not Grouped

<List any binary files, generated files, or files excluded from semantic analysis>
```

## Phase 4: Present Results

1. Output a compact summary to the user:
   - Total files, insertions/deletions
   - Number of review groups
   - List of group titles in review order
2. Tell the user where the manifest is: `.prove/reviews/review-manifest.md`
3. Suggest opening the manifest in VS Code: the `file:line` links are clickable in the editor terminal

## Rules

- **Read-only with respect to project code** — this skill only reads diffs and writes the manifest
- **Deterministic grouping** — given the same diff, grouping should be consistent
- **No validation** — this is review organization, not testing or linting
- **Overwrite manifest** — each run replaces the previous manifest (one review at a time)
- **Respect .gitignore** — don't include ignored files even if they show in diff

**Interaction patterns**: See `references/interaction-patterns.md` for when to use `AskUserQuestion` vs free-form discussion.
