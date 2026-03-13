---
name: commit
description: Semantic commit assistant that reads MANIFEST for valid scopes. Analyzes changes, groups into logical units, and creates conventional commits. Use when committing changes to this plugin or any project that installs it.
---

# Semantic Commit Assistant

Analyze all staged and unstaged changes, group them into logical units, and create semantic commits scoped to items in the MANIFEST.

## Phase 1: Gather Context

1. Read `MANIFEST` from the project root to get valid scopes
2. Run `git status` to see all modified, added, and deleted files
3. Run `git diff` to see unstaged changes
4. Run `git diff --cached` to see staged changes
5. If there are no changes, inform the user and stop

## Phase 2: Derive Scopes

Parse the MANIFEST to build the list of valid scopes. Each `name` column is a valid scope. Additionally, these built-in scopes are always available:

- `plugin` — changes to `.claude-plugin/`, `MANIFEST`, or repo-level config
- `docs` — README, LICENSE, or other top-level documentation
- `repo` — `.gitignore`, CI/CD, or other repo infrastructure

When a change spans files in a MANIFEST item's `path`, use that item's name as the scope. When a change doesn't map to any MANIFEST item, use a built-in scope.

## Phase 3: Analyze and Group Changes

Review all changed files and group them into logical commit units based on:

- Feature additions (files that implement a new capability together)
- Bug fixes (files that fix a specific issue)
- Refactoring (files that restructure without changing behavior)
- Configuration changes (plugin config, build system)
- Documentation updates (README, docs, comments)
- Test additions/modifications
- Dependencies

## Phase 4: Determine Commit Order

Order commits logically:

1. Infrastructure/config changes first (MANIFEST, plugin.json)
2. Core skill or agent content next
3. Supporting files (references, scripts, assets)
4. Documentation last

## Phase 5: Create Semantic Commits

For each logical group, create a commit using conventional commit format:

```
<type>(<scope>): <description>

[optional body]

Co-Authored-By: Claude <noreply@anthropic.com>
```

**Types:**
- `feat`: New feature or skill content
- `fix`: Bug fix
- `refactor`: Restructuring without behavior change
- `docs`: Documentation only
- `test`: Adding or updating tests
- `chore`: Build process, dependencies, configs
- `style`: Formatting, whitespace (no content change)
- `perf`: Performance improvements
- `ci`: CI/CD changes
- `migrate`: Content migrated from an external source

**Scope:** Derived from MANIFEST names or built-in scopes.

## Phase 6: Execute Commits

For each group:

1. Stage only the files for that logical unit: `git add <files>`
2. Create the commit with the semantic message
3. Verify with `git status` before moving to the next group

## Phase 7: Summary

After all commits are created, show:

- List of commits created with their messages
- Any remaining uncommitted changes
- Suggest `git log --oneline -n <count>` to review

## Rules

- Keep commits atomic — each should represent one logical change
- If a single file belongs to multiple logical changes, prioritize the primary purpose
- Ask for clarification if grouping is ambiguous
- Never force push or amend existing commits without explicit permission
- Always read MANIFEST before committing — do not hardcode scopes
