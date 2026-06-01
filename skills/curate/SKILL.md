---
name: curate
description: >
  Lift reasoning-log findings into durable scrum decisions at milestone close
  (onleash Codex curation, §8.3-8.4, §8.10). Triggers on "curate", "curate the
  milestone", "promote findings", "journal to codex", "promote to decisions",
  "curate reasoning log", "milestone curation", "promote hacks/risks/decisions".
  You are the driver Claude session: the scrum reconciler emits a
  `curation_proposed` event per closed-milestone task with candidate findings;
  you read the candidates, classify each as adr|glossary|pattern, human-gate
  each promotion with AskUserQuestion, and record it as a first-class scrum
  decision.
---

# Curate Skill

You are the **driver**. prove never spawns Claude — you do. The split is the
engine boundary (`references/onleash-design-principles.md` §1): the CLI already
did the mechanical half at milestone close — the reconciler walked the
milestone's tasks and emitted one `curation_proposed` event per task carrying
candidate findings. **This skill is the judgment half**: which findings become
durable memory, and as what kind. That requires reading prose and weighing
significance, so it is the model's, gated by a human.

Three invariants govern every phase below:

- **Source of truth is `prove.db`.** A promotion is a row in `scrum_decisions`,
  authored from a `.prove/decisions/<id>.md` file and `recorded` via the CLI,
  linked back to its task. Nothing here is a throwaway in-context structure.
- **Append-only (design-principles §4).** Curation only *promotes* findings into
  the Codex — it never edits or deletes the reasoning log. A skipped finding
  stays in the log for a later pass; a replaced decision is **superseded**, not
  overwritten.
- **Every promotion is human-gated.** `AskUserQuestion` before any
  `decision record` — no silent auto-promotion.

---

## When this runs

After `claude-prove scrum milestone close <id>` fires the curation trigger
(stderr reports `curation: N task(s) proposed`). Invoke this skill with the
milestone id. With no argument, offer recently-closed milestones
(`claude-prove scrum milestone list --status closed`).

---

## Phase 1: Collect candidates

Read the milestone's tasks, then each task's `curation_proposed` event payload.

```bash
claude-prove scrum milestone show <milestone-id>   # → { milestone, tasks }
claude-prove scrum task show <task-id>             # → { task, tags, events, runs, ... }
```

In each `task show` payload, find the `curation_proposed` event whose
`payload.milestone_id` matches; its `payload.candidates[]` are the findings.
Each candidate carries `entry_id`, `type` (`hack|risk|decision|assumption`),
`agent`, `run_path`, and `body`.

The `body` is usually enough to classify. For per-type detail (a decision's
`alternatives`/`selected_rationale`, a hack's `cleanup_condition`, a risk's
`severity`), read the full entry — its on-disk path is deterministic:

```
<run_path>/log/<agent>/<entry_id>.json
```

or list the run's log: `claude-prove acb log list --run-dir <run_path>`.

---

## Phase 2: Classify each candidate

Classify by **content**, not by source type — the source `type` is a prior, not
a rule. A finding may also be **noise** (skip it; it stays in the log).

| Codex kind | What belongs here | Typical source |
|------------|-------------------|----------------|
| `adr` | An engineering decision of record: what was chosen, the alternatives, the rationale. | `decision` (and any `risk`/`hack` that drove a real choice) |
| `glossary` | A durable definition or a resolved assumption that became a project fact. | `assumption` (once resolved), naming decisions |
| `pattern` | A recurring solution shape, an anti-pattern, or tracked tech-debt with a cleanup condition. | `hack`, `risk` |

Promote a finding only when it carries signal **beyond this run** — something a
future session must not rediscover. Run-local narration is not Codex material.

---

## Phase 3: Gate each promotion (AskUserQuestion)

Gate one `AskUserQuestion` per task — not one per candidate — so a multi-finding
task is decided in a single prompt (`references/interaction-patterns.md`,
Approval Gate), header `"Curate"`. State each candidate's proposed `kind` and
one-line title so the operator decides with full context:

- **Promote all** — record every proposed promotion as classified.
- **Revise** — adjust the kind/title/skip set, then re-present.

---

## Phase 4: Record each promotion

First dedup against the standing Codex so curation never duplicates an existing
decision:

```bash
claude-prove scrum decision list --kind <kind>     # add --topic for a tighter match
```

If an equivalent decision already exists and this finding refines or replaces
it, **supersede** instead of adding (append-only §4) — record the new decision
first, then point the old one at it:

```bash
claude-prove scrum decision supersede <old-id> --by <new-id> --reason "<why it changed>"
```

For a fresh promotion, author the decision file with the native **Write** tool
(prose lives in a file, never an inline flag — design-principles §2), then record
and link it so the brief and context bundle see it:

```bash
# 1. Write .prove/decisions/<YYYY-MM-DD>-<slug>.md  (native Write tool):
#      # <Title>
#      **Topic**: <topic>
#      **Status**: accepted
#      <body: the finding, its rationale, and provenance —
#       source entry_id, run_path, milestone>

# 2. Record under its Codex kind (only adr|glossary|pattern, case-insensitive;
#    any other value is rejected):
claude-prove scrum decision record .prove/decisions/<id>.md --kind <adr|glossary|pattern>

# 3. Link back to the task that surfaced it:
claude-prove scrum task link-decision <task-id> .prove/decisions/<id>.md
```

The decision file is the durable artifact; `prove.db` is the re-derivable index
(`scrum decision recover --from-git` rebuilds it from history).

---

## Phase 5: Compact the journal (onleash §8.7)

Close with a short summary of what was lifted and what stayed in the log — the
milestone's Codex delta. "Compaction" here means *summarizing*, not pruning: per
the append-only invariant, leave every reasoning-log entry intact. Record the
summary as a `pattern` decision (or a brief note) so the next session sees the
milestone's curated outcome without re-reading every run log.

> The full stakeholder rollup — deduped hacks/risks across stories, outcomes
> shipped, what-did-not-ship — is the **milestone-level Brief**, a separate task
> (`milestone-level-brief`). Keep this step to the curation delta; do not
> reimplement the Brief here.

---

## Guards

- **Judgment, not a counter.** Promote on significance, not on candidate count.
  A milestone may close with zero promotions — that is a valid outcome, not a
  failure.
- **Provenance travels.** Each recorded decision names its source `entry_id`,
  `run_path`, and milestone in the body, and is linked to its task — so a future
  reader can trace why it became durable.
- **The intro invariants are hard floors**, not advice: gate every promotion,
  never delete or edit the log, supersede rather than overwrite.

## References

| File | Purpose |
|------|---------|
| `references/onleash-design-principles.md` | Engine boundary (§1), native primitives (§2), append-only/supersession (§4) |
| `references/interaction-patterns.md` | The `AskUserQuestion` promotion gate |
| `skills/decompose/SKILL.md` | The reasoning-log entry shapes curation reads (the writer side) |
| `docs/onleash-port-audit.md` (§8) | The Codex curation methodology this skill ports |
