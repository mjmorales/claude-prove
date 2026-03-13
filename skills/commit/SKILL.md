---
name: commit
description: Semantic commit assistant that reads .prove.json scopes for valid commit scopes. Analyzes changes, groups into logical units, and creates conventional commits. Use when committing changes to any project that installs this plugin.
---

# Semantic Commit Assistant

Analyze all staged and unstaged changes, group them into logical units, and create semantic commits with scopes derived from `.prove.json` or the directory structure.

## Phase 1: Gather Context

1. Check for `.prove.json` at the project root and read the `"scopes"` key if present
2. Run `git status` to see all modified, added, and deleted files
3. Run `git diff` to see unstaged changes
4. Run `git diff --cached` to see staged changes
5. If there are no changes, inform the user and stop

## Phase 2: Derive Scopes

**If `.prove.json` has a `"scopes"` key**, use it to build the scope list. The scopes object maps scope names to path prefixes:

```json
{
  "scopes": {
    "api": "src/api/",
    "auth": "src/auth/",
    "db": "src/models/"
  }
}
```

When a change spans files under a scope's path prefix, use that scope name. A file matches the scope with the longest matching prefix.

**If no scopes are configured**, derive scopes from the top-level directory of each changed file (e.g., changes in `src/api/handler.go` → scope `api`, changes in `cmd/server/main.go` → scope `server`). Use your best judgment to pick meaningful, concise scope names from the path structure.

Additionally, these built-in scopes are always available regardless of configuration:

- `docs` — README, LICENSE, or other top-level documentation
- `repo` — `.gitignore`, CI/CD, or other repo infrastructure
- `config` — `.prove.json`, project configuration files

## Phase 3: Analyze and Group Changes

Review all changed files and group them into logical commit units based on:

- Feature additions (files that implement a new capability together)
- Bug fixes (files that fix a specific issue)
- Refactoring (files that restructure without changing behavior)
- Configuration changes (build system, project config)
- Documentation updates (README, docs, comments)
- Test additions/modifications
- Dependencies

## Phase 4: Determine Commit Order

Order commits logically:

1. Infrastructure/config changes first
2. Core implementation next
3. Supporting files (scripts, assets)
4. Documentation last

## Phase 5: Create Semantic Commits

For each logical group, create a commit using conventional commit format:

```
<type>(<scope>): <description>

[optional body]

Co-Authored-By: Claude <noreply@anthropic.com>
```

**Types:**
- `feat`: New feature or capability
- `fix`: Bug fix
- `refactor`: Restructuring without behavior change
- `docs`: Documentation only
- `test`: Adding or updating tests
- `chore`: Build process, dependencies, configs
- `style`: Formatting, whitespace (no content change)
- `perf`: Performance improvements
- `ci`: CI/CD changes
- `migrate`: Content migrated from an external source

**Scope:** Derived from `.prove.json` scopes or directory structure.

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
- When grouping is ambiguous and there are 2-4 discrete options, use AskUserQuestion to present the grouping choices; use free-form if the ambiguity needs open-ended explanation
- Never force push or amend existing commits without explicit permission
- Always check `.prove.json` for scopes before committing — do not hardcode scopes

**Interaction patterns**: See `references/interaction-patterns.md` for when to use `AskUserQuestion` vs free-form discussion.
