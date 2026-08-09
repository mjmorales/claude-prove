---
name: nightshift
description: >
  Enable, disable, or inspect night shift — the operator-opt-in overnight
  driver that drains a milestone's scrum tasks through the merge queue while
  the operator sleeps. Triggers on "night shift", "enable nightshift",
  "run overnight", "work on this overnight", "overnight autopilot",
  "disable nightshift", "nightshift status", "what happened last night".
---

# Nightshift

Operate the night-shift lifecycle: `on` opens a night and arms the cron ticks, `off` tears everything down, `status` reports the night. The tick itself is a separate skill (`nightshift-tick`) that the harness cron invokes — never run the ladder from here.

The engine (`claude-prove nightshift`) owns all mechanical state: night config, heartbeat lease, floor counters, append-only ledger. This skill owns the judgment around enablement — preflight, permissions, cron wiring, and the human-facing summary.

**Arguments**: `on --milestone <m> [--deadline HH:MM] [--task-cap N] [--max-heals N] [--max-parked N]` | `off` | `status`. No arguments → ask which via AskUserQuestion (header "Nightshift", options On / Off / Status).

## on — enable a night

Run the phases in order. A failed phase halts enablement — never arm the cron on a broken preflight.

### Phase 1: Preflight

1. **Milestone has work**: `claude-prove scrum next-ready --milestone <m>` — at least one ready task. Zero ready tasks → report and stop; there is nothing to drain.
2. **Landing path exists**: `gh auth status` succeeds and the repo landing flow is available (a merge-queue/auto-merge path onto the default branch — e.g. the repo's landing skill or `gh pr merge --auto`). No landing path → stop; night shift lands autonomously or not at all.
3. **Reporters cover night events**: `.claude/.prove.json` `reporters` should match at least `nightshift-enabled`, `task-landed`, `heal-attempt`, `task-parked`, `trunk-red`, `halted`, `morning-digest` — the full set the tick dispatches. Missing → warn the operator that the night will run silent, and offer `/prove:notify setup` first (AskUserQuestion: Continue silent / Set up reporters). One Slack thread per night is the reporter script's job: a night reporter script should persist its `thread_ts` under `.prove/nightshift/slack-thread.json`, post the `nightshift-enabled` message as the thread opener, and reply in-thread for every later event.
4. **Clean working tree** on the default branch checkout: uncommitted changes → stop and tell the operator; ticks branch from trunk and must never absorb stray local edits.

### Phase 2: Permissions

Invoke the `prep-permissions` skill scoped to the milestone so no tick ever blocks on a permission prompt. Never use `--dangerously-skip-permissions` as a substitute — the scoped allowlist is the floor.

### Phase 3: Open the night

```
claude-prove nightshift enable --milestone <m> [--deadline HH:MM] [--task-cap N] [--max-heals N] [--max-parked N]
```

Exit 1 (a night is already open) → surface the error and stop; the operator decides whether to `off` first.

### Phase 4: Arm the machinery

1. **Cron**: create a harness cron (CronCreate) firing every 10 minutes with prompt `/prove:nightshift-tick`. Write the returned cron id to `.prove/nightshift/cron.json` as `{ "cron_id": "<id>" }` — the tick's teardown step and `off` both read it.
2. **Sleep prevention** (macOS): `nohup caffeinate -i >/dev/null 2>&1 & echo $! > .prove/nightshift/caffeinate.pid`. Tell the operator a closed laptop lid still sleeps the machine — plug in and leave the lid open, or run on a desktop.
3. **Announce**: `PROVE_DETAIL="milestone <m>, <n> ready tasks, deadline <deadline>" claude-prove notify dispatch nightshift-enabled --night`.

### Phase 5: Report

One short summary: night id, milestone, ready-task count, deadline, task cap, tick cadence, and where to look in the morning (`/prove:nightshift status`, the Slack thread, and `night-shift`-labeled PRs).

## off — disable the night

1. Delete the cron: read `.prove/nightshift/cron.json`, CronDelete that id, remove the file.
2. Kill caffeinate: `kill $(cat .prove/nightshift/caffeinate.pid) 2>/dev/null; rm -f .prove/nightshift/caffeinate.pid`.
3. Post the digest **before** closing: build it from `claude-prove nightshift ledger` and `claude-prove scrum status` (landed / parked / healed / remaining), then `claude-prove nightshift record morning-digest --detail "<one-line digest>"` and `PROVE_DETAIL="<one-line digest>" claude-prove notify dispatch morning-digest --night` — ledger first, Slack second.
4. Close: `claude-prove nightshift disable --reason "operator off"`.
5. Report the digest to the operator in full: every landed PR, every parked task with its park reason, any trunk-red pause, tokens of note. Parked tasks are the morning's work — list them first.

`off` with no open night → `claude-prove nightshift status` and report; nothing to tear down except a stray cron or caffeinate pid file, which should still be cleaned if present.

## status — inspect

Run `claude-prove nightshift status` and `claude-prove nightshift ledger`. Report: night state (active/halted/closed + halt reason), floors (can_start_task, past_deadline, parked count vs max), lease (holder + freshness — a stale lease with an active night means the last tick died and the next tick will take over), and the ledger timeline. For a closed night, summarize like `off` step 5.

## Rules

- Never run ladder work (implementing tasks, healing PRs) from this skill — that is the tick's job; instead direct the operator to wait for the next tick or invoke `/prove:nightshift-tick` once by hand.
- Never arm the cron without an open night, and never leave a cron armed after `off` — the cron id file is the contract between the two.
- Enablement is per-milestone, per-night, on this machine's checkout. Do not enable for a milestone whose tasks lack acceptance criteria without warning the operator: the tick parks such tasks rather than inventing scope.
