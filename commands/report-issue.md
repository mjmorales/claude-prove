---
description: Report a bug or feature request against the prove plugin via GitHub CLI
argument-hint: "[bug description or feature request]"
---

# Report Issue: $ARGUMENTS

File a well-formatted GitHub issue against the prove plugin repository using the `gh` CLI.

`$PLUGIN_DIR` refers to this plugin's root (parent of `commands/`).

## Instructions

### Step 0: Verify gh CLI

```bash
gh auth status 2>&1
```

If `gh` is not installed or not authenticated:
- Not installed: "Install the GitHub CLI: https://cli.github.com/ then run `gh auth login`"
- Not authenticated: "Run `gh auth login` to authenticate"

If auth fails, show the appropriate message above and stop. Do not proceed to subsequent steps.

### Step 1: Determine issue type

If `$ARGUMENTS` is provided, infer the type from context. Otherwise, `AskUserQuestion` with header "Issue Type" and options:
- "Bug Report" — something is broken or behaving unexpectedly
- "Feature Request" — a new capability or improvement
- "Documentation" — missing, unclear, or incorrect docs

### Step 2: Gather context

Read the plugin version:
```bash
cat "$PLUGIN_DIR/.claude-plugin/plugin.json" 2>/dev/null | grep version
```

For **bug reports**, collect:
- Plugin version (from Step above)
- What happened vs what was expected
- Steps to reproduce (ask the user if not clear from `$ARGUMENTS`)
- Relevant error output or logs (ask the user)
- Which command/skill was involved

For **feature requests**, collect:
- What the user wants
- Why (the motivation / use case)
- Any ideas for implementation

For **documentation**, collect:
- What is missing or wrong
- Where the user expected to find it

### Step 3: Draft the issue

Compose a GitHub issue using the appropriate template below. Use `AskUserQuestion` with header "Draft" to present it.

**Bug Report template:**

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
2. ...

### Error output
```
<paste if available>
```

### Environment
- OS: <detected>
- Claude Code version: <if known>
~~~

**Feature Request template:**

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

**Documentation template:**

~~~
## Documentation Issue

**Plugin version**: vX.Y.Z

### What's missing or wrong
<description>

### Where I looked
<file or command>
~~~

Options: "Submit" / "Edit" / "Cancel"

On "Edit": let the user modify the draft, then re-present.
On "Cancel": stop.

### Step 4: Determine labels

Map the issue type to GitHub labels:
- Bug Report → `bug`
- Feature Request → `enhancement`
- Documentation → `documentation`

### Step 5: Submit

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

If submission succeeds, present the issue URL and number to the user. If it fails, show the error and suggest checking `gh auth status`.
