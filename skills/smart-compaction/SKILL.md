---
name: smart-compaction
description: >
  Anchor session context into prove primitives before compaction and rehydrate
  from them after. Built-in compaction summarizes by recency and drops the
  claude-prove state an agent needs to reorient; this skill externalizes
  volatile context into durable anchors (scrum tasks, decisions, run-state,
  a compact-anchors pointer file) pre-compact, then runs a deterministic
  reorientation sequence post-compact. Use before a manual /compact, when
  context is about to auto-compact, or immediately after a compaction.
  Triggers on "smart compact", "prepare for compaction", "anchor before
  compact", "context is getting long", "rehydrate", "reorient after compact".
argument-hint: "[anchor|rehydrate] [note]"
---

# Smart Compaction: $ARGUMENTS

Dispatch on the first token of `$ARGUMENTS`:

| Subcommand | Purpose |
|------------|---------|
| `anchor` | Externalize volatile context into prove anchors, emit /compact instructions |
| `rehydrate` | Reorient from anchors after a compaction |
| *(none)* | Auto-detect: `.prove/compact-anchors.md` exists → `rehydrate`; otherwise → `anchor` |

Remaining tokens are a free-form note (extra context for the anchor sweep).

**Boundary with `/prove:task handoff`:** handoff serializes full context for a
*fresh session or different agent*. Smart compaction serves the *same session
surviving an in-place context squeeze* — the post-compact agent still has the
summary and CLAUDE.md, so anchors are pointers, never serialized content.
Ending the session? Use `/prove:task handoff` instead.

The SessionStart hooks (matcher `compact`) inject a mechanical run/scrum digest
automatically after compaction. Treat that digest as the cue to run
`rehydrate`, not as a replacement for it — the digest reports state; rehydrate
re-reads the working set and resumes.

---

## `anchor` — Externalize Before Compaction

The conversation holds knowledge the store does not. Move it into durable
anchors so the compaction summary can lose it safely. Consult
`references/anchor-map.md` for the full context-kind → anchor mapping.

### Step 1: Capture Sweep (judgment)

Compare what this session knows against what the store records. Persist every gap:

- **Actionable work, follow-ups** not yet tracked →
  `claude-prove scrum task create --title "..." [--milestone <m>] [--tag <t>]`
- **Decisions with rationale** (what, why, alternatives rejected) →
  `claude-prove scrum decision record ...`
- **Blockers** on in-flight tasks →
  `claude-prove scrum task status <id> blocked` (note the blocker in the description)
- **Stale task statuses** — anything started but still showing `ready` →
  `claude-prove scrum task status <id> in_progress`

Skip anything already derivable from git history, the scrum store, or run
artifacts — anchors point, they do not duplicate.

### Step 2: Snapshot Mechanical State (read-only)

```bash
claude-prove scrum status --human
claude-prove run-state current
git status --porcelain && git log --oneline -3
```

Note the active run (branch/slug/current step), in-progress task IDs, and
uncommitted paths.

### Step 3: Write `.prove/compact-anchors.md`

Pointers only — no file content, no store duplication. Target under 40 lines:

```markdown
# Compact Anchors
<!-- Written by smart-compaction anchor. Read + deleted by rehydrate. -->

## Identity
- Branch: <branch> · Run: .prove/runs/<branch>/<slug>/ (step <n>) — omit if no run
- Active scrum tasks: <id> (<status>), ...

## Now
- Immediate next action: <one concrete sentence — "fix the failing assertion in
  store.test.ts:214 caused by the new ULID format", not "continue the store work">

## In-Flight Files
- <path> — <one-line why it is mid-change>

## Gotchas
- <max 3 bullets: non-obvious session knowledge a reorienting agent would trip on>

## Rehydrate
Run `/prove:compact rehydrate` (or follow skills/smart-compaction/SKILL.md).
```

### Step 4: Report + Emit Compact Instructions

Report what was anchored (task IDs created/updated, decisions recorded, anchor
file path). Then emit a paste-ready instruction line — do **not** run
compaction yourself; the operator triggers it (or auto-compact fires):

```
/compact Preserve: active task IDs <ids>, run <branch>/<slug> step <n>, paths
under change, and that .prove/compact-anchors.md holds rehydration anchors.
Drop: resolved explorations, raw tool output, superseded approaches.
```

### Rules

- Never inline file content into the anchor file — paths and one-line whys only.
- Never duplicate what `scrum status` / `run-state show` / `git log` can answer — point at the source instead so rehydrate re-derives it.
- Do not ask the user questions; anchor what is capturable and report.
- Re-running `anchor` overwrites the anchor file — each run is a fresh snapshot.

---

## `rehydrate` — Reorient After Compaction

### Step 1: Read Anchors

Read `.prove/compact-anchors.md`. Missing → proceed with Step 2 anyway
(mechanical-only rehydration) and note that no anchor file was found.

### Step 2: Mechanical Reorientation (read-only, in order)

```bash
claude-prove scrum status --human
claude-prove scrum next-ready
claude-prove scrum alerts
claude-prove run-state current
git status && git log --oneline -5
```

Active run → also `claude-prove run-state show --branch <b> --slug <s> --format md`.
Recent decision context → `claude-prove scrum decision list --limit 5`.
Navigating unfamiliar code next → `claude-prove cafi context` before any Glob/Grep.

### Step 3: Reload the Working Set

Re-read every path under "In-Flight Files", then any task plan / run artifacts
the anchors reference. Priority: run plan > in-flight files > recent decisions.

### Step 4: Delete and Resume

```bash
rm .prove/compact-anchors.md
```

Confirm reorientation in one short block — what was in flight, the immediate
next action, the branch — then resume immediately. Do not ask the user to
repeat the task; the anchors and store carry it.
