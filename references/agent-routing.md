# Agent Routing Map

Match a task cue to its delegation surface — subagent, skill, or direct CLI — and delegate there instead of improvising the flow inline. Routing is a convention the driver session follows; the store enforces hard floors (status enums, story-close criteria, event log) independently.

## Cue → Surface

| Task cue | Surface | Invoke via |
|----------|---------|------------|
| Task lifecycle needing judgment — status transitions with tradeoffs, dep-graph edits, milestone grooming, run/decision linkage | `scrum-master` agent | `/prove:scrum task` (also `milestone`, `tag`, `link`), or the Agent tool |
| Scrum reads — status snapshot, ranked next tasks, stalled-WIP and orphan alerts | CLI direct | `claude-prove scrum status`, `next-ready`, `alerts` (add `--human`) |
| Mechanical scrum writes inside a skill flow — decompose-ladder children, workflow status mirroring, curation promotions, quick follow-up capture | CLI direct | `claude-prove scrum task create` etc., from the driving skill or session |
| Vision alignment, milestone shaping, macro dep-graph strategy | `product-visionary` agent | Agent tool |
| Code review of an orchestrated task or step | `principal-architect` agent | dispatched by orchestrator full mode; Agent tool for a manual review |
| Reviewing or optimizing any LLM-fed text — `agents/*.md`, `commands/*.md`, `skills/*/SKILL.md`, CLAUDE.md, prompts | `llm-prompt-engineer` agent | Agent tool — mandatory gate before committing such text |
| Code-quality audit and surgical fixes | `code-steward` agent | `/prove:steward` |
| Human-readable docs — READMEs, guides, API references | `technical-writer` agent | `/prove:docs` |
| RFC-style specs, protocol definitions, format standards | `spec-writer` agent | `/prove:create` (spec type) |

## Scrum Routing Convention

The scrum store has one mechanical write path (`claude-prove scrum`) and several legitimate callers. Route by the nature of the operation, not the caller:

- **Judgment writes** go through the `scrum-master` agent, which owns the confirmation gates — e.g. closing a task with unresolved findings, reopening a `done` task, bulk transitions.
- **Reads** are always direct CLI; never spawn an agent to run `status` or `next-ready`.
- **Mechanical writes from an owning skill** call the CLI directly — the skill itself is the judgment layer.
- **Reconciliation** (event ingest, context-bundle rebuild) is hook-driven (`scrum hook session-start|subagent-stop|stop`); let the hooks own it — never run it inline or reimplement its logic.
- Never touch `.prove/prove.db` with `sqlite3` or ad-hoc scripts — every write goes through `claude-prove scrum`, which emits the event log the briefs and alerts depend on.

## Pipeline-Internal Agents — Do Not Invoke Ad Hoc

These agents are stages of a pipeline that supplies their inputs; invoked standalone they lack the context they were designed around. Run the owning surface instead:

| Agent | Owner — invoke this instead |
|-------|------------------------------|
| `validation-agent` | orchestrator validation gate (`validators` in `.claude/.prove.json`) |
| `brief-judge` | `reasoning-brief` skill (Stage-2 prose judge — runs automatically) |
| `pcd-triager`, `pcd-reviewer`, `pcd-synthesizer`, `pcd-annotator` | PCD audit pipeline via `/prove:steward` full mode |
