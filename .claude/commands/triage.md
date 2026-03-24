---
description: Triage open GitHub issues — review, label, prioritize, and plan fixes
argument-hint: "[issue number, label filter, or 'all']"
---

# Triage Issues: $ARGUMENTS

Review and triage open issues on the prove plugin repository. This is a project-local command for maintainers — it does not ship with the plugin.

## Instructions

### Step 0: Guard — verify context

1. Verify `gh auth status` succeeds. If not, guide the user to authenticate.
2. This command is for plugin maintainers. All operations target `mjmorales/claude-prove` via `--repo` flag; no local repo check needed.

### Step 1: Fetch issues

If `$ARGUMENTS` is a number, fetch that single issue:
```bash
gh issue view $ARGUMENTS --repo mjmorales/claude-prove --json number,title,body,labels,createdAt,author,comments
```

If `$ARGUMENTS` is a label (e.g., "bug", "enhancement"), filter:
```bash
gh issue list --repo mjmorales/claude-prove --label "$ARGUMENTS" --state open --json number,title,labels,createdAt,author --limit 25
```

Otherwise, fetch all open issues:
```bash
gh issue list --repo mjmorales/claude-prove --state open --json number,title,labels,createdAt,author --limit 25
```

### Step 2: Present overview

Display issues in a table:

```
Open Issues (N total)

#  | Title                              | Labels       | Age  | Author
---|-------------------------------------|-------------|------|--------
12 | /prove:update runs in plugin dir   | bug         | 2d   | user1
11 | Add coding standards reference     | enhancement | 5d   | user2
```

### Step 3: Triage each issue

For each issue (or the single requested issue), read the full body and comments, then assess:

1. **Assess clarity**: Is the issue description clear enough to act on? Are reproduction steps or acceptance criteria present?
2. **Classify severity**:
   - `critical` — blocks core functionality (init, update, orchestrator)
   - `high` — breaks a specific command/skill
   - `medium` — incorrect behavior with workaround
   - `low` — cosmetic, docs, nice-to-have
3. **Security check**: If the issue involves credential exposure, injection, or unauthorized access, apply the `security` label. Do NOT discuss reproduction details in public comments.
4. **Identify affected components**: Which commands, skills, agents, or tools are involved? Use directory names as component labels (e.g., `commands`, `agents`, `tools/cafi`).
5. **Estimate scope**: quick fix (< 30 min), medium task, or needs planning.
6. **Check for duplicates**: Search existing open issues for similar reports before accepting.

Present the assessment via `AskUserQuestion` with header "Triage" for each issue:
- "Accept & Label" — apply labels and priority
- "Request Info" — comment asking for more details
- "Close (Duplicate)" — close with reference to existing issue
- "Close (Won't Fix)" — close with explanation
- "Skip" — move to next issue

### Step 4: Apply triage decisions

**Shell safety**: Always use single-quoted heredocs (`<<'EOF'`) for `--body` and `--comment` arguments to prevent shell expansion of issue content. Never interpolate issue body text directly into command strings.

**Accept & Label:**
```bash
gh issue edit <number> --repo mjmorales/claude-prove --add-label "<severity>,<component>"
```

**Request Info:**
```bash
gh issue comment <number> --repo mjmorales/claude-prove --body "$(cat <<'EOF'
Thanks for reporting this. To help us investigate, could you provide:

<specific questions based on what's missing>

---
*Via `/prove:triage`*
EOF
)"
```

**Close (Duplicate):**
```bash
gh issue close <number> --repo mjmorales/claude-prove --comment "Closing as duplicate of #<existing>. Tracking there."
```

**Close (Won't Fix):**
```bash
gh issue close <number> --repo mjmorales/claude-prove --reason "not planned" --comment "<explanation>"
```

### Step 5: Summary

After all issues are triaged, present:

```
Triage Summary
- Accepted: N issues
- Info requested: N issues
- Closed: N issues
- Skipped: N issues

Next actions:
- #12 (critical/bug): fix plugin dir guard — quick fix
- #11 (medium/enhancement): add coding standards — needs planning
```

Suggest `/prove:task-planner` for issues that need implementation planning.
