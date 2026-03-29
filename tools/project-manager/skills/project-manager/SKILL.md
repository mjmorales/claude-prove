---
name: project-manager
description: >
  Project management skill for roadmapping, backlog grooming, vision documents, and
  shipping tracking. Use when the user wants to plan what to work on next, review the
  roadmap, add/prioritize backlog items, update the vision, log shipped work, or run a
  retro. Also triggers on "what should I work on", "update the roadmap", "add to backlog",
  "what have we shipped", "project status", or any planning/prioritization discussion.
  This skill provides the file structure and conventions; the product-owner agent provides
  the strategic reasoning.
---

# Project Manager

Manage the project's strategic planning layer: vision, roadmap, backlog, and ship log. This skill owns the file formats and bootstrap process. For strategic reasoning (prioritization, scope decisions, trade-off analysis), delegate to the **product-owner** agent.

## Planning Directory

All planning artifacts live in `planning/` at the project root:

```
planning/
  VISION.md       # Project pillars, north star, target audience
  ROADMAP.md      # Milestone-based macro + Now/Next/Later micro
  BACKLOG.md      # ICE-scored work items, tagged by domain
  ship-log.md     # Running log of completed work
  decisions/      # Consolidated decision references (permanent)
```

## Operations

When invoked, determine which operation the user needs and follow that workflow. If unclear, ask.

### `init` — Bootstrap the planning directory

Run this on first use or when `planning/` doesn't exist.

1. Create `planning/` directory
2. Copy templates from the plugin templates (`$PLUGIN_DIR/tools/project-manager/skills/project-manager/assets/templates/`) and populate with project-specific content
3. Read any existing design docs, READMEs, or `.prove/archive/` for context
4. Ask the user about their project's milestones if not obvious from context
5. Tell the user what was created and suggest they review VISION.md first

### `review` — Planning review session

A conversational check-in on project state. Delegate to the **product-owner** agent after loading context.

1. Read all planning files to understand current state
2. Check `git log --oneline -20` for recent momentum
3. Check `.prove/TASK_PLAN.md` and `.prove/PROGRESS.md` for in-flight work
4. Spawn the product-owner agent with this context and the user's question
5. The agent drives the conversation — it will recommend what to work on, flag stale items, and ask clarifying questions

### `groom` — Backlog grooming

Add, reprioritize, or clean up backlog items.

1. Read `planning/BACKLOG.md`
2. If the user is adding items: help them define the item (title, domain tag, brief description) and score it (ICE: Impact/Confidence/Ease, each 1-10)
3. If reprioritizing: re-sort by ICE score, flag items that no longer align with current milestone
4. If cleaning up: move completed items to ship-log, remove stale items
5. Write updated BACKLOG.md

For complex prioritization decisions, delegate to the product-owner agent.

### `ship` — Log completed work

Record what was shipped. Run after completing a prove task or merging significant work.

1. Read `planning/ship-log.md`
2. Determine what was completed:
   - Check `.prove/archive/` for recently archived tasks
   - Check `git log` for recent merges
   - Ask the user if not obvious
3. Add entry to ship-log.md with date, description, and archive reference
4. Update BACKLOG.md — mark shipped items as done or remove them
5. Update ROADMAP.md — move shipped items from "Now" to the milestone's completed section

### `consolidate` — Consolidate ephemeral decisions into permanent references

The `.prove/decisions/` directory accumulates individual decision records from brainstorm sessions — dated, per-topic, often overlapping. This operation distills them into clean, organized docs in `planning/decisions/`.

1. Read all files in `.prove/decisions/` and scan `.prove/archive/*/SUMMARY.md` for context
2. Group decisions by theme (use whatever themes make sense for the project — common ones: architecture, design, infrastructure, product)
3. For each theme, write a consolidated reference doc that:
   - Narrates the decisions coherently (not a copy-paste dump)
   - Preserves the key reasoning ("we chose X because Y")
   - Drops outdated or superseded decisions
   - Notes which original decision records were consolidated (for traceability)
   - Flags any open questions or decisions that need revisiting
4. Write to `planning/decisions/<theme>.md`
5. Report what was consolidated and flag any conflicts or gaps found

**When to run**: After completing a milestone, after a burst of brainstorming sessions, or when `.prove/decisions/` has accumulated enough new records that reference docs feel stale.

**Important**: This is a rewrite, not an append. Each consolidation re-reads all source material and produces a fresh version of each theme file. The `.prove/decisions/` files are NOT deleted — they remain as the raw audit trail.

### `retro` — Lightweight retrospective

A quick reflection on recent work. No fixed cadence — run when it feels useful.

1. Read ship-log.md for recent completions
2. Ask the user three questions:
   - What went well?
   - What didn't go well?
   - What will you change?
3. Append the retro to ship-log.md under a dated "Retro" section
4. If any "what will I change" items are actionable, offer to add them to the backlog

## File Formats

### VISION.md

The vision doc answers: what is this project, who is it for, and what experience/outcome are we creating?

Template: `$PLUGIN_DIR/tools/project-manager/skills/project-manager/assets/templates/VISION.md`

Key sections:
- **North Star** — One sentence describing the product
- **Design Pillars** — 3-5 pillars that define the core experience. Every feature must serve at least one; if it serves none, cut it.
- **Target Audience** — Who uses this product
- **Success Criteria** — What does "done" look like for the current phase

### ROADMAP.md

The roadmap uses milestones as the macro structure and Now/Next/Later as the micro structure within each milestone.

Template: `$PLUGIN_DIR/tools/project-manager/skills/project-manager/assets/templates/ROADMAP.md`

**Milestones** are project-specific. During `init`, work with the user to define milestones that match their project type and goals. Each milestone should have a clear goal and produce something testable/demoable.

**Within each milestone** (micro), use Now/Next/Later:
- **Now** — In-progress, high confidence
- **Next** — Designed but not started, medium confidence
- **Later** — Aspirational, low confidence

### BACKLOG.md

The backlog is a single prioritized file with ICE scoring.

Template: `$PLUGIN_DIR/tools/project-manager/skills/project-manager/assets/templates/BACKLOG.md`

Each item has:
- **Title** — What the work is
- **Domain** — Project-specific tag (defined during init)
- **ICE Score** — Impact (1-10) x Confidence (1-10) x Ease (1-10) = composite
- **Description** — 1-2 sentences, enough to understand the work
- **Dependencies** — What blocks this, if anything
- **Status** — `backlog`, `ready`, `in-progress`, `done`

Items are sorted by ICE score descending. When an item moves to "in-progress", it feeds into `/prove:task-planner` for implementation planning.

If the backlog exceeds ~50 items, consider splitting into separate files by domain or milestone.

### ship-log.md

A running log of completed work, newest first.

Template: `$PLUGIN_DIR/tools/project-manager/skills/project-manager/assets/templates/ship-log.md`

Each entry has:
- **Date** — When it shipped
- **Title** — What was completed
- **Archive ref** — Link to `.prove/archive/` if applicable
- **Impact** — Brief note on what this unlocked or proved

Retro sections are interspersed when they happen.

### planning/decisions/ (Consolidated Decision References)

Permanent, theme-organized reference docs distilled from ephemeral `.prove/decisions/` records.

Template: `$PLUGIN_DIR/tools/project-manager/skills/project-manager/assets/templates/decisions.md`

Each theme file contains:
- **Summary** — One paragraph overview of decisions in this domain
- **Decisions** — Each decision as a section with: what was decided, why, what was rejected, and source reference
- **Open Questions** — Anything flagged for revisiting
- **Last Consolidated** — Date of last consolidation run

## Pipeline Integration

The planning layer sits above the prove execution pipeline:

```
VISION.md  →  informs  →  ROADMAP.md  →  feeds  →  BACKLOG.md
                                                        ↓
                                              pick item, run /prove:task-planner
                                                        ↓
                                              /prove:orchestrator executes
                                                        ↓
                                              run /project-manager ship
                                                        ↓
                                              ship-log.md updated, BACKLOG.md cleaned
```

## Working with the Product-Owner Agent

This skill provides structure. The product-owner agent provides judgment. The division:

| This skill does | The agent does |
|-----------------|----------------|
| File formats and templates | Strategic prioritization |
| Bootstrap and init | "What should we work on next?" |
| Read/write planning files | Trade-off analysis |
| Pipeline integration | Scope decisions and pushback |
| Ship logging | Teaching PM concepts |

When the user's request requires strategic thinking (not just file operations), spawn the product-owner agent with the relevant planning file contents as context.
