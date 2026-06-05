---
name: janitor
description: >
  Clean and compact prove's durable memory layers — team Lore, the Codex
  (scrum decisions), annotations, and contributor artifacts — keeping the
  tribal knowledge that grows team accuracy and folding away the rot.
  Triggers on "janitor", "clean the lore", "compact the lore", "compact the
  codex", "memory cleanup", "clean up team memory", "prune stale decisions",
  "tidy tribal knowledge", "lore cleanup". You are the driver: the CLI emits
  inventories and executes writes; the `memory-janitor` agent judges each
  entry; a per-team batch gate approves; nothing is ever deleted —
  consolidation, promotion, and supersession only.
---

# Janitor Skill

You are the **driver**. prove never spawns Claude — you do. The split follows
the engine boundary: the CLI owns inventory, token accounting, and every write;
the `memory-janitor` agent owns the judgment of what is tribal knowledge versus
rot; a human batch gate owns approval. Three hard floors govern every phase:

- **Append-only, always.** Nothing is deleted or edited in place in the store.
  Lore and annotations are cleaned by *consolidation* (a new distilled entry
  citing what it folds), the Codex by *supersession* (a pointer plus reason),
  contributor artifacts by *rewriting the authored body* (the one surface where
  in-place editing is the mechanism — the registry merge preserves it).
- **Every write goes through `claude-prove scrum`** (or the Write/Edit tools
  for decision files and contributor bodies). Never `sqlite3`, never ad-hoc
  scripts against `.prove/prove.db`.
- **Every batch of writes is human-gated** — one gate per team, one for the
  Codex. No silent cleanup.

## What it cleans

| Layer | Store | Cleanup mechanism available |
|-------|-------|------------------------------|
| Team Lore | `scrum_lores` (mirrored into `teams/<slug>.md`, recent-10 window) | Append a tech_lead-authored consolidation entry citing folded ids; promote project-wide entries to the Codex |
| Codex | `scrum_decisions` + `.prove/decisions/*.md` | `decision supersede --by --reason`; record consolidated replacements |
| Annotations | `scrum_annotations` | Input signal only — durable findings get lifted into Lore or Codex; rows are never displaced |
| Contributor artifacts | `contributors/<slug>.md` authored body | Direct Edit (frontmatter is registry-owned; never touch it) |

**Known limitation — state it in the final report.** Lore has no supersession
column: a consolidation entry displaces older entries from the team artifact's
recent-10 window only as new entries accumulate. Until then both are visible,
which is why every consolidation body must name the ids it folds — readers
treat the consolidation as authoritative over its sources.

## Phase 0 — Scope and inventory (mechanical)

Parse arguments: zero or more team slugs (default: every team), optional
`--codex-only` / `--lore-only`. Then inventory:

```bash
claude-prove scrum team list                       # teams in scope
claude-prove scrum lore list <slug>                # full Lore per team (JSON)
claude-prove scrum annotation list --target-kind team --target <slug>
claude-prove scrum decision list                   # the Codex
claude-prove scrum decision review-stale           # staleness signal (report-only)
```

Dump each list to `.prove/scratch/janitor/<scope>.json` (e.g. `lore-funpack.json`,
`codex.json`) — these are the agent's inputs. Record the baseline footprint:

```bash
claude-prove prompting token-count "teams/*.md" "contributors/*.md" ".prove/decisions/*.md"
```

If everything in scope is empty, report that and stop — a janitor pass over
nothing is a no-op, not a failure.

## Phase 1 — Janitorial pass (judgment, read-only)

Dispatch one `memory-janitor` agent per team **plus one for the Codex**, in
parallel via the Agent tool. Each prompt supplies:

- the scope (`team <slug>` or `codex`);
- the dump paths from Phase 0;
- artifact paths: `teams/<slug>.md`, each roster seat's `contributors/<slug>.md`
  (team scope) or `.prove/decisions/` (codex scope);
- the team's seated `tech_lead` CT-UUID from the bundle roster (team scope) —
  the agent must not guess it.

The agent returns a single JSON plan: per-entry verdicts from the closed set
`keep | consolidate | promote | supersede | rewrite | noise`, plus fully
drafted bodies for every consolidation, promotion, replacement, and rewrite.
Parse it; a `"status": "blocked"` plan names a missing input — fix and
re-dispatch that scope only.

## Phase 2 — Batch gate (one per scope)

For each team (and once for the Codex), present the plan with `AskUserQuestion`
(header `"Janitor"`): per-entry verdict + one-line reason, the drafted
consolidation/promotion titles, and the projected write list.

- **Apply batch** — execute Phase 3 for this scope as planned.
- **Revise** — operator adjusts verdicts/drafts; re-present.
- **Skip scope** — no writes for this team; plan is discarded.

Never merge scopes into one gate: a team's tech_lead-authored writes deserve
their own approval.

## Phase 3 — Execute (mechanical, CLI only)

Per approved scope, in this order:

**1. Lore consolidations.** Author each drafted body to
`.prove/scratch/janitor/<team>-<draft-id>.md` with the Write tool (prose in a
file, reviewable as text), then append as the seated tech_lead:

```bash
claude-prove scrum lore record <slug> \
  --body "$(cat .prove/scratch/janitor/<team>-<draft-id>.md)" \
  --author <tech_lead CT-UUID>
```

The store enforces authorship: with a seated tech_lead the author MUST be that
holder; with no tech_lead seated the write lands with a warning. Acting as the
seat is the protocol — the batch gate is what authorizes it.

**2. Lore→Codex promotions.** Write the drafted decision markdown to
`.prove/decisions/lore-promotion-<team>-<loreId>.md` (this deterministic id
matches the store's promotion convention, so a future mechanical promotion
upserts the same row instead of duplicating), then:

```bash
claude-prove scrum decision record .prove/decisions/lore-promotion-<team>-<loreId>.md --kind <adr|glossary|pattern>
claude-prove scrum decision approve <decision-id> --by <responder>
```

Gated kinds land as drafts; the batch gate already approved, so resolve the
write-gate immediately. For `glossary` the responder must currently hold a
`tech_lead` seat — use the team's tech_lead CT-UUID; for `adr`/`pattern` use
the operator (`claude-prove scrum contributor default show`).

**3. Codex supersessions.** Record any drafted replacement first (same
record/approve flow), then point the old row at its successor:

```bash
claude-prove scrum decision supersede <old-id> --by <new-id> --reason "<why it changed>"
```

**4. Contributor rewrites.** Edit only the authored body below the frontmatter
of `contributors/<slug>.md`; the frontmatter is registry-owned and a later
`contributor register` merge preserves the body you wrote.

## Phase 4 — Re-measure and report

```bash
claude-prove prompting token-count "teams/*.md" "contributors/*.md" ".prove/decisions/*.md"
```

Report per scope: token delta against the Phase 0 baseline, entries
kept / consolidated / promoted / superseded / rewritten / left as noise-in-history,
each promotion's decision id, and the recent-10 window note from
"What it cleans" wherever consolidated sources are still visible. A zero-write
pass with an all-`keep` plan is a valid, reportable outcome.

## Guards

- **Judgment is the agent's, writes are yours, approval is the operator's** —
  never collapse the three.
- **Provenance travels**: every consolidation cites folded ids, every promotion
  cites its source lore id, every supersession carries a reason. A future
  reader must be able to trace why memory changed shape.
- **Never re-run Phase 3 on a revised plan without re-gating** the revised
  scope.
- **Tech_lead impersonation is scoped**: use the seat's CT-UUID only for the
  approved lore writes of that seat's team, nothing else.

## References

| File | Purpose |
|------|---------|
| `agents/memory-janitor.md` | The judgment pass: five tests, verdict set, drafting rules, plan JSON |
| `references/design-principles.md` | Engine boundary; append-only-with-supersession discipline |
| `references/interaction-patterns.md` | The `AskUserQuestion` batch-gate pattern |
| `skills/curate/SKILL.md` | The sibling lift: reasoning-log findings → Codex at milestone close |
