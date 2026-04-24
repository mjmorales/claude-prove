---
description: Agentic task management — backlog, milestones, tags, dep-graph, alerts
argument-hint: "[init|status|next|task|milestone|tag|link|alerts]"
core: true
summary: Operate the scrum store backed by `.prove/prove.db` (tasks, milestones, tags, run-links)
---

# Scrum

Agentic task management on the unified prove store. Tasks, milestones, tags, and run-links live in `.prove/prove.db`; CC-lifecycle hooks reconcile state at task boundaries (not commits). Architecture: `.prove/decisions/2026-04-21-scrum-architecture.md`.

The first token of `$ARGUMENTS` selects the route. No argument → print this routing table and exit.

## Routing

| Arg          | Action                                                                 |
|--------------|------------------------------------------------------------------------|
| `init`       | Run `prove scrum init` — one-shot importer for legacy `planning/*`.    |
| `status`     | Run `prove scrum status --human` — compact text overview.              |
| `next`       | Run `prove scrum next-ready --human` — ranked next tasks.              |
| `alerts`     | Run `prove scrum alerts --human` — stalled WIP + orphan run report.    |
| `task`       | Delegate to `scrum-master` agent — interactive task lifecycle.         |
| `milestone`  | Delegate to `scrum-master` agent — milestone lifecycle.                |
| `tag`        | Delegate to `scrum-master` agent — tag taxonomy edits.                 |
| `link`       | Delegate to `scrum-master` agent — link runs to tasks.                 |

`init`, `status`, `next`, `alerts` are direct CLI passthroughs — execute the bash command, surface output verbatim, exit. Pass any extra `$ARGUMENTS` tokens through (e.g., `/scrum next --limit 5` → `prove scrum next-ready --human --limit 5`; `/scrum alerts --stalled-after-days 14` → `prove scrum alerts --human --stalled-after-days 14`).

For `task`, `milestone`, `tag`, `link`: invoke the `scrum-master` agent with the full `$ARGUMENTS` string as task context. The agent owns interactive flows (AskUserQuestion gates, dep-graph reasoning, status-transition proposals).

## Unrecognized argument

If `$ARGUMENTS` starts with anything outside the table, print the routing table above and stop. Do not guess.
