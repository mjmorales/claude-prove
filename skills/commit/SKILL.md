---
name: commit
description: >
  Semantic commit assistant. Reads scopes from .claude/.prove.json, detects scope
  gaps and offers to register new ones, groups changes into logical units, and
  creates conventional commits.
---

# Semantic Commit Assistant

## Rules

- Never force push or amend existing commits. Instead, create new commits.
- Never hardcode scopes. Instead, derive from `.claude/.prove.json` or directory structure.
- Never ask about a scope the user previously declined. Instead, silently use directory-derived scope.
- Delegate all user decisions through `AskUserQuestion` per `references/interaction-patterns.md`.

## 1. Gather Context

Run in parallel:

1. Read `.claude/.prove.json` -- extract the `"scopes"` key if present
2. `git status`, `git diff`, `git diff --cached`

If no changes exist, inform the user and stop.

## 2. Derive Scopes

**With configured scopes** (`.claude/.prove.json` has `"scopes"`):
Match each changed file to the scope whose path prefix is the longest match.

```json
{ "scopes": { "api": "src/api/", "auth": "src/auth/", "db": "src/models/" } }
```

**Without configured scopes**: derive from the most meaningful path segment (e.g., `src/api/handler.go` -> `api`).

**Built-in scopes** (always available, override nothing):

| Scope | Matches |
|-------|---------|
| `docs` | README, LICENSE, top-level documentation |
| `repo` | `.gitignore`, CI/CD, repo infrastructure |
| `config` | `.claude/.prove.json`, project config files |

## 3. Detect Scope Gaps

Skip if `.claude/.prove.json` has no `"scopes"` key.

If changed files fall outside ALL configured scope prefixes AND do not match a built-in scope:

1. Determine an appropriate scope name and path prefix for the unmatched files
2. Check `~/.claude/projects/*/memory/` for `declined_scope_<name>.md` for this project
3. **Previously declined**: use directory-derived scope silently, proceed to step 4
4. **Not declined**: use `AskUserQuestion`:

```
AskUserQuestion:
  question: "Files under `<path>` don't match any configured scope. Add `<name>: <prefix>` to .claude/.prove.json?"
  header: "New Scope"
  options:
    - label: "Add Scope"
      description: "Register in .claude/.prove.json and use it now"
    - label: "Skip"
      description: "Use directory-derived scope; never ask about this scope again"
```

**Add Scope**: add the entry to `.claude/.prove.json` `"scopes"` and use it for the current commit.

**Skip**: save a memory file at `~/.claude/projects/<project-dir>/memory/declined_scope_<name>.md`:

```markdown
---
name: declined-scope-<name>
description: User declined adding scope "<name>" (<prefix>) to .claude/.prove.json
type: feedback
---

Do not suggest adding scope "<name>" with prefix "<prefix>" to .claude/.prove.json. Declined on <date>.
```

Update `MEMORY.md` in the same directory to include the new entry.

## 4. Group Changes

Group changed files into logical commit units -- one per coherent change. Each group maps to one conventional commit type.

When grouping is ambiguous with 2-4 discrete options, use `AskUserQuestion`. Use free-form for ambiguity that needs open-ended discussion.

## 5. Commit

For each group:

1. `git add <files>` -- stage only files for that group
2. Commit with conventional format:

```
<type>(<scope>): <description>

[optional body]

Co-Authored-By: Claude <noreply@anthropic.com>
```

3. `git status` -- verify before next group

**Types**: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `style`, `perf`, `ci`, `migrate`

After all commits: `git log --oneline -n <count>` and report any remaining uncommitted changes.
