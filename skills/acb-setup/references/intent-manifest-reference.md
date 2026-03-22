# ACB Intent Manifest Reference

## When to write a manifest

Before every `git commit` on a non-trunk branch, write `.acb/intents/staged.json`.
Commits on the trunk branch (configured in .acb/config.json) skip this requirement.
Merge commits also skip automatically.

## Manifest structure

```json
{
  "acb_manifest_version": "0.1",
  "commit_sha": "pending",
  "timestamp": "<ISO 8601 now>",
  "intent_groups": [
    {
      "id": "<slug>",
      "title": "<what this change does>",
      "classification": "explicit | inferred | speculative",
      "ambiguity_tags": [],
      "task_grounding": "<why, traced to the task>",
      "file_refs": [
        {
          "path": "<file relative to repo root>",
          "ranges": ["<N>", "<N-M>"],
          "view_hint": "changed_region"
        }
      ]
    }
  ]
}
```

## Field guide

| Field | Required | Description |
|-------|----------|-------------|
| acb_manifest_version | yes | Always "0.1" |
| commit_sha | yes | Set to "pending" -- post-commit hook fills in the real SHA |
| timestamp | yes | ISO 8601 timestamp of when the manifest was written |
| intent_groups | yes | Non-empty array of intent groups |
| id | yes | Unique slug per group (e.g., "auth-validation") |
| title | yes | Short description of what this group of changes does |
| classification | yes | "explicit" (directly requested), "inferred" (logically follows), or "speculative" (agent judgment call) |
| ambiguity_tags | yes | Array of: "underspecified", "conflicting_signals", "assumption", "scope_creep", "convention". Empty array if none. "scope_creep" only valid on "speculative" groups. |
| task_grounding | yes | One sentence connecting this change to the task/requirement |
| file_refs | yes | Files changed in this group with line ranges |
| path | yes | File path relative to repo root |
| ranges | yes | Array of line numbers ("15") or ranges ("15-28") |
| view_hint | no | "changed_region" (default), "full_file", "surrounding_context" |
| annotations | no | Array of { "type": "judgment_call" | "note" | "flag", "body": "..." } |
| negative_space | no | Files intentionally not changed, with reason |
| open_questions | no | Ambiguities for the reviewer to weigh in on |

## Classification guide

- **explicit**: The task/requirements directly asked for this change
- **inferred**: Not directly asked for, but logically necessary (e.g., updating imports after a rename)
- **speculative**: Agent's judgment call -- not required but believed to be beneficial. Use ambiguity_tags to flag why.

## Grouping rules

- One file belongs to exactly one intent group per commit
- Every changed file must appear in a group's file_refs
- Small commits (<=3 files) can use a single group
- Group by shared purpose, not by file type
- Maximum ~8 groups -- merge less important ones if needed

## Bypassing

- Humans: git commit --no-verify
- Agents: set ACB_SKIP_MANIFEST=1 environment variable
- Trunk branch commits skip automatically

## Post-commit flow

After a successful commit:
1. staged.json is renamed to <short-sha>.json
2. commit_sha is updated with the real SHA
3. All manifests are assembled into .acb/review.acb.json

## Worktrees

In git worktrees, .acb/intents/ is automatically symlinked to the main repo
via the post-checkout hook. Agents write staged.json normally -- it appears
in the main repo's filesystem.
