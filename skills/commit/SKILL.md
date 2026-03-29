---
name: commit
description: Semantic commit assistant that reads .claude/.prove.json scopes for valid commit scopes. Analyzes changes, groups into logical units, and creates conventional commits. Use when committing changes to any project that installs this plugin.
---

# Semantic Commit Assistant

Analyze all staged and unstaged changes, group them into logical units, and create semantic commits with scopes derived from `.claude/.prove.json` or the directory structure.

## Phase 1: Gather Context

1. Check for `.claude/.prove.json` at the project root and read the `"scopes"` key if present
2. Run `git status` to see all modified, added, and deleted files
3. Run `git diff` to see unstaged changes
4. Run `git diff --cached` to see staged changes
5. If there are no changes, inform the user and stop

## Phase 2: Derive Scopes

**If `.claude/.prove.json` has a `"scopes"` key**, use it to build the scope list. The scopes object maps scope names to path prefixes:

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
- `config` — `.claude/.prove.json`, project configuration files

## Phase 3: Analyze, Group, and Order Changes

Review all changed files and group them into logical commit units — one per coherent change. Each group maps to one conventional commit type. When a single file belongs to multiple logical changes, assign it to the primary purpose.

When grouping is ambiguous and there are 2-4 discrete options, use `AskUserQuestion` to present the choices; use free-form if the ambiguity needs open-ended explanation. See `references/interaction-patterns.md` for guidance.

## Phase 4: Create Semantic Commits

For each logical group, create a commit using conventional commit format:

```
<type>(<scope>): <description>

[optional body]

Co-Authored-By: Claude <noreply@anthropic.com>
```

Use standard conventional commit types (`feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `style`, `perf`, `ci`), plus:
- `migrate`: Content migrated from an external source

**Scope:** Derived from Phase 2.

## Phase 5: Execute Commits

For each group:

1. Stage only the files for that logical unit: `git add <files>`
2. Create the commit with the semantic message
3. Verify with `git status` before moving to the next group

After all commits, run `git log --oneline -n <count>` and report any remaining uncommitted changes.

## Rules

- Never force push or amend existing commits without explicit permission
- Never hardcode scopes — always derive from `.claude/.prove.json` or directory structure
