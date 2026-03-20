# ACB Intent Manifest — Agent Integration Contract

This document defines the contract an LLM agent MUST satisfy when working on non-trunk branches in a repository with ACB hooks installed. Read this before making any commit.

---

## 1. Contract Summary

Before every `git commit` on a non-trunk branch, an agent MUST write a structured JSON manifest to `.acb/intents/staged.json` that declares the intent behind the staged changes. The pre-commit hook validates the manifest and rejects the commit if the file is missing or structurally invalid. After the commit succeeds, the post-commit hook finalizes the manifest, fills in the real commit SHA, and progressively assembles all manifests into `.acb/review.acb.json` for human review. The manifest is the agent's first-party account of what changed and why — it is the mechanism that makes agent-authored code reviewable without requiring a human to reverse-engineer intent from the diff.

---

## 2. When to Write a Manifest

An agent MUST write `.acb/intents/staged.json` before running `git commit` when ALL of the following conditions hold:

- The current branch is **not** the trunk branch (determined by `trunk_branch` in `.acb/config.json` — default is `"main"`)
- There are staged file changes beyond the manifest file itself
- `ACB_SKIP_MANIFEST` is not set to `"1"`
- `ACB_AMENDING` is not set to `"1"`
- `.git/MERGE_HEAD` does not exist (i.e., not a merge commit in progress)

The agent MUST write the manifest, then run `git commit`. The hook reads `staged.json` at commit time. Do not commit the manifest to the repository — it is gitignored by design.

---

## 3. When Manifests Are Skipped

The pre-commit hook skips manifest enforcement automatically in the following conditions. The agent does NOT need to write a manifest in these cases:

| Condition | How it is detected | Notes |
|-----------|-------------------|-------|
| Trunk branch commit | `git rev-parse --abbrev-ref HEAD` matches `trunk_branch` in `.acb/config.json` | Default trunk is `"main"` |
| Merge commit | `.git/MERGE_HEAD` file exists | Git sets this during `git merge` |
| Amending a commit | `ACB_AMENDING=1` environment variable | Set by the post-commit hook to prevent recursion |
| Explicit bypass | `ACB_SKIP_MANIFEST=1` environment variable | For programmatic or emergency bypasses |
| No staged changes | `git diff --cached --name-only` returns empty | Nothing to declare |
| Only the manifest is staged | Staged files equals only `".acb/intents/staged.json"` | Avoids infinite validation loop |

Human operators may also bypass with `git commit --no-verify`. Agents MUST NOT use `--no-verify` unless explicitly instructed.

---

## 4. Manifest Schema

The manifest is a JSON file written to `.acb/intents/staged.json`.

### 4.1 Top-Level Structure

```json
{
  "acb_manifest_version": "0.1",
  "commit_sha": "pending",
  "timestamp": "2026-03-20T14:30:00Z",
  "intent_groups": [ ... ],
  "negative_space": [ ... ],
  "open_questions": [ ... ],
  "agent_id": "claude-sonnet-4-6"
}
```

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `acb_manifest_version` | string | MUST | Always `"0.1"` |
| `commit_sha` | string | MUST | Always `"pending"` — post-commit hook fills in the real SHA |
| `timestamp` | string | MUST | ISO 8601 UTC (e.g., `"2026-03-20T14:30:00Z"`) |
| `intent_groups` | array | MUST | Non-empty. See Section 4.2 |
| `negative_space` | array | MAY | Omit if unused. See Section 4.5 |
| `open_questions` | array | MAY | Omit if unused. See Section 4.6 |
| `agent_id` | string | MAY | Identifier for the producing agent |

### 4.2 Intent Group

Each element of `intent_groups` MUST be an object with this structure:

```json
{
  "id": "auth-validation",
  "title": "Add username validation to login handler",
  "classification": "explicit",
  "ambiguity_tags": [],
  "task_grounding": "Task directly requests: 'Add input validation to the login endpoint.'",
  "file_refs": [
    {
      "path": "src/auth/login.go",
      "ranges": ["15-28"],
      "view_hint": "changed_region"
    }
  ],
  "annotations": [ ... ],
  "causal_links": [ ... ]
}
```

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `id` | string | MUST | Unique slug within this manifest (e.g., `"auth-validation"`) |
| `title` | string | MUST | Human-readable purpose, under 120 characters |
| `classification` | string | MUST | One of: `"explicit"`, `"inferred"`, `"speculative"` |
| `ambiguity_tags` | array | MUST | Array of tag strings. MAY be empty (`[]`). No duplicates. See Section 4.3 |
| `task_grounding` | string | MUST | Non-empty. Explains why this change exists, grounded in the task |
| `file_refs` | array | MUST | Non-empty. See Section 4.4 |
| `annotations` | array | MAY | Omit if unused. See Section 4.7 |
| `causal_links` | array | MAY | Omit if unused. See Section 4.8 |

### 4.3 Ambiguity Tag Values

Valid values for `ambiguity_tags` arrays on intent groups:

| Value | When to use |
|-------|-------------|
| `"underspecified"` | Task required a concrete decision but did not provide the needed information |
| `"conflicting_signals"` | Task contained contradictory direction; agent chose one interpretation |
| `"assumption"` | Agent assumed an unstated constraint not derivable from task or codebase |
| `"scope_creep"` | Change extends beyond task scope. MUST ONLY appear on `"speculative"` groups |
| `"convention"` | Agent followed common practice with no task grounding; `task_grounding` MUST name the convention |

### 4.4 File Reference

Each element of `file_refs` MUST be:

```json
{
  "path": "src/auth/login.go",
  "ranges": ["15-28"],
  "view_hint": "changed_region"
}
```

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `path` | string | MUST | Repo-relative path, forward slashes only (e.g., `"src/auth/login.go"`) |
| `ranges` | array | MUST | Non-empty array of range strings. Format: `"N"` (single line) or `"N-M"` (inclusive). Must start at 1 or higher. In `"N-M"`, N must be <= M |
| `view_hint` | string | MAY | One of: `"changed_region"`, `"full_file"`, `"context"`. Omit if none applies |

Valid range examples: `"15"`, `"15-28"`, `"100-200"`.
Invalid range examples: `"0"`, `"28-15"`, `"15-"`, `"line15"`.

### 4.5 Negative Space Entry

Documents a file the agent examined but deliberately did not change:

```json
{
  "path": "src/auth/signup.go",
  "reason": "out_of_scope",
  "explanation": "Signup has similar validation gaps but the task targets login only.",
  "ranges": ["45-60"]
}
```

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `path` | string | MUST | Repo-relative path |
| `reason` | string | MUST | One of: `"out_of_scope"`, `"possible_other_callers"`, `"intentionally_preserved"`, `"would_require_escalation"` |
| `explanation` | string | MUST | Human-readable reason |
| `ranges` | array | MAY | Line ranges (same format as file refs). If absent, applies to entire file |

### 4.6 Open Question

Flags a decision the agent could not resolve without human input:

```json
{
  "id": "oq-error-format",
  "question": "Should validation errors use the existing ValidationError type or a new LoginError type?",
  "context": "The codebase has ValidationError in src/errors. Login-specific errors may warrant a distinct type.",
  "default_behavior": "Used ValidationError to minimize new types. Will refactor if directed.",
  "related_group_ids": ["auth-validation"],
  "related_paths": ["src/auth/login.go", "src/errors/errors.go"]
}
```

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `id` | string | MUST | Unique within manifest |
| `question` | string | MUST | The specific question needing human input |
| `context` | string | MUST | Background required to answer it |
| `default_behavior` | string | MUST | What the agent implemented in the absence of an answer |
| `related_group_ids` | array | MAY | IDs of related intent groups within this manifest |
| `related_paths` | array | MAY | Related file paths |

### 4.7 Annotation

Surfaces agent reasoning within an intent group:

```json
{
  "id": "ann-regex-choice",
  "type": "judgment_call",
  "body": "Used regex validation instead of len() check. Regex catches whitespace-only usernames. Alternative: simple len(username) > 0.",
  "ambiguity_tags": ["underspecified"],
  "file_refs": [
    { "path": "src/auth/login.go", "ranges": ["18-22"] }
  ]
}
```

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `id` | string | MUST | Unique within manifest |
| `type` | string | MUST | One of: `"judgment_call"`, `"note"`, `"flag"` |
| `body` | string | MUST | Annotation content. For `"judgment_call"`: MUST state alternatives considered |
| `ambiguity_tags` | array | Conditional | MUST be present and non-empty when `type` is `"judgment_call"`. MAY be present for other types |
| `file_refs` | array | MAY | Specific locations this annotation concerns. If absent, applies to whole group |
| `causal_links` | array | MAY | See Section 4.8 |

### 4.8 Causal Link

Expresses that one group caused or necessitated another:

```json
{
  "target_group_id": "update-tests",
  "rationale": "Login handler signature changed; tests must be updated to match."
}
```

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `target_group_id` | string | MUST | The `id` of another group within the same manifest |
| `rationale` | string | MUST | Brief explanation of the causal relationship |

Causal links MUST NOT form cycles. If a genuine circular dependency exists, surface it as an open question instead.

---

## 5. Classification Decision Tree

Determine the classification of each intent group:

```
Did the task directly and unambiguously ask for this specific change?
├── YES → "explicit"
│         task_grounding: quote or reference the specific task statement
│
└── NO → Is this change logically necessary for an explicit change to work correctly?
         (e.g., updating an import after a rename, adding a test for a new function)
         ├── YES → "inferred"
         │         task_grounding: explain the inferential chain
         │         ("Rename required updating all call sites including this one")
         │
         └── NO → "speculative"
                   task_grounding: explain the agent's reasoning
                   Add ambiguity_tags (likely: "scope_creep", "convention", or "assumption")
```

**Examples:**

| Scenario | Classification | Notes |
|----------|---------------|-------|
| Task says "add email validation" and you added email validation | `explicit` | Direct match |
| Task says "rename `getUserById`" and you updated all call sites | `inferred` | Logically necessary consequence |
| Task says "add validation" and you also added a related log statement | `speculative` | Not requested, agent judgment |
| Task says "refactor login" and you also added a lint fix in the same file | `speculative` | Out of stated scope |
| Task says "update the test" and you update the test fixture too | `inferred` | The fixture is required for the test to pass |

---

## 6. Ambiguity Tags — When Each Applies

Ambiguity tags describe the type of uncertainty the agent navigated. Apply them accurately — they guide the reviewer's attention.

| Tag | Apply when | Cannot appear on |
|-----|-----------|-----------------|
| `underspecified` | Task required you to pick a concrete value, format, or behavior but gave no direction | — |
| `conflicting_signals` | Two parts of the task (or task vs existing code conventions) pointed in different directions | — |
| `assumption` | You relied on a constraint that isn't stated in the task and can't be read from the codebase | — |
| `scope_creep` | The change is genuinely outside task scope but you made it anyway | `explicit` or `inferred` groups |
| `convention` | You followed an industry or codebase convention with no task grounding; `task_grounding` MUST name the convention (e.g., "Followed Go error wrapping convention from existing service code") | — |

Tags are additive — a group can carry multiple tags. An empty array (`[]`) is valid and common for `explicit` groups.

**Constraint:** `scope_creep` MUST only appear on groups where `classification` is `"speculative"`. Placing `scope_creep` on an `explicit` or `inferred` group is a schema violation.

---

## 7. File Refs — Paths and Ranges

### Path format

- MUST be relative to the repository root
- MUST use forward slashes regardless of OS
- MUST NOT begin with `./` or `/`

```
// Correct
"path": "src/auth/login.go"
"path": "packages/acb-core/src/parser.ts"

// Wrong
"path": "./src/auth/login.go"
"path": "/home/user/project/src/auth/login.go"
"path": "src\\auth\\login.go"
```

### Range format

Ranges reference line numbers in the **post-change** version of the file (head revision). They are 1-indexed.

- `"15"` — single line 15
- `"15-28"` — lines 15 through 28 inclusive
- Multiple ranges are represented as separate array elements: `["15-28", "45-60"]`

The regex enforced by the parser is: `^[1-9][0-9]*(-[1-9][0-9]*)?$`

This means line `0` is invalid, and ranges like `"28-15"` (inverted) are invalid.

### View hint values

| Value | Use when |
|-------|----------|
| `"changed_region"` | The range contains the changed lines themselves (most common) |
| `"full_file"` | The entire file is relevant context (e.g., a small config file you rewrote) |
| `"context"` | The range provides surrounding context but is not itself changed |

Omit `view_hint` entirely if none of these apply precisely. MUST NOT use values outside this set.

---

## 8. Grouping Rules

An intent group is a named collection of file changes that share a single purpose. Apply these rules when deciding how to partition changes:

- **One file per group per commit.** A single file path MUST NOT appear in more than one group's `file_refs` within the same manifest. If different regions of the same file serve different purposes, they belong to the same group.
- **Every changed file must be covered.** Every file that appears in `git diff --cached --name-only` MUST appear in exactly one group's `file_refs`. No file may be left unaccounted.
- **Group by shared purpose, not by file type.** Don't create a "TypeScript files" group and a "config files" group. Create a "Rename auth handler" group that includes both the TS source and any config that changed because of the rename.
- **Small commits can use a single group.** Commits touching 1–3 files with a unified purpose SHOULD use one group.
- **Maximum ~8 groups.** If you find yourself writing more than 8 groups, consolidate less-important ones. A reviewer cannot meaningfully evaluate 12 separate groups.
- **Foundational changes first.** Order groups so that groups others depend on (via causal links) appear earlier in the array.

---

## 9. Common Mistakes

### Never `git add` the intents directory

```bash
# WRONG — never do this
git add .acb/intents/staged.json
git add -f .acb/intents/

# The intents directory is gitignored by design.
# The pre-commit hook reads it directly from disk — it does not need to be staged.
```

If `.acb/intents/` is accidentally tracked, run `git rm -r --cached .acb/intents/`.

### Always set `commit_sha` to `"pending"`

```json
// WRONG
"commit_sha": "abc1234def"

// CORRECT
"commit_sha": "pending"
```

The post-commit hook fills in the real SHA after the commit succeeds. Writing a SHA manually will be overwritten anyway and risks writing a stale or incorrect value.

### `intent_groups` must not be empty

```json
// WRONG — hook will reject this
"intent_groups": []

// CORRECT — at least one group required
"intent_groups": [
  { "id": "...", ... }
]
```

### `file_refs` must not be empty on any group

```json
// WRONG
{
  "id": "refactor-auth",
  "file_refs": []
}

// CORRECT
{
  "id": "refactor-auth",
  "file_refs": [
    { "path": "src/auth/login.go", "ranges": ["1-45"] }
  ]
}
```

### `ranges` must not be empty on any file ref

```json
// WRONG
{ "path": "src/auth/login.go", "ranges": [] }

// CORRECT
{ "path": "src/auth/login.go", "ranges": ["15-28"] }
```

### `scope_creep` on a non-speculative group

```json
// WRONG — scope_creep is only valid on speculative
{
  "classification": "explicit",
  "ambiguity_tags": ["scope_creep"]
}

// CORRECT
{
  "classification": "speculative",
  "ambiguity_tags": ["scope_creep"]
}
```

### `judgment_call` annotation without `ambiguity_tags`

```json
// WRONG — judgment_call requires ambiguity_tags
{
  "type": "judgment_call",
  "body": "Chose regex over len() check.",
  "ambiguity_tags": []
}

// CORRECT
{
  "type": "judgment_call",
  "body": "Chose regex over len() check. Alternative: simple len(username) > 0.",
  "ambiguity_tags": ["underspecified"]
}
```

---

## 10. Worktree Behavior

In a git worktree, `.acb/intents/` is automatically symlinked to the main repository's `.acb/intents/` directory by the post-checkout hook. The agent does not need to do anything differently:

- Write `staged.json` to `.acb/intents/staged.json` as usual
- The symlink causes it to appear in the main repo's filesystem
- The pre-commit and post-commit hooks work normally

Do not attempt to manually create or manipulate the symlink.

---

## 11. Post-Commit Flow

After a successful commit, the post-commit hook runs automatically:

1. **Reads** `.acb/intents/staged.json`
2. **Updates** `commit_sha` from `"pending"` to the full SHA from `git rev-parse HEAD`
3. **Writes** the updated manifest to `.acb/intents/<short-sha>.json` (e.g., `.acb/intents/9a8b7c6.json`)
4. **Deletes** `.acb/intents/staged.json`
5. **Runs progressive assembly** — reads all `*.json` manifests in `.acb/intents/`, merges them, and writes `.acb/review.acb.json`

The agent does not need to trigger any of this manually. If assembly fails (e.g., malformed existing manifest), the hook prints a warning but does not fail the commit. The agent can manually trigger assembly with:

```bash
npx --prefix $PLUGIN_DIR/packages/acb-core acb-review assemble --output .acb/review.acb.json
```

---

## 12. Minimal Valid Example

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
      "task_grounding": "Task directly requests: 'Add input validation to the login endpoint. Reject empty usernames.'",
      "file_refs": [
        {
          "path": "src/auth/login.go",
          "ranges": ["15-28"],
          "view_hint": "changed_region"
        }
      ]
    }
  ]
}
```

## 13. Common Mistake Example

```json
{
  "acb_manifest_version": "0.1",
  "commit_sha": "abc1234",
  "timestamp": "2026-03-20T14:30:00Z",
  "intent_groups": [
    {
      "id": "changes",
      "title": "Various changes",
      "classification": "explicit",
      "ambiguity_tags": ["scope_creep"],
      "task_grounding": "See task.",
      "file_refs": []
    }
  ]
}
```

Problems:
- `commit_sha` MUST be `"pending"`, not a real SHA
- `scope_creep` MUST NOT appear on `explicit` groups
- `task_grounding` SHOULD trace to specific task content, not just "See task."
- `file_refs` MUST be non-empty

The hook will reject this with validation errors.

---

*Normative reference: `specs/agent-change-brief.spec.md`. Implementation source: `packages/acb-core/src/`.*
