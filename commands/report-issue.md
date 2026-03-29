---
description: Report a bug or feature request against the prove plugin via GitHub CLI
argument-hint: "[bug description or feature request]"
---

# Report Issue: $ARGUMENTS

File a GitHub issue against the prove plugin using `gh` CLI.

## Step 0: Verify gh CLI

```bash
gh auth status 2>&1
```

If not installed: "Install the GitHub CLI: https://cli.github.com/ then run `gh auth login`"
If not authenticated: "Run `gh auth login` to authenticate"

Stop on auth failure.

## Step 1: Determine issue type

If `$ARGUMENTS` is provided, infer type from context. Otherwise, `AskUserQuestion` (header: "Issue Type"):
- "Bug Report" — something is broken or behaving unexpectedly
- "Feature Request" — a new capability or improvement
- "Documentation" — missing, unclear, or incorrect docs

## Step 2: Gather context

Read the plugin version:
```bash
cat "$PLUGIN_DIR/.claude-plugin/plugin.json" 2>/dev/null | grep version
```

**Bug reports**: plugin version, actual vs expected behavior, reproduction steps, error output, which command/skill. Ask user for anything not clear from `$ARGUMENTS`.

**Feature requests**: what the user wants, motivation/use case, implementation ideas.

**Documentation**: what is missing or wrong, where the user expected to find it.

## Step 3: Draft the issue

Compose using the appropriate template. Present via `AskUserQuestion` (header: "Draft").

**Bug Report:**

~~~
## Bug Report

**Plugin version**: vX.Y.Z
**Command/Skill**: /prove:<name>

### What happened
<description>

### Expected behavior
<description>

### Steps to reproduce
1. ...

### Error output
```
<paste if available>
```

### Environment
- OS: <detected>
- Claude Code version: <if known>
~~~

**Feature Request:**

~~~
## Feature Request

**Plugin version**: vX.Y.Z

### What
<description>

### Why
<motivation / use case>

### Proposed approach
<ideas, if any>
~~~

**Documentation:**

~~~
## Documentation Issue

**Plugin version**: vX.Y.Z

### What's missing or wrong
<description>

### Where I looked
<file or command>
~~~

Options: "Submit" / "Edit" / "Cancel"

On "Edit": let user modify, then re-present.
On "Cancel": stop.

## Step 4: Determine labels

- Bug Report -> `bug`
- Feature Request -> `enhancement`
- Documentation -> `documentation`

## Step 5: Submit

```bash
gh issue create --repo mjmorales/claude-prove \
  --title "<concise title>" \
  --body "$(cat <<'EOF'
<composed body from Step 3>

---
*Filed via `/prove:report-issue`*
EOF
)" \
  --label "<label from Step 4>"
```

On success, present the issue URL and number. On failure, show the error and suggest `gh auth status`.
