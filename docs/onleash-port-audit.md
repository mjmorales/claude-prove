# onleash → claude-prove Port Audit

**Date:** 2026-05-31
**Author:** Claude (Opus 4.8)
**Scope:** `~/dev/onleash` (Go daemon + MCP + plugin, ~28k LOC non-test, last commit 2026-05-28; reached ~phase 10/10.5 — decompose + story-close + brief shipped; teams/bounds/sync/escalation/memory-curation/HTML mostly spec-only) evaluated against `~/dev/claude-prove` (TS/Bun plugin, v2.9.1).

**Operating thesis (from the operator):** onleash's *workflows* — the layered, role-driven, artifact-anchored work lifecycle — were the better design. claude-prove's *machinery* — "let Claude Code handle the backend," no daemon, native primitives — was the better engineering. **The goal is to run onleash's workflow methodology on claude-prove's machinery.** This report is the breakdown of how.

---

## 0. TL;DR

The split that makes this clean is onleash's own **ADR 0015 (Engine Boundary)**: the daemon owns *state, scheduling, and hard floors*; Claude Code owns *judgment*. onleash built the state/scheduling half in Go because it drove agents from *outside* a Claude session and had no choice. claude-prove drives from *inside* the session, so native primitives already provide that half — better.

So the reconciliation is mechanical, not philosophical:

- **Keep onleash's judgment half** — the decompose ladder, AC-gated story close, risk-forward brief, forced bubble-up, append-only memory. These are *methodology*, expressed as workflow scripts + skills + a data model.
- **Replace onleash's state/scheduling half with claude-prove's machinery** — native `/workflows` JS is the scheduler; `scrum` (SQLite) + `run-state` (JSON) + git are the state; hooks are the triggers; `validators` + `principal-architect` are verification; `acb` is the brief; `AskUserQuestion` is the gate; `worktree` is isolation.

Net: the onleash *experience* survives; the onleash *engine* (daemon, MCP server, JSON workflow DSL, SSE inbox, JIT prompt assembly, S3 sync) is deleted because native primitives do its job in-session.

There is exactly **one genuine seam** (§2.3): onleash's triggers are *passive* — a resident daemon fires `story_close` even with no human present. claude-prove has no resident process, so triggers become intra-run control flow + hook-driven reconciliation. You lose autonomous progression while no session runs. That is the deliberate cost of "let Claude Code handle the backend," and it is usually worth it.

The highest-leverage harvest is not code at all: **mine onleash's 21-file spec + 32 ADRs as design input.** The spec is the distilled methodology; the binary is one (now-obsolete) realization of it.

---

## 1. The architectural thesis — two opposite bets

ADR 0004's clarification is the smoking gun for why onleash is a daemon:

> "'Invoke a Claude Code subagent' names the *conceptual role* … not Claude Code's in-session subagent primitive (the Agent/Task tool). That primitive is model-driven and runs inside the calling session: **an external process cannot spawn it** … onleash needs daemon-controlled, worktree-isolated, parallel workers, so the runtime realizes `kind: agent` as a daemon-spawned headless `claude` session."

That single sentence is onleash's entire reason to be a daemon. Driving agents from *outside* a session forced it to rebuild — in Go — everything Claude Code gives a session for free: subagent spawning, worktrees, scoped tools, channels, structured output, prompt assembly.

claude-prove made the opposite bet: **"prove never spawns Claude — you do."** The session is the driver; prove emits artifacts (plan.json, prompts, schedules) + CLI, and the session fans out via the Agent tool or the native `/workflows` dynamic backend. It never needed the daemon because it never left the session.

These are **two answers to one question** — *where does the orchestrating intelligence live, inside or outside the Claude session?* Native `/workflows` settled it for *inside*. onleash's engine is the cost of the losing answer; its methodology is independent of that answer. That separability is the whole opportunity.

| | onleash | claude-prove |
|---|---|---|
| Orchestrator location | Daemon, outside session | Driver session |
| Agent spawning | Headless `claude --print` subprocess | Native Agent tool / `/workflows` |
| State | `.onleash/` files + in-mem cache, daemon single-writer | `prove.db` (SQLite) + run JSON + git |
| Scheduling | Daemon event loop + `triggers.yaml` | `/workflows` JS control flow (in-session) |
| Cross-session coordination | Daemon + S3 sync | git + CLI, single operator |
| Prompt assembly | JIT in daemon (closed input set) | `orchestrator task-prompt` CLI renderer |
| Event delivery | Custom SSE inbox + ack | Native channels / reporters |
| Persistent process? | Yes (the whole point) | **No, by design** |

---

## 2. Reconciliation — onleash's workflows on claude-prove's machinery

This is the core of the report: a concrete account of how each onleash workflow runs on prove primitives.

### 2.1 The two halves, mapped to prove primitives

ADR 0015 already partitions onleash. Map each side to its claude-prove host:

**Daemon-owned (state / scheduling / floors) → replaced by native machinery**

| ADR 0015 daemon responsibility | onleash mechanism | claude-prove host |
|---|---|---|
| Scheduling & queueing | daemon event loop + triggers | **native `/workflows` JS** — the script *is* the scheduler, in-session |
| Artifact state | `.onleash/` + in-mem cache | **`scrum` (prove.db)** + **`run-state` JSON** + git |
| Event delivery / inbox | SSE channels + ack | native **channels** / **reporters**; **hooks** for reconciliation |
| Bounds walls | PreToolUse → daemon RPC | native **permissions** (`settings.local.json`) + `worktree` |
| Wall-clock SIGKILL | daemon signal | native subagent **timeout** / Workflow token **budget** |
| Hook routing | daemon socket endpoint | **hooks → `claude-prove` CLI** (same pattern, no daemon) |
| Worktree lifecycle | daemon | **`worktree`** topic |
| File watching / single-writer | daemon | *dropped* — SQLite handles concurrency, git handles external edits |

**Claude-owned (judgment) → ported as methodology**

| ADR 0015 judgment responsibility | onleash mechanism | claude-prove host |
|---|---|---|
| Decomposition (any layer) | role agent + `*_list` schema | planning **subagent** + native **structured output** |
| Code gen & review | implementer worker + judge | Agent-tool **subagent** + **`principal-architect`** |
| AC authoring & dispatch | tech_lead + verification dispatch | **`/prove:plan`** + AC field + **`validators`** / **`validation-agent`** |
| Brief synthesis | `engineer.generate_brief` | **`acb`** + a Reasoning-Log/Brief skill (§5.1) |
| Curation (Journal→Lore→Codex) | `tech_lead.curate` | journal→`scrum_decisions` promotion skill (§6.3) |
| Ask triage / escalation | role agents, autonomous | **`AskUserQuestion`** (human) or structured agent→driver report (§6.1) |
| Migration execution | LLM-run instructions | existing **`schema`** migrate flow |

The left table is "delete and lean on native." The right table is "port the methodology." That is the entire program.

### 2.2 Workflow-by-workflow realization

onleash ships 11 workflows. Here is what each *is*, and how it runs on prove. "Present" = already in claude-prove; "Net-new" = must be built; "Glue" = exists but needs wiring into a named lifecycle.

**(a) The decompose ladder** — `initiative_decompose`, `milestone_decompose`, `epic_decompose`, `story_decompose`
- *What it is:* a role agent reads the parent artifact + charter + relevant memory, emits a structured child list (`*_list.json` schema), children land `proposed`, an accept gate (or `auto_accept_through` config) promotes them and fires the next layer.
- *Prove realization:* a `/workflows` script that, per layer, spawns a planning subagent with a **native structured-output schema** (replaces `*_list.json`), writes each child as a `scrum task create` (status `backlog` ≈ `proposed`, `layer` column tags the tier — §3), then an **`AskUserQuestion`** accept gate (or config) flips `backlog→ready` and recurses.
- *Status:* claude-prove has the **single-level** version (`/prove:plan` → discovery → prd/plan; `scrum compile-plan` → waves). **Net-new** is the *recursive, role-typed* ladder + the hierarchy migration (§3) + the schemas. Note `compile-plan` runs the *opposite* direction — it flattens a milestone into execution waves; the decompose ladder builds the depth that `compile-plan` later consumes. They are complementary, not redundant.

**(b) `story_close`** — the MVP workflow
- *What it is:* dispatch AC by kind (bash/assert → mechanical; gate → human; agent → LLM judge) → write `verification` log entries → `ready_for_close` → generate + judge brief → open PR.
- *Prove realization:* maps almost entirely onto the **orchestrator full-mode pipeline that already exists**: validators (≈ bash/assert AC) → `validation-agent` (≈ agent-kind AC) → `AskUserQuestion` (≈ gate-kind AC) → `principal-architect` review (≈ brief judge) → commit/merge → `acb` assembled as PR body.
- *Status:* **~80% Glue.** Net-new is only the AC *field* on tasks (§5.2) and the Reasoning-Log brief (§5.1). The rest is naming this sequence a reusable lifecycle instead of an ad-hoc orchestrator path.

**(c) `generate_brief`**
- *What it is:* synthesizer (single-pass, or multipass episode-chunk→fragment→merge) + non-blocking prose judge, with the preservation rule (never drop a hack/risk/bailout/open-assumption/decision-alternatives).
- *Prove realization:* the §5.1 ACB Reasoning-Log/Brief port. Multipass episode chunking is a PCD-adjacent skill (token-budgeted, same family as `pcd`). Judge = a `validation-agent` or `principal-architect` step.
- *Status:* **Net-new** (the §5.1 port).

**(d) `curate_journal` / `compact_journal_on_milestone`**
- *What it is:* on story close, tech_lead lifts Journal findings to Lore; on milestone done, engineer compacts archived findings into a summary.
- *Prove realization:* a skill that reads the closed task/milestone's reasoning-log findings and proposes promotions to **`scrum_decisions`** (the Codex analog). Triggered by the **scrum reconciler hook** on milestone `closed` → surfaces a "curate?" prompt.
- *Status:* **Net-new**, designed jointly with §5.1 (the reasoning log *is* the journal; promotion to a decision *is* the Codex step).

**(e) `cancel_cascade` / `supersede_re_decompose`**
- *What it is:* terminal cascade down the tree (cancel: mechanical; supersede+re_decompose: judgment — lift vs cancel each child).
- *Prove realization:* with the `parent_id` tree (§3), cancel is a **mechanical CLI walk** setting descendants `cancelled` (`scrum` operation, no LLM). Supersede = the supersession-pointer discipline (§5.3) + a re-decompose subagent step that decides lift-vs-cancel per child.
- *Status:* **Net-new**, and a concrete reason the `parent_id` migration matters — without a containment tree you can't cascade cleanly.

**(f) `re_decompose_on_discovery`** — forced bubble-up
- *What it is:* an in-flight story hits an unplanned hard dep → `blocked_by_discovery` → fires the parent role's `re_decompose`.
- *Prove realization:* the clearest trigger→control-flow translation. A subagent that hits an unplanned dependency returns a `discovery` finding; **inside a run**, the workflow script branches to a re-plan step; **across sessions**, the scrum reconciler hook sets the task `blocked`, and `next-ready` surfaces the re-decompose work to the next session.
- *Status:* **Net-new** as an explicit pattern; the hook + `next-ready` substrate already exists.

**(g) `team_terminate`** — enabling-team lifecycle. *Prove realization:* no equivalent and no near-term need (single-operator, no teams). **Defer** with §6.4.

### 2.3 The one real seam — passive triggers without a resident process

This is the only place where "let Claude Code handle the backend" is not strictly better, so be explicit about it.

onleash triggers are **passive**: the daemon evaluates every state transition against `triggers.yaml` and fires the bound workflow *even with no human present*. A decompose finishes → `story_decompose` auto-fires on each accepted child; a story hits `ready_for_close` → `story_close` auto-fires. The system progresses while you are at lunch.

claude-prove has **no resident process**, so a trigger must be realized as one of three things:

1. **Intra-run control flow** — when the whole lifecycle runs inside one `/workflows` invocation or one orchestrator session, the "trigger" is just the next statement. (AC pass → the script calls the close sequence.) Covers the common case: one autonomous run that decomposes → executes → closes.
2. **Hook-driven reconciliation + ranking** — across sessions, the scrum reconciler hook fires on `SubagentStop`/`Stop`, updates state, and `next-ready` surfaces what is now unblocked. The *next* driver session (or `/loop`, or a scheduled remote agent) picks it up. This is exactly the pattern the reconciler already implements.
3. **Explicit operator command** — `/prove:workflow`, `/prove:orchestrator` re-entered.

**What you give up:** autonomous progression *between* sessions. onleash's daemon kept firing workflows unattended; claude-prove needs a live driver. Mitigations — long autonomous orchestrator runs, `/loop`, scheduled remote agents — narrow the gap but do not close it. This is a real, deliberate tradeoff: you trade unattended progression for *zero operational surface* (no daemon to run, no socket, no sync, no single-writer coordination, no crash-recovery markers). For a single-operator tool that is almost always the right trade.

### 2.4 Target architecture

The reconciled system is two clean layers:

```
┌─ METHODOLOGY (from onleash) ───────────────────────────────────────────┐
│  charter→initiative→milestone→epic→story→task lifecycle                 │
│  role-typed decomposition · AC-gated story close · risk-forward brief   │
│  forced bubble-up · append-only memory w/ supersession                  │
│  ── expressed as: /workflows scripts + skills + structured schemas      │
│                   + the hierarchy/AC/brief/supersession data-model ports │
├─ MACHINERY (from claude-prove) ─────────────────────────────────────────┤
│  native /workflows (scheduler) · Agent tool (workers)                   │
│  scrum prove.db + run-state JSON (state) · hooks (triggers/reconcile)    │
│  validators + principal-architect (verify/judge) · acb (brief)          │
│  AskUserQuestion (gates) · worktree (isolation) · git (sync)            │
└─────────────────────────────────────────────────────────────────────────┘
   DELETED: daemon · MCP server · JSON workflow DSL · SSE inbox/ack
            · JIT prompt assembly · role-agent file resolution · S3 sync
```

Read top-down: onleash's workflows sit on prove's machinery with nothing in between. No daemon, no MCP server, no JSON DSL — the JS workflow script talks to native subagents and the `claude-prove` CLI directly.

---

## 3. Task hierarchy & data-model mapping

The methodology layer above stands on a data model. Here is exactly how onleash's hierarchy maps onto `scrum`, and the migration that closes the gap.

### 3.1 The shape mismatch (the core of it)

| | onleash | claude-prove `scrum` |
|---|---|---|
| Shape | Single **tree**, every artifact has exactly one `parent` | **Flat** (`milestone → task`) + a sibling **dep DAG** |
| Depth | 6 layers: `charter → initiative → milestone → epic → story → task` | 2 layers: `milestone → task` |
| Cross-cutting | Hard `deps:` between siblings (tree stays a tree) | `scrum_deps` (`blocks` canonical) — does double duty |
| Parent status | **Derived** (rollup from children, daemon-written) | **Authored** (`planned/active/closed`, manual) |
| How structure is created | `proposed→accepted` fires a `*_decompose` workflow | Tasks authored directly; `compile-plan` *flattens* a milestone into waves |
| AC placement | **Story** carries AC; task does not | Neither (AC is ephemeral in `plan.json`) |

The load-bearing difference: **onleash separates containment (parent/child tree) from blocking (sibling deps).** claude-prove has only deps, so `scrum_deps` is overloaded — it expresses both "B can't start until A" *and* whatever decomposition structure exists. There is no containment edge in `scrum` at all.

### 3.2 Layer-by-layer mapping

| onleash layer | Owning role | claude-prove today | Fit |
|---|---|---|---|
| **Charter** | human | `planning/VISION.md` (product-visionary) | Good — durable doctrine doc |
| **Initiative** | strategy | — (no construct) | Gap; closest is a coarse milestone or a tag |
| **Milestone** | pm | `scrum_milestones` (`target_state`) | Direct match |
| **Epic** | tech_lead | — (no construct) | **Hard gap** — where team ownership + "coherent feature" lives |
| **Story** | engineer | `scrum_tasks` *with AC* + commit unit | claude-prove `task` ≈ onleash story |
| **Task** | implementer | `plan.json` steps (ephemeral) | claude-prove has no persisted sub-task |

claude-prove **collapses onleash's epic/story/task leaf triad into one flat `task`** and pushes execution detail into the ephemeral `plan.json`. A claude-prove "task" is really an onleash "story"; an onleash "task" maps to a plan step never persisted in `scrum`.

### 3.3 Status enum mapping

```
onleash (per-layer)              claude-prove scrum_tasks
  proposed          ───────────►  backlog
  accepted          ───────────►  ready
  in_progress       ───────────►  in_progress
  blocked           ───────────►  blocked
  blocked_by_discovery ────────►  (none — folds into blocked + a discovery note)
  ready_for_close   ───────────►  review     ← prove gates on architect review; onleash on AC-pass + synthesis
  done              ───────────►  done
  cancelled         ───────────►  cancelled
  superseded        ───────────►  (none — prove soft-deletes via deleted_at)
```

Two real enum gaps: no `proposed/accepted` split (onleash uses it as the *decomposition review gate*), and no `superseded` (prove soft-deletes instead of pointing at a replacement — the §5.3 discipline).

### 3.4 What porting depth actually costs

The minimal disentangling — not all 6 layers, just a tree + rollup — is two columns:

```sql
-- migration v3: optional containment tree + layer tagging
ALTER TABLE scrum_tasks ADD COLUMN parent_id TEXT REFERENCES scrum_tasks(id);
ALTER TABLE scrum_tasks ADD COLUMN layer TEXT;   -- 'epic' | 'story' | 'task'; null = flat
CREATE INDEX idx_scrum_tasks_parent ON scrum_tasks(parent_id);
```

That buys:
- **Containment separated from blocking** — `parent_id` is the tree; `scrum_deps` stays purely for blocking. Stops overloading deps.
- **Derived status rollup** computed (not stored) in `scrum status` / `next-ready`: parent `in_progress` if any child is, `done` if all children are, `blocked` if any blocked and none in progress. Pure arithmetic, no daemon (ADR 0015 classifies rollup as mechanical).
- **Clean cancel cascade** (§2.2e) — a recursive walk over `parent_id`.
- **Optional depth** — `layer = null` keeps a project flat; set `epic`/`story` only when a milestone warrants it.

It does *not* require per-layer entity tables, the `*_decompose` trigger daemon, role-based transition authority, or `proposed/accepted` gating — those are onleash's daemon-and-teams machinery. The tree + rollup is the 20% that delivers the data-model value. Charter stays `VISION.md`; Initiative is a coarse milestone or a tag until a real fourth tier is needed.

---

## 4. Already covered (don't port — claude-prove has it)

| onleash | claude-prove equivalent |
|---|---|
| Work hierarchy + deps | `scrum` tasks/milestones/tags + `scrum_deps` DAG |
| Decision records / ADRs (Codex `adr`) | `.prove/decisions/*.md` **and** `scrum_decisions` rows (with `content_sha` drift detection) |
| Review Brief as PR body (mechanically) | `acb` per-commit intent → cross-branch PR assemble |
| Worktree-per-worker | `worktree` topic (`task/<slug>/<id>`) |
| Verification dispatch (bash/agent AC kinds) | `validators[]` (command + `phase: llm` → `validation-agent` judge) |
| Wave/fanout scheduling | `scrum compile-plan` + `orchestrator wave-plan` |
| Brief judge / adversarial review | `principal-architect` review loop |
| Handoff artifact | `handoff` topic + `/prove:task handoff\|pickup` |
| Context distillation | `pcd` + `cafi` |
| Status rollup → operator view | `scrum status` / `next-ready` / `alerts` |
| Plugin packaging, hooks, slash commands | Native plugin + `install` topic + hooks |

---

## 5. PORT — high value, low architectural friction

Pure data-model/discipline additions on existing topics, no daemon. Ordered by leverage.

### 5.1 Reasoning Log + Review Brief → grow `acb` ★ highest leverage
claude-prove's reasoning capture is its weakest area (only `scrum_events` + decisions). Port the **10 typed log entries** (`decision` w/ `alternatives`+`selected_rationale`, `discovery`, `context`, `bailout`, `hack` w/ `cleanup_condition`, `risk`, `assumption` w/ `resolved`, `synthesis`, + engine `review_feedback`/`verification`), **episode derivation** (computed from `decision` boundaries), the **7-section risk-forward Brief** (§2 surfaces every hack/risk/open-assumption first), the **preservation rule** (never drop attention-bearing content), and **multipass synthesis** (episode chunk→fragment→merge). Lands on `acb`; synthesizer is a skill (ADR 0015 classes brief synthesis as Claude-owned). **Realizes workflow (c); is the spine of (b) and (d).** Medium effort, very high value.

### 5.2 First-class acceptance criteria on scrum tasks/stories ★
AC lives only in ephemeral `plan.json` today (`compile-plan` emits `acceptance_criteria: []`). Add an `acceptance` field with the **4 kinds** (`bash`→exit0, `assert`→expression, `gate`→`AskUserQuestion`, `agent`→`validation-agent` schema judge), plus `idempotent`, `eval_order`, `rerun_policy`, `shared_acceptance` inheritance. **Realizes the AC half of workflow (b).** Medium effort, high value.

### 5.3 Closed-enum + append-only-with-supersession discipline ★ cheapest win
A principle, not code: never hard-delete; supersede with `superseded_by` + `reason`; treat taxonomies as closed/extension-gated. Add `superseded_by`+`reason` to `scrum_decisions` and retired statuses. **Realizes the supersede half of workflow (e); precondition for trustworthy briefs and any future sync.** Low effort, medium-high value.

### 5.4 Decomposition depth + derived status rollup → enrich `scrum`
The §3.4 migration: optional `epic`/`story` tier + derived rollup. **Realizes the data model under workflow (a).** Medium-high effort; keep depth optional so flat projects stay flat.

### 5.5 The spec + ADR corpus as design input ★ do first, costs nothing
Harvest onleash's spec + key ADRs into `references/` or `.prove/decisions/`: **0015** (engine boundary — the partition this whole report rests on), **0004** (native primitives / no inline prompts), forced bubble-up. High, compounding value.

---

## 6. NEEDS MORE THOUGHT — valuable but real tension

### 6.1 Inter-agent escalation / ask protocol
claude-prove is human-in-the-loop by design (escalation → `AskUserQuestion`; subagents "commit and exit"). onleash has agents file asks (`filed/accepted/rejected/countered`) and escalations (typed `blocked/ambiguous/conflict/missing_context`, auto-bubble) *autonomously*. **Salvageable without inverting the model:** the escalation *typing* enriches how a subagent reports back to the driver — return `{type: ambiguous, …}` instead of freeform, and the driver routes it. **Decision:** structured agent→driver→human escalation (recommend), not agent-to-agent autonomy.

### 6.2 Bounds as a declared contract (not a daemon-enforced wall)
Don't port the enforcement engine (daemon RPC, Bash-mutation AST, SIGKILL). Do consider bounds as **declarations** on a task, enforced by native permissions + worktree. **Decision:** reconcile with `prep-permissions` (already generates scoped `settings.local.json`) — is that the home, or a new per-task `bounds` field feeding it?

### 6.3 Memory layers (Codex / Lore / Journal)
Consider a **two-tier** version, not three: the Reasoning Log (§5.1) *is* the Journal; promotion to a `scrum_decision` *is* the Codex step. Skip team **Lore** until multi-team. **Decision:** fold into §5.1, don't build a separate memory subsystem.

### 6.4 Teams / ownership / write-scope, and 6.5 Contributor identity
Both premised on multiple teams/operators, which claude-prove is not. **Decision: defer** until a concrete multi-operator requirement exists; revisit as a bundle with 6.1.

---

## 7. DON'T PORT — obviated by native primitives or rejected by design

| onleash component | Why not |
|---|---|
| **Daemon** (socket HTTP, lifecycle, idle timeout, reload, discovery) | No persistent process by design; state is `prove.db` + git. Its reason-to-be (drive agents from outside a session) is moot. |
| **Worker spawn pipeline** (`claude --print` stream-json, per-worker MCP config, SIGTERM→SIGKILL) | Native Agent tool / `/workflows` (ADR 0004's own clarification). |
| **MCP worker/orchestrator modes** + 21 MCP tools | Re-implement, over a socket, what a native session does in-process. `work.dispatch`=`agent()`; `memory.*`=scrum/native; `log.*`=the §5.1 skill. |
| **Workflow DSL** (JSON, 6 kinds, expr mini-language) + **execution engine** (retry/loop/fanout/on_fail/concurrency) | Native `/workflows` JS is strictly more expressive; `run-state` for durable runs. The "no inline prompts" tension is a symptom of forcing prompts through JSON. |
| **Triggers binding table** (`triggers.yaml`, daemon-evaluated) | Needs the resident event loop; hook-driven reconciler covers the real cases (§2.3). |
| **Run lifecycle records** (`RN-…` frontmatter) | `run-state` JSON already does this, hook-gated. |
| **Channel delivery** (SSE, Last-Event-ID, inbox, ack, ordering) | Native channels + `reporters`. Taxonomy is reference at most. |
| **JIT prompt assembly** + input set + role-agent resolution | `orchestrator task-prompt` renders prompts; native composition covers the input set. |
| **Bounds enforcement engine** (scope-check RPC, Bash AST, SIGKILL) | Needs the daemon; native permissions + worktrees cover 80% (declaration ports — §6.2). |
| **Multi-operator sync** (S3/local, etag, offline, conflict events) | Out of scope for single-operator; git is the sync. Append-only model (§5.3) is the only keepable piece. |
| **HTML intake/report rendering** (Shoelace/Vega-Lite/Mermaid/clipboard) | Large presentation-only surface; onleash deferred it to the last phase and never shipped it. `review-ui` exists for inspection. |
| **Cancellation/interrupt machinery** (cascade daemon, interrupt events, deadline floors, race serialization) | Daemon/worker-process specific. Cancel = not dispatching + scrum `cancelled` + recursive `parent_id` walk (§2.2e). |
| **File-watch / log-buffer single-writer / crash markers** | Protect daemon-managed mutable on-disk state claude-prove designed away (SQLite + git). Solving a problem that no longer exists. |

---

## 8. Recommended sequence

1. **Harvest spec/ADRs** (§5.5) — zero-code, informs everything. Especially ADR 0015.
2. **Reasoning Log + Brief into `acb`** (§5.1) + journal/promotion tier (§6.3) as one feature — highest leverage; realizes workflows (c)/(d) and the spine of (b).
3. **Acceptance criteria on scrum tasks** (§5.2) — completes workflow (b)'s close gate.
4. **Append-only-supersession + closed-enum discipline** (§5.3) — cheap; underpins 2 and workflow (e).
5. **Hierarchy migration v3 + status rollup** (§3.4 / §5.4) — the data model under workflow (a) and clean cascades (e). Optional depth.
6. **Author the decompose-ladder and story-close `/workflows` scripts** (§2.2 a/b) on top of 2–5 — this is where onleash's *workflow experience* actually lands on prove's machinery.
7. **Reconcile declared bounds with `prep-permissions`** (§6.2) — design then small port.
8. **Defer** teams (§6.4), contributor identity (§6.5), agent-to-agent asks (§6.1) until multi-operator is real.
9. **Never port** §7.

---

## 9. One-line verdict

Scrap the engine, keep the workflows. onleash spent its budget rebuilding — in a Go daemon — the orchestration backend Claude Code now ships natively and that claude-prove deliberately delegates to the session. But it produced the best articulation of a structured-agent *methodology* (layered role-driven decomposition, AC-gated close, risk-forward briefs, append-only supersession) in either repo. Express that methodology as `/workflows` scripts + skills + the hierarchy/AC/brief/supersession data-model ports, run it on `scrum`/`run-state`/native-`/workflows`, and let Claude Code keep being the backend.
