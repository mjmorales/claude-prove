# Passive Triggers & Opt-In Unattended Execution

prove has no resident process — nothing fires on its own. A "trigger" is realized
through one of three mechanisms, chosen by scope. The deliberate trade is **zero
operational surface**: there is no autonomous progression between sessions unless you
configure the opt-in driver below.

## The three trigger mechanisms

### 1. Intra-run — the next workflow statement

Inside a single driver session running a `/workflows` script, a trigger is just the next
statement. When a step completes, the script branches directly — a conditional, a bounded
loop, a fan-out — to the next action. No table, no daemon: deterministic control flow
carries the trigger. This is the tightest loop and covers everything that happens within
one run.

### 2. Cross-session — the reconciler surfaces bound next-actions

Across sessions, a status transition's consequence is **surfaced, not auto-executed**, by
the scrum reconciler. A declared trigger table in `.claude/.prove.json` (`triggers[]`) maps
a task status to a bound next-action; the session-start hook consults it and surfaces the
pending actions for every task currently sitting in a triggering status, alongside
`claude-prove scrum next-ready` and `claude-prove scrum alerts`. The next driver sees
"task X reached `accepted` → run decompose" and acts.

```jsonc
"triggers": [
  { "on": "accepted", "workflow": "decompose", "description": "fire the next-layer decompose" },
  { "on": "ready",    "workflow": "orchestrate" }
]
```

The engine records and surfaces; the driver (human or the opt-in driver below) decides and
acts. A binding fires only when a session reconciles — there is no clock evaluating it.

### 3. Opt-in unattended — a driver that drains next-ready hands-off

To progress between sessions without a human at the keyboard, configure a driver that
repeatedly picks up `claude-prove scrum next-ready` and runs the top task's bound
next-action. prove ships no scheduler of its own; both recipes use Claude Code's own
scheduling primitives.

**`/loop` — same machine, while a session stays open:**

```
/loop 30m Drain one ready scrum task: run `claude-prove scrum next-ready`, take the
top task, execute its bound next-action (decompose or orchestrate per its trigger),
mirror status back to scrum, then stop.
```

The loop re-invokes the prompt on the interval; each tick drains one ready task. Bounded by
the session staying open.

**Scheduled remote agent — unattended, recurring:**

```
/schedule daily 09:00 Drain the prove backlog: run `claude-prove scrum next-ready`,
execute the top bound next-action, mirror status back, and report what ran.
```

The schedule creates a cron-driven remote agent that wakes on its own, drains next-ready,
and exits — true hands-off progression.

## The deliberate trade

Without one of the opt-in drivers configured, **nothing progresses between sessions**. A
bound next-action waits in the reconciler's session-start digest and in `next-ready` until a
driver — human or scheduled — picks it up. This is intentional: prove trades autonomous
between-session firing for zero operational surface, with no resident daemon to run, secure,
or monitor. The opt-in driver is the only thing that closes the loop unattended, and you
enable it explicitly.
