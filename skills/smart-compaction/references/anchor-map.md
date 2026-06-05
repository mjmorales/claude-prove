# Anchor Map

Which prove primitive durably anchors each kind of session context, and how to
write and re-read it across a compaction. Litmus test: *would a freshly
reoriented agent need this to resume?* If yes, it must live in a durable
anchor before compaction — never only in conversation.

| Context kind | Durable anchor | Write (pre-compact) | Read (rehydrate) |
|---|---|---|---|
| Actionable work, follow-ups | scrum task | `claude-prove scrum task create` | `claude-prove scrum status` / `next-ready` |
| Decision + rationale + rejected alternatives | scrum decision | `claude-prove scrum decision record` | `claude-prove scrum decision list` |
| Blocker on in-flight work | task status `blocked` | `claude-prove scrum task status <id> blocked` | `claude-prove scrum alerts` |
| Orchestrator progress (steps, verdicts) | run-state | written by the orchestrator as it runs | `claude-prove run-state current` / `show` |
| Commit-level change intent | ACB manifest | automatic on commit (`acb hook post-commit`) | `claude-prove acb assemble` |
| Code navigation, routing hints | CAFI index | `/prove:index` after significant changes | `claude-prove cafi context` / `lookup` |
| Uncommitted in-flight edits | git working tree + anchor file list | commit if coherent; else list paths in `.prove/compact-anchors.md` | `git status` + re-read listed paths |
| Session-volatile next action, gotchas | `.prove/compact-anchors.md` | `anchor` subcommand | `rehydrate` subcommand (read + delete) |
| Full cross-session serialization | `.prove/handoff.md` | `/prove:task handoff` — not this skill | `/prove:task pickup` |

## What NOT to Anchor

- Anything derivable from git history, the scrum store, or run artifacts —
  anchors point at state; they never copy it.
- Transient exploration that resolved into a committed change or a recorded
  decision — the resolution is the anchor; the path to it can be dropped.
- File contents — paths plus a one-line why, always.
