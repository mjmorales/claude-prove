# Agent Change Brief (ACB)

Agent Change Brief (ACB) is a structured review system for AI-generated code. When an agent writes code, it also declares its intent — what changed, why, and what judgment calls it made. That declaration is organized into a reviewable document so you can evaluate the agent's reasoning, not just its output.

## Overview

Git diffs show you what changed. They don't tell you why a particular function was written a certain way, what the agent considered but decided against, or whether a change was directly requested or a judgment call the agent made on its own.

ACB solves this by requiring agents to produce an **intent manifest** before each commit. These manifests are assembled into a single **ACB Document** (`.acb.json`) that reorganizes the change set by declared intent. A companion VS Code extension lets you review that document group by group — accepting, rejecting, or flagging for discussion — without having to reverse-engineer intent from the diff.

The result is a structured handoff between agent and human: the agent explains itself in machine-readable form, and you respond with structured verdicts that feed back into the agent's next action.

## How It Works

```markdown
1. Agent stages changes
       |
2. Agent writes .acb/intents/staged.json (intent manifest)
       |
3. git commit runs
       |
4. pre-commit hook validates staged.json -- rejects if missing or malformed
       |
5. Commit succeeds
       |
6. post-commit hook finalizes manifest -> renames to <sha>.json
   post-commit hook runs progressive assembly -> .acb/review.acb.json
       |
7. Human opens review.acb.json in VS Code
       |
8. ACB extension displays intent groups with diffs
   Human accepts / rejects / flags groups
   Verdicts saved to .acb-review.json
       |
9. /prove:resolve  -- all accepted, branch ready to merge
   /prove:fix      -- agent receives structured fix prompt for rejected groups
   /prove:discuss  -- interactive discussion about flagged groups
```

The assembled ACB Document (`.acb/review.acb.json`) is kept up to date after every commit. The reviewer can open it at any point during the agent's work — they don't have to wait for the agent to finish.

## Setup

### With the prove plugin (recommended)

Run `/prove:acb-setup` in any Claude Code session. The skill detects your current state (no hooks, copy mode, link mode) and brings you to a working installation.

```bash
/prove:acb-setup
```

For a health check on an existing installation:

```bash
/prove:acb-setup doctor
```

For the agent-facing manifest reference:

```bahs
/prove:acb-setup info
```

### Manual setup

```bash
npx acb-review install --link
```

Use `--link` for all new installs. Link mode sets `git config core.hooksPath` to the package's hooks directory — hooks update automatically when the package updates, and they work across git worktrees without any additional setup.

To also scaffold the Claude Code slash commands (`/prove:resolve`, `/prove:fix`, `/prove:discuss`):

```bash
npx acb-review install --link --framework claudecode
```

### What install creates

| Path | Purpose |
| --- | --- |
| `.acb/intents/` | Working directory for per-commit manifests. Gitignored. |
| `.acb/.gitignore` | Ensures `intents/` is never committed. |
| `.acb/config.json` | Project config. Set `trunk_branch` to skip enforcement on main. |
| `git config core.hooksPath` | Points to the package's hooks directory (link mode). |

## Intent Manifests

An intent manifest is a JSON file the agent writes to `.acb/intents/staged.json` before each commit. It declares the intent behind the staged changes.

Manifests are ephemeral — they live in a gitignored directory and are never committed. The assembled ACB Document is the persistent artifact.

### Structure

```json
{
  "acb_manifest_version": "0.1",
  "commit_sha": "pending",
  "timestamp": "2026-03-20T14:30:00Z",
  "intent_groups": [
    {
      "id": "add-username-validation",
      "title": "Reject empty usernames in login handler",
      "classification": "explicit",
      "ambiguity_tags": [],
      "task_grounding": "Task directly requests: 'Add input validation to the login endpoint.'",
      "file_refs": [
        {
          "path": "src/auth/login.go",
          "ranges": ["15-28"],
          "view_hint": "changed_region"
        }
      ]
    }
  ],
  "negative_space": [
    {
      "path": "src/auth/signup.go",
      "reason": "out_of_scope",
      "explanation": "Signup has similar validation gaps but the task targets login only."
    }
  ]
}
```

Always set `commit_sha` to `"pending"` — the post-commit hook fills in the real SHA.

### Intent groups

Each intent group names a set of related changes and explains why they were made.

| Field | Required | Description |
| --- | --- | --- |
| `id` | Yes | Unique slug within the manifest (e.g., `"auth-validation"`) |
| `title` | Yes | Human-readable purpose, under 120 characters |
| `classification` | Yes | `"explicit"`, `"inferred"`, or `"speculative"` |
| `ambiguity_tags` | Yes | Array of uncertainty tags. May be empty (`[]`). |
| `task_grounding` | Yes | Why this change was made, traced to the task |
| `file_refs` | Yes | Files changed in this group, with line ranges |
| `annotations` | No | Agent reasoning: `judgment_call`, `note`, or `flag` |
| `causal_links` | No | Links to other groups this one caused or necessitated |

### Classification

| Value | Use when |
| --- | --- |
| `explicit` | The task directly asked for this change. Quote or reference the task. |
| `inferred` | Not directly asked for, but logically necessary (updating imports after a rename, adding a test for new functionality). Explain the chain. |
| `speculative` | Agent judgment call — not required by the task but believed to be beneficial. Requires explanation and typically ambiguity tags. |

### Ambiguity tags

Tags communicate the type of uncertainty the agent navigated. Reviewers use them to direct attention.

| Tag | Meaning |
| --- | --- |
| `underspecified` | Task required a concrete decision but gave no direction |
| `conflicting_signals` | Task pointed in two directions; agent picked one |
| `assumption` | Agent relied on an unstated constraint |
| `scope_creep` | Change goes beyond task scope. Only valid on `speculative` groups. |
| `convention` | Agent followed a convention with no task grounding |

### Annotations

| Type | Use for |
| --- | --- |
| `judgment_call` | A non-trivial decision. Must state alternatives considered. Requires non-empty `ambiguity_tags`. |
| `note` | Factual context the reviewer would otherwise have to reconstruct. |
| `flag` | A quality concern, deviation, or code smell. Informational. |

### Negative space

List files the agent examined but deliberately did not change. This prevents the reviewer from wondering why a related file wasn't touched.

```json
{
  "path": "src/auth/signup.go",
  "reason": "out_of_scope",
  "explanation": "Signup has similar validation gaps but the task targets login only."
}
```

Valid reasons: `out_of_scope`, `possible_other_callers`, `intentionally_preserved`, `would_require_escalation`.

### Open questions

Flag decisions the agent could not resolve without human input:

```json
{
  "id": "oq-error-format",
  "question": "Should validation errors use the existing ValidationError type or a new LoginError type?",
  "context": "The codebase has ValidationError in src/errors. Login-specific errors may warrant a distinct type.",
  "default_behavior": "Used ValidationError to minimize new types. Will refactor if directed.",
  "related_group_ids": ["auth-validation"]
}
```

## Git Hooks

Three hooks work together. All are thin shell wrappers that delegate to the `acb-review` CLI — the logic lives in TypeScript, not in the hook scripts.

| Hook | Trigger | What it does |
| --- | --- | --- |
| **pre-commit** | Before every commit | Validates `.acb/intents/staged.json`. Rejects the commit if the file is missing, malformed, or has an empty `intent_groups` array. Prints the required manifest format on failure. |
| **post-commit** | After a successful commit | Renames `staged.json` to `<short-sha>.json`, fills in the real commit SHA, then runs progressive assembly to rebuild `.acb/review.acb.json`. |
| **post-checkout** | After a branch checkout | In git worktrees: symlinks the worktree's `.acb/intents/` to the main repo's `.acb/intents/` so agents write manifests to a shared location. |

The pre-commit hook skips enforcement automatically for: trunk branch commits, merge commits, amending commits, and when `ACB_SKIP_MANIFEST=1` is set. Humans can always bypass with `git commit --no-verify`.

### Configuration

`.acb/config.json` tells the pre-commit hook which branch to treat as trunk:

```json
{
  "trunk_branch": "main"
}
```

If this file doesn't exist, the hook defaults to `main`. Commits on the trunk branch never require a manifest.

### Link mode vs copy mode

Link mode (`--link`) is recommended for all installs.

| | Link mode | Copy mode |
| --- | --- | --- |
| Hook updates | Automatic | Manual reinstall required |
| Worktree support | Shared via `core.hooksPath` | Each worktree needs its own copy |
| New hooks | Picked up automatically | Require explicit reinstall |

If you have ACB installed in copy mode, migrate with:

```bash
npx acb-review uninstall
npx acb-review install --link
```

For detailed hook behavior and troubleshooting, see [Hook System Guide](../packages/acb-core/docs/acb-hooks-guide.md).

## Reviewing with VS Code

The `acb-vscode` extension adds a custom editor for `.acb.json` files. Open the assembled ACB Document to start the review:

```bash
code .acb/review.acb.json
```

The extension displays the change set reorganized by intent group. For each group you can:

- Read the agent's `task_grounding`, annotations, and ambiguity tags
- View the diff for the files in that group ("Show Changes")
- Navigate to the referenced file and line ranges
- Set a verdict: **Accepted**, **Rejected**, or **Needs Discussion**
- Add a comment explaining your verdict

Verdicts are saved to `.acb-review.json` alongside the ACB Document.

Open questions appear at the end of the review so you can answer decisions the agent flagged as needing human input.

The review file is linked to the ACB Document by a SHA-256 content hash. If the ACB is regenerated after the review is saved, the extension warns that the review is stale.

## Post-Review Workflow

After completing your review in VS Code, use slash commands to hand results back to the agent.

### `/prove:resolve`

When all groups are accepted and you're ready to merge:

```bash
/prove:resolve
```

Generates an approval summary: accepted group count, any annotation responses you provided, your overall comment, and a statement that the branch is ready to merge.

### `/prove:fix`

When you've rejected one or more groups:

```bash
/prove:fix
```

Generates a structured fix prompt the agent acts on directly. The prompt lists rejected groups with your comments, the agent's original grounding, and file refs. Accepted groups are marked "no changes needed — do not modify." The agent fixes only the rejected groups and commits with new intent manifests. The ACB is progressively reassembled on each new commit.

### `/prove:discuss`

When groups are marked "Needs Discussion":

```bash
/prove:discuss
```

Generates a discussion prompt covering flagged groups, open questions with the agent's default behavior, and reviewer comments. Use this to work through ambiguities interactively before deciding whether to accept or reject.

## Commands Reference

| Command | When to use |
| --- | --- |
| `/prove:acb-setup` | First-time setup or repair of ACB hooks |
| `/prove:acb-setup doctor` | Check health of an existing installation |
| `/prove:acb-setup info` | Print the agent manifest reference |
| `/prove:review [base]` | Generate an ACB from the current branch diff |
| `/prove:resolve` | After review: all accepted, generate merge summary |
| `/prove:fix` | After review: rejected groups, generate fix prompt |
| `/prove:discuss` | After review: flagged groups, start discussion |

## Further Reading

- [ACB Protocol Specification (v0.3)](../specs/agent-change-brief.spec.md)
- [Hook System Guide](../packages/acb-core/docs/acb-hooks-guide.md)
- [Agent Intent Contract](../packages/acb-core/docs/agent-intent-contract.md)
- [Claude Code Setup Guide](../packages/acb-core/docs/claude-code-setup.md)
