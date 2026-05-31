# onleash Design Principles (Distilled)

Portable design principles harvested from the `onleash` framework (a Go-daemon-driven structured-agent orchestrator) for claude-prove's own use. This is a distillation, not a copy — onleash's engine is obsolete here; its *methodology* is not. Each principle states what it is, why it matters for claude-prove, and the concrete touchpoint where it lands.

For the full port analysis and where each principle slots into the roadmap, see [`docs/onleash-port-audit.md`](../docs/onleash-port-audit.md) — especially §5.5 (this harvest), §2 (engine-boundary mapping), and §5.1–§5.3 (the data-model ports).

## 1. The Engine Boundary

**What it is.** onleash's ADR 0015 draws one line through the whole system: the engine owns **state, scheduling, and hard floors**; the model owns **substantive judgment**. The dividing test is a single question — *does this require understanding?* If it is a pattern match, a counter, a scheduled event, a state transition, or a runaway-behavior floor, the engine owns it. If it requires reading prose, judging intent, resolving conflict, choosing between defensible options, or producing content, the model owns it. Borderline cases default to the model, because a mechanical decision standing in for judgment silently corrupts state the engine has no context to repair.

**Why it matters here.** claude-prove's founding bet — *"prove never spawns Claude — you do"* — is the same boundary, drawn one layer further out. onleash needed a daemon because it drove agents from *outside* a Claude session; claude-prove drives from *inside* the session, so native primitives already supply the state/scheduling half. The engine boundary tells maintainers exactly which half of any new feature belongs in the CLI and which belongs in a skill or agent. Use it to resist daemon-drift: every "the CLI should just handle this" argument is answered by the dividing test, not by re-litigating the principle.

**Touchpoint.** The CLI (`claude-prove <topic>`) is the mechanical side — `scrum`/`run-state` state mutation, `worktree` lifecycle, `compile-plan`/`wave-plan` scheduling arithmetic, derived status rollup, validator dispatch (exec + record). Skills, agents, and slash commands are the judgment side — decomposition, code review (`principal-architect`), acceptance-criterion authoring, brief synthesis, curation, merge resolution. When in doubt, the CLI computes and records; the model reads, decides, and writes content. Status rollup is the canonical "looks like judgment, is actually arithmetic" case — it stays mechanical.

## 2. Native Primitives — No Inline Prompts

**What it is.** onleash's ADR 0004 establishes that any value an LLM reads lives in a file (a markdown path), never an inline JSON string. Engine-only fields (control flow, shell commands, machine-checkable assertions) stay inline; LLM-consumed text is always a file reference. JSON-embedded prose is unreviewable — no diff highlighting, no length budget, escape noise, and behavior-changing PRs that read like config churn. The field name encodes the rule: `run:` is an inline shell command, `instructions:` is a path to markdown.

**Why it matters here.** This is already codified in claude-prove's own CLAUDE.md ("CLI Invocation in User-Facing Output") and is the reason agent definitions, commands, skills, and these references are first-class diffable markdown files rather than strings baked into code. The principle is the audit story: model-consumed text must be reviewable as text, lintable, and subject to the prompt-quality gate. It also explains why claude-prove leans on Claude Code's filesystem namespace (`agents/`, `commands/`, `skills/`) instead of a registry block — a second registry would drift from the filesystem source of truth.

**Touchpoint.** Prompt validators reference a `prompt:` file path, never an inline prompt (see [`references/validation-config.md`](validation-config.md)). LLM-fed text — `agents/*.md`, `commands/*.md`, `skills/*/SKILL.md`, `references/*.md` — lives in files and passes the `llm-prompt-engineer` gate before commit. Codegen that emits model-facing text writes files or references them; it does not concatenate prose into JSON.

## 3. Forced Bubble-Up

**What it is.** Discoveries, escalations, and curation steps fire **structurally on state transitions**, not as opt-in hygiene the agent might skip. In onleash, an in-flight story that hits an unplanned hard dependency transitions to `blocked_by_discovery`, which *forces* the parent role's re-decomposition; a story reaching close *forces* the curation step that lifts findings into durable memory. The work surfaces because the state machine makes it surface — never because someone remembered to do it.

**Why it matters here.** Opt-in capture is the failure mode every session-handoff suffers: the discovery that mattered dies with the session that found it. Forcing capture on transitions is the structural fix, and it aligns with the operator directive to treat every handoff as a clean break where the task store alone must carry enough context to resume. claude-prove cannot fire passive triggers — it has no resident process — so the analog is event-driven, not daemon-driven: the work is reconciled into state on transition, then surfaced to the *next* driver session.

**Touchpoint.** The scrum reconciler hook (`scrum hook session-start|subagent-stop|stop`) is the claude-prove analog of onleash's passive trigger table. A subagent that hits an unplanned dependency returns a structured `discovery` finding; inside a single run the workflow script branches to a re-plan step (the trigger is just the next statement), and across sessions the reconciler hook sets the task `blocked` and `scrum next-ready` surfaces the re-decompose work to whoever drives next. The deliberate cost (audit §2.3): no autonomous progression *between* sessions — claude-prove trades unattended firing for zero operational surface. That is the right trade for a single-operator tool.

## 4. Closed-Enum and Append-Only-with-Supersession Discipline

**Closed enums.** Every taxonomy — step kinds, statuses, event types, log-entry types, terminal reasons, escalation types — is a small, *closed* enum; adding a value requires a deliberate amendment (an ADR in onleash, a schema-version bump here). The payoff is that the model and the engine share one fixed vocabulary that cannot drift apart: a status means exactly the listed states, a kind maps 1:1 to a real mechanism, and "vibe-based" categories that name work by feel rather than by the mechanism that executes it are forbidden. claude-prove's touchpoint is `PROVE_SCHEMA` + `CURRENT_SCHEMA_VERSION` (see the Schema Migration Checklist in CLAUDE.md): new taxonomy values are gated behind a version increment and a migration path, never silently added.

**Append-only with supersession.** Memory, artifacts, criteria, and records are never silently hard-deleted; a superseded entry carries a pointer to its replacement (`superseded_by`) and a recorded reason. The replacement supersedes; the original stays auditable. This is the cheapest high-value discipline in the audit (§5.3): it is a convention, not an engine — it underpins trustworthy briefs (you can always trace why a decision changed) and any future cross-session reconciliation. claude-prove's touchpoint is `scrum_decisions` and retired task statuses: prefer a `superseded_by` + `reason` pointer over a soft-delete `deleted_at`, so the replacement graph is explicit and the history survives.

---

claude-prove design reference — source of analysis: [`docs/onleash-port-audit.md`](../docs/onleash-port-audit.md); source ADRs: onleash 0015 (engine boundary), 0004 (native primitives), spec §1 (six structural commitments).
