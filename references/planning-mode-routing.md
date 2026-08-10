# Planning-Mode Routing — the Native Route

The shared procedure for planning-phase skills that branch on `claude-prove models routing` (`/prove:plan` Mode: Task, orchestrator full-mode PRD gathering). The route exists because an `opusplan` main model upgrades to Opus only inside Claude Code plan mode — routing the planning arc there is what makes a declared model config actually fire. Projects declare the route in `.claude/.prove.json::models.planning` (`prove` | `native` | `auto`); `routing` resolves it mechanically.

Each skill that uses this route supplies four bindings inline: its **coverage** (what the plan must contain), its **approval mapping** (which of its own gates the plan-mode approval replaces), its **contract** (the artifact shapes for the backfiller), and its **landing order** (how returned artifacts are written). Everything else follows this procedure verbatim.

## Resolve

```bash
claude-prove models routing
```

One word comes back. On `prove`, run the skill's own flow unchanged — none of the steps below apply. On `native`:

## Native procedure

1. **Enter plan mode** (`EnterPlanMode`) and let plan mode drive its own exploration and plan-writing procedure. The skill's coverage binding is the completeness bar, not a competing script: a plan missing a coverage item is not ready for `ExitPlanMode`.
2. **Create nothing inside plan mode.** No run directory, no artifact write, no scrum write, no `run-state init` — plan mode blocks writes, and every prove-side write defers to after approval. Deriving names (slug, branch namespace) and reading project context is fine.
3. **`ExitPlanMode` approval is the human gate.** It replaces the skill's own approval gate(s) per the skill's approval mapping — never add an `AskUserQuestion` re-approval of the same plan after it.
4. **Dispatch the `plan-backfiller` agent** with:
   - the plan file path from the `ExitPlanMode` submission (the agent Reads it verbatim; paste the full plan text only when no path is available),
   - the skill's contract binding — populated JSON examples of each target artifact, with driver-owned fields named as such (e.g. `task_id`, `worktree`),
   - the absolute project root.
5. **Land the artifacts in the skill's landing order**, run the skill's own validation, and complete its remaining post-write steps exactly as the prove route would.
6. **Surface every `unmapped` and `warnings` entry the backfiller returns.** Route durable rationale to the reasoning log, a task description, or a decision record — never drop it.
