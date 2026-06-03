---
name: decompose
description: >
  Drive two structured-agent methodologies on prove primitives:
  the top-down decompose ladder (charter/VISION/milestone → epic → story →
  task) and AC-gated story-close. Triggers on "decompose", "decompose the
  milestone", "break this epic into stories", "ladder down", "decompose ladder",
  "close the story", "story close", "verify acceptance criteria", "AC-gated
  close", "run the acceptance criteria", "decompose into epics/stories/tasks".
  You are the driver Claude session: a planning subagent (Agent tool, native
  structured output) emits each layer's child list, you write children as
  layered scrum tasks, an AskUserQuestion gate promotes them, and you recurse.
  Story-close dispatches each acceptance criterion by kind (bash/assert/gate/
  agent), writes a verification reasoning-log entry per criterion, promotes the
  run's durable decisions into the scrum decision store (human-gated), then
  delegates worktree/validation/review/merge to orchestrator full-mode.
---

# Decompose Skill

You are the **driver**. prove never spawns Claude — you do. prove emits artifacts
(the scrum tree, acceptance criteria, the reasoning log) and the `claude-prove` CLI
those subagents run; the **Agent tool** (or native `/workflows` fan-out) does every
spawn. This skill encodes two methodologies on prove machinery:

- **B1 — the decompose ladder**: top-down `charter/VISION → epic →
  story → task`, one planning subagent per layer, layered scrum tasks as children,
  an accept gate per layer, forced bubble-up on discovery.
- **B2 — AC-gated story-close**: dispatch a story's acceptance criteria
  by kind, log a `verification` entry per criterion, synthesize a Review Brief,
  promote durable `decision` entries into the decision store, then hand the
  worktree/validation/review/merge to **orchestrator full-mode** — do not
  reimplement it.

**Source of truth is `prove.db`.** Children are scrum tasks (`parent_id` = the tree,
`layer` = the tier); criteria live on the story task; reasoning lands in the run's
`log/`. Nothing here is a throwaway in-context structure.

### Two knowledge tiers

Story-close moves knowledge between two distinct tiers, and the distinction governs
Phase C5:

- **The reasoning log** — the run's append-only journal under `<run-dir>/log/`. Every
  `decision`, `verification`, `hack`, `risk`, and `assumption` lands here as it
  happens. It is run-scoped, exhaustive, and disposable in the sense that no future
  session is expected to re-read a finished run's raw log.
- **The decision store** (`scrum_decisions`) — the project's durable, cross-run memory.
  A row here is a standing fact a future session must not have to rediscover. It is
  append-only with supersession: a replaced decision is superseded (the new one carries
  a back-pointer and a reason), never overwritten.

The reasoning log is where a decision is *made*; the decision store is where a decision
that outlives its run is *kept*. Phase C5 is the named bridge between the two at
story-close — the per-story analogue of the milestone-close curation pass
(`skills/curate/SKILL.md`), which performs the same promotion across a whole milestone's
tasks. Story-close promotes the decisions of one story's run; milestone-close sweeps the
whole milestone for findings the story-close passes left behind. They are the same move
at two scopes — do not reimplement one inside the other.

---

## Mode dispatch

Parse `$ARGUMENTS`. First non-flag token selects the methodology:

| Target | Mode | Path |
|--------|------|------|
| An initiative name (the `--initiative` grouping) | **Ladder** (B1), initiative pre-step | Phase L1 (pre-step) → L2–L4 per milestone |
| A milestone id, or `VISION.md` / a charter path | **Ladder** (B1) | Phase L1–L4 |
| A story task id (a `layer: story` task) | **Story-close** (B2) | Phase C1–C6 |
| *(none)* | Ask. Offer open milestones (`scrum status`) for the ladder, or `scrum next-ready --status review` stories for close. | — |

Flags:

| Flag | Default | Effect |
|------|---------|--------|
| `--auto-accept-through <layer>` | off | Auto-accept cascade: auto-promote `proposed→accepted` (skip the accept gate) for every layer at or above the named tier (`epic`/`story`/`task`). `<layer>` names the **deepest hands-free layer** — the gate still fires for tiers *below* it. E.g. `--auto-accept-through epic` runs the epic tier hands-free and gates story/task (the milestone root has no task-status accept gate). |
| `--milestone <id>` | inferred | Milestone all ladder children attach to (`scrum task create --milestone`). |
| `--max-fanout <n>` | 8 | Cap on parallel planning/verification subagents per batch. |

---

## B1 — The decompose ladder

The ladder walks `initiative → milestone → epic → story → task`. An initiative, a
charter/`planning/VISION.md`, or a milestone is the **root input** — you enter the ladder at
whichever tier your root sits above. Per layer you (1) spawn a planning subagent with a
structured-output schema, (2) write each returned child (a milestone entity at the
initiative tier; a layered scrum task at the rest), (3) gate accept (`proposed → accepted`),
(4) recurse into the next tier. Each layer's decompose **fires when its parent reaches
`accepted`** — the accept gate of one tier is the trigger for the next tier's decompose.

### Layer personas

Each planning subagent gets a **layer-appropriate persona** so it decomposes at the right
altitude — a PM thinking in capabilities produces different epics than a generic planner.
The persona is keyed by the **parent layer being decomposed** (equivalently, by the child
layer it produces one tier down).

**Four personas are active across the full ladder** — `initiative → milestone → epic →
story → task`. Each fires when its parent reaches `accepted` (the decomposition-review gate
that promotes `proposed → accepted`), and produces the next tier down. Spawn only these:

| Parent decomposed | Child produced | Planning persona | Decomposition frame |
|-------------------|----------------|------------------|---------------------|
| `initiative` | `milestone` | **strategy@initiative** | Strategy lead splitting an initiative into milestones — each a coherent outcome slice with a target state, sharing the initiative grouping. Produces `scrum_milestones` (via `scrum milestone create --initiative`), not tasks. |
| `milestone` | `epic` | **pm@milestone** | Product manager splitting a milestone into epics — coherent user-facing capabilities, each a scoped slice of the milestone outcome. |
| `epic` | `story` | **tech_lead@epic** | Tech lead splitting an epic into stories — architectural seams + integration order; each story independently shippable and verifiable. |
| `story` | `task` | **engineer@story** | Engineer splitting a story into tasks — concrete PR-sized implementation units, each with a clear acceptance check. |

**Two shapes, not one.** The `initiative → milestone` tier creates milestone *entities*
(`scrum milestone create --initiative <init>`); the `milestone → epic → story → task` tiers
create layered *tasks* (`scrum task create --parent --layer`). The initiative tier is the
pre-step that seeds the per-milestone ladders; the recursion below it has the single
task-create shape.

**One persona is excluded** — never spawn it from this ladder:

| Persona | Why it is excluded |
|---------|--------------------|
| **implementer@task** | The leaf executor, not a planner. A `task` is the leaf — it is never decomposed further; the implementer executes it under story-close / orchestrator full-mode. |

### Phase L1: Resolve the root input

- **Initiative root** (the pre-step): with a `strategy@initiative` planning subagent, split
  the initiative into milestones and create each as a milestone entity
  (`claude-prove scrum milestone create --title "<m>" --target-state "<...>" --initiative
  <init>`). Milestones carry no `proposed`/`accepted` task-status, so this tier has no
  store-level accept gate — the operator decides which milestone's ladder to run next. Then
  enter the recursion at each milestone root below. This pre-step is out of the recursive
  task-tier driver (the embedded `/workflows` script starts at a milestone root).
- **Milestone root**: read `claude-prove scrum task list --milestone <id>` and
  `claude-prove scrum status` for existing structure. The first layer you produce is
  `epic` (or `story` if the milestone is small — your judgment).
- **Charter/VISION root**: read `planning/VISION.md`. The first layer is `epic`.

Record the resolved root, target milestone, and starting layer before spawning anything.

### Phase L2: Plan one layer (a planning subagent + structured output)

Spawn **one** planning subagent per parent via the Agent tool, requesting the **native
structured-output schema** below — the schema is the typed child-list contract that
replaces free-form prose. The schema is the contract; the subagent returns children,
never prose you have to parse.

```jsonc
// children schema — the native structured-output `schema` passed to agent()
{
  "type": "object",
  "required": ["children"],
  "properties": {
    "children": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["title", "description", "blocked_by", "acceptance"],
        "properties": {
          "title":       { "type": "string" },
          "description": { "type": "string" },
          "blocked_by":  { "type": "array", "items": { "type": "string" },
                           "description": "titles of sibling children that must finish first" },
          "acceptance":  {
            "type": "array",
            "description": "verifiable close criteria for this child; REQUIRED non-empty for a `story` child, since a story cannot reach ready/in_progress/done with zero active criteria",
            "items": {
              "type": "object",
              "required": ["text", "verifies_by"],
              "properties": {
                "text":       { "type": "string",
                                "description": "what must hold for the child to be done" },
                "verifies_by":{ "type": "string", "enum": ["bash", "assert", "gate", "agent"],
                                "description": "how the close floor checks it" },
                "check":      { "type": "string",
                                "description": "kind-specific payload — shell command (bash), boolean expr (assert), operator prompt (gate), or agent prompt (agent)" },
                "idempotent": { "type": "boolean",
                                "description": "true if the check is safe to re-run; required true for the parallel close path" }
              }
            }
          }
        }
      }
    },
    "discovery": {
      "type": "string",
      "description": "set ONLY if an unplanned hard dependency outside this parent's scope was found (forced bubble-up); else omit"
    }
  }
}
```

The subagent prompt carries: the **layer persona** for the child layer (see *Layer
personas* above — `epic → pm@milestone`, `story → tech_lead@epic`, `task → engineer@story`)
as the opening role frame, the parent artifact (title + description, or VISION text), the
target child `layer`, and any relevant decisions (`claude-prove scrum decision list`).

**Each `story` child must return a non-empty `acceptance` array.** A story is the unit
story-close verifies, and the store rejects a `layer: story` task on `→ ready|in_progress|
done` with zero active criteria — so the planning subagent authors each story's criteria
here, at the same moment it proposes the story. The persona writes the criteria as the
engineer who will verify them: prefer `bash` checks with a runnable `check` command, fall
back to `assert`/`agent` when no command captures the intent, and reserve `gate` for
judgment a human must make. Mark a criterion `idempotent: true` when its check is safe to
re-run. `epic` and `task` children may carry `acceptance` when the planner has a concrete
check in mind, but only `story` children are obligated to.

### Phase L3: Write children + accept gate

For each returned child below the initiative tier, create a layered scrum task, then move it
to `proposed` — the decomposed-but-not-yet-reviewed state (a fresh task is `backlog`; the act
of decomposing it INTO existence is what makes it `proposed`):

```bash
claude-prove scrum task create \
  --milestone <m> --parent <parent-id> --layer <epic|story|task> \
  --title "<child.title>" --description "<child.description>"
claude-prove scrum task status <child-id> proposed
```

(At the `initiative → milestone` tier the child is a milestone entity instead:
`claude-prove scrum milestone create --title "<child.title>" --target-state "<...>"
--initiative <init>` — milestones carry no `proposed`/`accepted` task-status, so their accept
gate is the operator's decision to start the milestone's own ladder.)

Capture each new id. After all children of a parent exist, record sibling ordering with
`claude-prove scrum task add-dep <child> <blocked-child> --kind blocked_by` for every
`blocked_by` edge the schema returned.

**Author acceptance criteria at creation.** For each criterion in a child's `acceptance`
array, attach it to the new task:

```bash
claude-prove scrum task acceptance add <child-id> \
  --text "<criterion.text>" --verifies-by <bash|assert|gate|agent> \
  --check "<criterion.check>" [--idempotent]
```

Pass `--idempotent` only when the criterion's `idempotent` is true; omit `--check` when the
criterion carries none. Authoring criteria here is what makes a `story` born already
satisfying the close floor: B2 story-close reads these exact criteria to verify the story,
so the ladder that creates the story owns its criteria and close never has to invent them.
If a `story` child returned an empty `acceptance` array, re-run Phase L2 for that parent
before promoting — accept then `ready` would push it to a state the floor rejects for a
criteria-less story (criteria are enforced at `→ ready`, the state the accepted child enters
once its deps clear).

**Accept gate** (`proposed → accepted` — the decomposition review). Acceptance is the trigger
that fires the next tier's decompose; it does NOT itself start work (`accepted → ready`
happens once deps clear):

- If `--auto-accept-through <layer>` covers this tier → auto-promote each child
  `proposed → accepted` (`claude-prove scrum task status <id> accepted`) and log the decision.
- Else → one `AskUserQuestion` (header `"Accept"`, options `Accept all` / `Revise`).
  On `Accept all`, promote each child `proposed → accepted`. On `Revise`, collect free-form
  feedback, re-run Phase L2 for that parent, and re-gate. See
  `references/interaction-patterns.md` (Approval Gate).

Only `accepted` children recurse.

### Phase L4: Recurse + forced bubble-up

For each accepted child whose tier is above `task`, recurse into Phase L2 with that child
as the new parent and the next tier down. `initiative → milestone → epic → story → task`
then stops; `task` is the leaf.

**Forced bubble-up** — two paths, both mandatory, never opt-in:

1. **In-run** (a discovery surfaces *during* this driver session): a planning or
   implementation subagent returns a `discovery` finding (the schema field above, or a
   `discovery` reasoning-log entry). Branch immediately to a re-plan step — re-run Phase
   L2 for the affected parent with the discovery folded into its prompt, then re-gate.
   The trigger is just the next statement in the script.
2. **Across sessions** (the session ends before re-plan): set the affected task
   `claude-prove scrum task status <id> blocked` and append a `discovery` entry to the
   run log. The scrum reconciler hook (`scrum hook subagent-stop|stop`) records it and
   `claude-prove scrum next-ready` surfaces the re-decompose work to the next driver.
   prove has no resident process, so unattended progression does not happen here by
   design — that is the deliberate cost of trading autonomous between-session firing for
   zero operational surface.

---

## B2 — AC-gated story-close

Close a `layer: story` task by verifying its acceptance criteria, logging the reasoning,
promoting the durable decisions into the decision store, then delegating the heavy
lifting to orchestrator full-mode.

### Phase C1: Read criteria from the scrum store

Read acceptance criteria from the **store**, not a compiled plan (the plan only carries
criterion text — the `verifies_by`/`check` shape lives in `prove.db`):

```bash
claude-prove scrum task acceptance list <story-id>
```

This returns each criterion's `id`, `text`, `verifies_by` (`bash`|`assert`|`gate`|`agent`),
`check`, `status`, and `idempotent` (the parallel / `failed_only` path requires every active
criterion `idempotent: true`). Skip `status: superseded` criteria — only `active` ones gate
close. Note `acceptance list` emits the **criteria array only**; the `acceptance.policy`
(eval order) lives on the task — read it from `claude-prove scrum task show <story-id>`.

### Phase C2: Dispatch each criterion by `verifies_by`

| `verifies_by` | How you verify | Pass condition |
|---------------|----------------|----------------|
| `bash` | Run `check` as a shell command. | exit 0 |
| `assert` | Evaluate the `check` boolean expression over this run's outputs (validator results, file state). | expression is true |
| `gate` | `AskUserQuestion` (header `"Verify"`) showing `check` as the prompt. | operator approves |
| `agent` | Spawn a `prove:validation-agent` subagent with `check` (the criterion text) as its prompt. | agent returns PASS |

Run in the criteria's array order unless the task's `acceptance.policy.eval_order` is
`parallel` (then fan out, capped at `--max-fanout`). A criterion that fails halts close —
record the failing criterion id and stop; the story stays open.

### Phase C3: Write a `verification` reasoning-log entry per criterion

Per criterion, write one reasoning-log entry. The native **Write** tool writes the JSON
file (one entry per file — no Bash quoting of multi-line bodies); `acb log append` is the
validated ingest path. The run dir is the story's run directory
(`.prove/runs/<branch>/<slug>`).

Entry validation is **strict-closed**: only the envelope (`id`/`ts`/`type`/`agent`/`run_path`/
`body`) plus each type's required fields are allowed — extra keys are rejected. Encode
criterion detail in `body`, not new keys. (`acb log append` ingests from any `--file` path;
the scripts below stage entries in a disposable `_staging/` scratch dir before ingest — that
dir is the script's own convention, not a required run-dir structure.)

```bash
# entry file written by the native Write tool, then ingested:
claude-prove acb log append --run-dir <run-dir> --file <entry.json>
```

A `verification` entry's shape (envelope only — no extra required fields):

```jsonc
{
  "id":       "<uuid>",
  "ts":       "<iso-8601-utc>",
  "type":     "verification",
  "agent":    "driver",
  "run_path": "<run-dir>",
  "body":     "AC ac-login-returns-jwt (bash): `go test ./auth -run TestJWT` exited 0. PASS."
}
```

After all criteria pass, write one closing `synthesis` entry (requires an `outcome` field)
summarizing the close — it also closes the open reasoning episode:

```jsonc
{
  "id": "<uuid>", "ts": "...", "type": "synthesis", "agent": "driver",
  "run_path": "<run-dir>",
  "body": "All 5 acceptance criteria verified for story <id>; ready for review.",
  "outcome": "story <id> AC-complete, brief assembled, review next"
}
```

### Phase C4: Synthesize the Review Brief

**Draw the story-close brief from the flat `acb log list` stream, never from
`acb log episodes` alone.** Read the stream with `claude-prove acb log list --run-dir
<run-dir>` and synthesize a risk-forward brief over every entry in `ts` order — the
`verification` entries plus the closing `synthesis`. An episode opens only on a `decision`
entry; a story-close that passes its criteria logs `verification` entries and one closing
`synthesis` and records no `decision`, so `acb log episodes` returns an empty set for it
and would yield a degenerate brief. The flat stream carries every entry regardless of
episode boundaries, so it is the correct source whenever a close has no decisions to anchor
episodes on. Use `acb log episodes` only as a supplementary lens when decisions exist
(decompose/impl runs); an empty result there is expected, not an error.

> `TODO(reasoning-brief):` the multipass chunk → fragment → merge **synthesizer is a
> future task** — it is Claude-owned (the synthesis is model judgment), not yet a CLI
> command. For now, synthesize the brief inline from the flat entry stream, surfacing every
> `hack`/`risk`/open `assumption`/`bailout` first (the preservation rule), and assemble the
> PR body via the existing `acb` path:

```bash
claude-prove acb assemble --branch <branch> --base main
```

### Phase C5: Promote durable decisions into the decision store

Bridge the two tiers (see *Two knowledge tiers*): surface the run's episode-closing
`decision` entries and promote the durable ones into `scrum_decisions`. A story's run
carries `decision` entries only when its work weighed a real choice (the decompose/impl
episodes that built it); a pure-verification close logs only `verification` entries and
records no `decision`, so this phase is a no-op for it. **Promoting zero decisions is a
valid outcome, not a failure** — promote on significance, never on count.

**The promotion is judgment-side, never mechanical.** The model surfaces candidates and
the operator decides which promote; do not blanket-promote every `decision` entry.
Instead, gate the set behind one `AskUserQuestion` and record only the chosen ones. The
reasoning: a decision the engine cannot read for significance would corrupt the durable
store with run-local narration the engine has no context to repair.

1. **Surface candidates from the journal.** Read the run's episodes — each opens on a
   `decision` entry:

   ```bash
   claude-prove acb log episodes --run-dir <run-dir>
   ```

   An empty result means the run recorded no decisions — skip this phase. Otherwise each
   episode's opening `decision` entry (its `alternatives` and `selected_rationale`) is a
   promotion candidate.

2. **Classify each candidate by content**, not by source — `adr` (an engineering
   decision of record: what was chosen, alternatives, rationale), `glossary` (a durable
   definition or resolved assumption that became a project fact), or `pattern` (a
   recurring solution shape, anti-pattern, or tracked tech-debt). Promote only decisions
   that carry signal **beyond this run** — something a future session must not
   rediscover; treat run-local narration as noise that stays in the log.

3. **Gate the promotion set** with one `AskUserQuestion` (header `"Promote"`,
   `references/interaction-patterns.md` Approval Gate), stating each candidate's proposed
   kind and a one-line title:
   - **Promote selected** — record each chosen decision as classified.
   - **Revise** — adjust the kind/title/skip set, then re-present.

4. **Record each chosen promotion** (append-only, supersession-aware). First dedup
   against the standing store so a promotion never duplicates an existing decision:

   ```bash
   claude-prove scrum decision list --kind <kind>     # add --topic for a tighter match
   ```

   For a fresh promotion, author the decision file with the native **Write** tool (prose
   lives in a file, never an inline flag — model-consumed text must be reviewable as
   text), then record it under its kind and link it back to the story task:

   ```bash
   # 1. Write .prove/decisions/<slug>.md (native Write tool): title, topic, status,
   #    and a body carrying the choice, its rationale, and provenance (source entry id,
   #    run_path, story id).
   # 2. Record under its decision kind (only adr|glossary|pattern, case-insensitive):
   claude-prove scrum decision record .prove/decisions/<slug>.md --kind <adr|glossary|pattern>
   # 3. Link back to the story task that surfaced it:
   claude-prove scrum task link-decision <story-id> .prove/decisions/<slug>.md
   ```

   If an equivalent decision already exists and this one refines or replaces it,
   **supersede** instead of adding — record the new decision first, then point the old
   one at it (append-only: never overwrite):

   ```bash
   claude-prove scrum decision supersede <old-id> --by <new-id> --reason "<why it changed>"
   ```

The reasoning log stays intact — promotion only *copies* a decision into durable memory;
it never edits or deletes the journal. A skipped candidate stays in the log for the
milestone-close `curate` pass to reconsider.

### Phase C6: Review + PR — delegate to orchestrator full-mode

Story-close is ~80% the orchestrator's existing full-mode pipeline. **Do not reimplement**
worktrees, validation, the review loop, or merge — drive
`skills/orchestrator/SKILL.md` "Full Mode" (the validation-gate, architect-review, and
merge-back steps):

1. Run validators (the command/LLM gates from `references/validation-config.md`) — these
   are the mechanical analog of `bash`/`assert`/`agent` criteria.
2. Run the `prove:principal-architect` review loop (refute-until-approved) on the story's
   worktree via `claude-prove orchestrator review-prompt`.
3. On approval, merge per orchestrator full-mode, then open the PR with the assembled brief
   as its body (`gh pr create`).
4. Mirror status back: `claude-prove scrum task status <story-id> done` (or `blocked` on
   halt), then `claude-prove scrum link-run <story-id> <run-path> --branch <b> --slug <g>`.

---

## Canonical `/workflows` scripts

The deterministic control flow the driver runs on the native Workflow tool. `phase()`,
`agent({ schema })`, `parallel()`, and `AskUserQuestion` are native primitives; every CLI
string below is a real `claude-prove` command verified to exist. These are the runnable
shape — fill in ids/paths from the resolved run.

### B1 — decompose ladder

```js
// decompose-ladder.workflow.js — driver control flow for the ladder.
const childrenSchema = {
  type: "object",
  required: ["children"],
  properties: {
    children: {
      type: "array",
      items: {
        type: "object",
        required: ["title", "description", "blocked_by", "acceptance"],
        properties: {
          title:       { type: "string" },
          description: { type: "string" },
          blocked_by:  { type: "array", items: { type: "string" } },
          // Verifiable close criteria; non-empty REQUIRED for a `story` child — a story
          // cannot reach ready/in_progress/done with zero active criteria.
          acceptance: {
            type: "array",
            items: {
              type: "object",
              required: ["text", "verifies_by"],
              properties: {
                text:        { type: "string" },
                verifies_by: { type: "string", enum: ["bash", "assert", "gate", "agent"] },
                check:       { type: "string" },
                idempotent:  { type: "boolean" },
              },
            },
          },
        },
      },
    },
    discovery: { type: "string" },
  },
};

// Task-tier ladder. The `initiative → milestone` tier is the pre-step that seeds each
// milestone (a different shape — `scrum milestone create --initiative`, no task status), so
// this recursive driver starts at a milestone root and walks the task tiers below it.
const TIERS = ["epic", "story", "task"]; // milestone root feeds the first tier

// Layer persona keyed by the child layer being produced (see "Layer personas"). The
// strategy@initiative persona drives the initiative→milestone pre-step, not this recursion.
const LAYER_PERSONAS = {
  epic:  "You are a product manager (pm@milestone). Split this milestone into epics — coherent user-facing capabilities, each a scoped slice of the milestone outcome.",
  story: "You are a tech lead (tech_lead@epic). Split this epic into stories — architectural seams and integration order; each story independently shippable and verifiable.",
  task:  "You are an engineer (engineer@story). Split this story into tasks — concrete PR-sized implementation units, each with a clear acceptance check.",
};

async function decompose(parent, tierIndex, { milestone, autoAcceptThrough, maxFanout }) {
  if (tierIndex >= TIERS.length) return;          // leaf reached
  const layer = TIERS[tierIndex];

  // L2: one planning subagent per parent, with the layer-appropriate persona.
  const { children, discovery } = await phase(`plan-${parent.id}-${layer}`, () =>
    agent({
      subagent_type: "general-purpose",
      schema: childrenSchema,
      prompt: `${LAYER_PERSONAS[layer]}\n\n` +
              `Decompose parent "${parent.title}" into ${layer} children.\n\n` +
              `Parent description:\n${parent.description}\n\n` +
              `Return a child list; set "discovery" only on an unplanned hard dep.`,
    }),
  );

  // Forced bubble-up (in-run): a discovery re-plans this parent before proceeding.
  if (discovery) {
    parent.description += `\n\nDISCOVERY (re-plan): ${discovery}`;
    return decompose(parent, tierIndex, { milestone, autoAcceptThrough, maxFanout });
  }

  // L3: write each child as a layered scrum task, then move it to `proposed` (decomposed,
  // awaiting the accept review).
  const created = [];
  for (const c of children) {
    const out = await sh(
      `claude-prove scrum task create --milestone ${milestone} ` +
      `--parent ${parent.id} --layer ${layer} ` +
      `--title ${q(c.title)} --description ${q(c.description)}`,
    );
    const task = JSON.parse(out.stdout);
    await sh(`claude-prove scrum task status ${task.id} proposed`);
    created.push({
      ...task,
      blocked_by: c.blocked_by,
      acceptance: c.acceptance ?? [],
      srcTitle: c.title,
    });
  }
  for (const child of created) {
    for (const depTitle of child.blocked_by) {
      const dep = created.find((x) => x.srcTitle === depTitle);
      if (dep) await sh(`claude-prove scrum task add-dep ${child.id} ${dep.id} --kind blocked_by`);
    }
  }

  // Author each child's acceptance criteria at creation, so a `story` is born satisfying
  // the close floor (a story with zero active criteria is rejected on →ready/done) and B2
  // story-close reads these exact criteria. A `story` with no criteria must be re-planned,
  // not promoted — the accept gate below would push it to a state the floor rejects.
  for (const child of created) {
    if (layer === "story" && child.acceptance.length === 0) {
      parent.description += `\n\nDISCOVERY (re-plan): story "${child.srcTitle}" returned no acceptance criteria.`;
      return decompose(parent, tierIndex, { milestone, autoAcceptThrough, maxFanout });
    }
    for (const ac of child.acceptance) {
      const idemFlag = ac.idempotent ? " --idempotent" : "";
      const checkFlag = ac.check ? ` --check ${q(ac.check)}` : "";
      await sh(
        `claude-prove scrum task acceptance add ${child.id} ` +
        `--text ${q(ac.text)} --verifies-by ${ac.verifies_by}${checkFlag}${idemFlag}`,
      );
    }
  }

  // Accept gate (proposed→accepted) — the decomposition review that fires the next tier.
  // auto_accept_through names the DEEPEST hands-free layer: every tier from the top down
  // THROUGH it auto-accepts; tiers BELOW it gate. So this tier is hands-free when its depth
  // is at or above the named layer's depth (tierIndex <= indexOf), else it gates.
  const tierAutoAccepted =
    autoAcceptThrough && tierIndex <= TIERS.indexOf(autoAcceptThrough);
  let accepted = created;
  if (!tierAutoAccepted) {
    const verdict = await AskUserQuestion({
      header: "Accept",
      question: `Accept these ${created.length} ${layer} children of "${parent.title}"?`,
      options: [
        { label: "Accept all", description: `Promote all ${layer} children proposed→accepted` },
        { label: "Revise", description: "Give feedback; re-plan this parent" },
      ],
    });
    if (verdict === "Revise") {
      return decompose(parent, tierIndex, { milestone, autoAcceptThrough, maxFanout });
    }
  }
  // Accept fires the next tier's decompose; `accepted → ready` happens later once deps clear.
  for (const child of accepted) await sh(`claude-prove scrum task status ${child.id} accepted`);

  // L4: recurse into the next tier, fanned out within the cap.
  await parallel(
    accepted.map((child) => () =>
      decompose(child, tierIndex + 1, { milestone, autoAcceptThrough, maxFanout }),
    ),
    { limit: maxFanout },
  );
}

await decompose(rootParent, 0, { milestone, autoAcceptThrough, maxFanout: 8 });
```

### B2 — AC-gated story-close

```js
// story-close.workflow.js — driver control flow for AC-gated close.
const storyId = ARGS.story;
const runDir = ARGS.runDir;            // .prove/runs/<branch>/<slug>
const branch = ARGS.branch, slug = ARGS.slug, base = "main";

// C1: read criteria from the STORE (not the compiled plan).
const criteria = JSON.parse(
  (await sh(`claude-prove scrum task acceptance list ${storyId}`)).stdout,
).filter((c) => c.status === "active");

// C2 + C3: dispatch by kind, log a verification entry per criterion.
async function verify(c) {
  let pass = false, note = "";
  if (c.verifies_by === "bash") {
    const r = await sh(c.check, { allowFail: true });
    pass = r.exitCode === 0; note = `exit ${r.exitCode}`;
  } else if (c.verifies_by === "assert") {
    pass = evalAssertion(c.check, runOutputs); note = `assert(${c.check})`;
  } else if (c.verifies_by === "gate") {
    const v = await AskUserQuestion({
      header: "Verify", question: c.check,
      options: [{ label: "Pass", description: "Criterion met" },
                { label: "Fail", description: "Not met" }],
    });
    pass = v === "Pass"; note = "operator gate";
  } else if (c.verifies_by === "agent") {
    const v = await agent({ subagent_type: "prove:validation-agent", prompt: c.check });
    pass = /PASS/.test(v); note = "validation-agent";
  }
  const entry = {
    id: uuid(), ts: nowIso(), type: "verification", agent: "driver",
    run_path: runDir,
    body: `AC ${c.id} (${c.verifies_by}): ${note}. ${pass ? "PASS" : "FAIL"}.`,
  };
  await writeFile(`${runDir}/_staging/${entry.id}.json`, JSON.stringify(entry)); // native Write
  await sh(`claude-prove acb log append --run-dir ${runDir} --file ${runDir}/_staging/${entry.id}.json`);
  return { c, pass };
}

// eval order lives on the task's acceptance.policy, NOT on a criterion, and `acceptance
// list` returns only the criteria array — fetch the policy from `task show`.
const task = JSON.parse((await sh(`claude-prove scrum task show ${storyId}`)).stdout).task;
const order = task.acceptance?.policy?.eval_order ?? "fifo";
const results = order === "parallel"
  ? await parallel(criteria.map((c) => () => verify(c)), { limit: 8 })
  : await sequence(criteria.map((c) => () => verify(c)));

if (results.some((r) => !r.pass)) {
  return halt(`AC failed: ${results.filter((r) => !r.pass).map((r) => r.c.id).join(", ")}`);
}

// Closing synthesis entry (closes the episode).
const synth = {
  id: uuid(), ts: nowIso(), type: "synthesis", agent: "driver", run_path: runDir,
  body: `All ${criteria.length} acceptance criteria verified for story ${storyId}.`,
  outcome: `story ${storyId} AC-complete; review next`,
};
await writeFile(`${runDir}/_staging/${synth.id}.json`, JSON.stringify(synth));
await sh(`claude-prove acb log append --run-dir ${runDir} --file ${runDir}/_staging/${synth.id}.json`);

// C4: synthesize the brief from the FLAT entry stream — a pure-verification close records
// no `decision`, so `acb log episodes` would be empty; `acb log list` carries every entry.
// TODO(reasoning-brief): multipass synthesizer is a future task; for now read the flat
// stream and assemble the PR body via the existing acb path.
await sh(`claude-prove acb log list --run-dir ${runDir}`);
await sh(`claude-prove acb assemble --branch ${branch} --base ${base}`);

// C5: promote durable decisions journal→decision store — judgment-side, human-gated.
// Each episode opens on a `decision`; a pure-verification close has none (no-op).
const episodes = JSON.parse(
  (await sh(`claude-prove acb log episodes --run-dir ${runDir}`)).stdout,
).episodes ?? [];
const candidates = episodes
  .map((ep) => ep.opener)          // the episode-opening `decision` entry
  .filter((d) => significantBeyondRun(d)); // model judgment, not a counter
if (candidates.length > 0) {
  // ONE gate for the whole set — never blanket-promote.
  const verdict = await AskUserQuestion({
    header: "Promote",
    question: `Promote these ${candidates.length} decision(s) into the durable store?`,
    options: [
      { label: "Promote selected", description: "Record each chosen decision as classified" },
      { label: "Revise", description: "Adjust kinds/skip set, then re-present" },
    ],
  });
  if (verdict === "Promote selected") {
    for (const d of chosen(candidates)) {           // operator's selection
      const kind = classify(d);                     // adr | glossary | pattern (by content)
      const path = `.prove/decisions/${slugify(d)}.md`;
      await writeFile(path, decisionMarkdown(d, { storyId, runDir })); // native Write; body carries provenance
      // Dedup/supersede against the standing store before adding (append-only).
      const dupe = findEquivalent(d, kind);
      const rec = JSON.parse((await sh(`claude-prove scrum decision record ${path} --kind ${kind}`)).stdout);
      if (dupe) await sh(`claude-prove scrum decision supersede ${dupe.id} --by ${rec.id} --reason ${q("refined at story-close")}`);
      await sh(`claude-prove scrum task link-decision ${storyId} ${path}`);
    }
  }
}

// C6: review + PR — delegate to orchestrator full-mode (do NOT reimplement).
//   Not a CLI call and not defined here — an intentional delegation seam: drive
//   skills/orchestrator/SKILL.md "Full Mode" (validation gate → architect review → merge-back) —
//   validators → prove:principal-architect review loop → merge → gh pr create. See prose C6.

// Mirror status back to scrum.
await sh(`claude-prove scrum task status ${storyId} done`);
await sh(`claude-prove scrum link-run ${storyId} ${runDir} --branch ${branch} --slug ${slug}`);
```

---

## Guards

- **Verify the tree before recursing.** A `--parent` that doesn't exist fails the
  `scrum task create` (exit 1, `unknown parent_id`) — surface it, don't swallow it.
- **`--auto-accept-through` is documented and logged.** When it skips a gate, append a
  `decision` reasoning-log entry recording that the tier was auto-accepted and why, so the
  brief can trace it.
- **Story-close halts on the first failing criterion.** Do not partially close — the story
  stays open; mark it `blocked` only if the failure needs another session.
- **Promotion is judgment-gated, never automatic.** Phase C5 promotes a decision only on
  significance and only through the operator gate; do not blanket-promote every `decision`
  entry, and never edit or delete the journal — promotion copies into the durable store,
  the log stays intact for the milestone-close `curate` pass.
- **Never reimplement orchestrator full-mode.** Worktrees, validators, the
  `principal-architect` loop, and merge are `skills/orchestrator/SKILL.md`'s job. This
  skill owns the ladder, the AC dispatch, and the reasoning log — nothing else.

## References

| File | Purpose |
|------|---------|
| `references/design-principles.md` | Design principles — the engine boundary (mechanical CLI vs model judgment), native primitives, forced bubble-up, append-only |
| `skills/orchestrator/SKILL.md` ("Full Mode") | The worktree/validation/review/merge pipeline story-close delegates to |
| `references/interaction-patterns.md` | AskUserQuestion accept/verify/promote gates |
| `references/validation-config.md` | Validator phases the close gate runs |
| `skills/curate/SKILL.md` | The milestone-close curation pass — the same journal→decision-store promotion at milestone scope (Phase C5 is its per-story analogue) |
