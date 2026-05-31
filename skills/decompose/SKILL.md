---
name: decompose
description: >
  Drive onleash's two structured-agent methodologies on prove primitives:
  the top-down decompose ladder (charter/VISION/milestone → epic → story →
  task) and AC-gated story-close. Triggers on "decompose", "decompose the
  milestone", "break this epic into stories", "ladder down", "decompose ladder",
  "close the story", "story close", "verify acceptance criteria", "AC-gated
  close", "run the acceptance criteria", "decompose into epics/stories/tasks".
  You are the driver Claude session: a planning subagent (Agent tool, native
  structured output) emits each layer's child list, you write children as
  layered scrum tasks, an AskUserQuestion gate promotes them, and you recurse.
  Story-close dispatches each acceptance criterion by kind (bash/assert/gate/
  agent), writes a verification reasoning-log entry per criterion, then
  delegates worktree/validation/review/merge to orchestrator full-mode.
---

# Decompose Skill

You are the **driver**. prove never spawns Claude — you do. prove emits artifacts
(the scrum tree, acceptance criteria, the reasoning log) and the `claude-prove` CLI
those subagents run; the **Agent tool** (or native `/workflows` fan-out) does every
spawn. This skill encodes two onleash methodologies on prove machinery:

- **B1 — the decompose ladder** (audit §2.2a): top-down `charter/VISION → epic →
  story → task`, one planning subagent per layer, layered scrum tasks as children,
  an accept gate per layer, forced bubble-up on discovery.
- **B2 — AC-gated story-close** (audit §2.2b): dispatch a story's acceptance criteria
  by kind, log a `verification` entry per criterion, synthesize a Review Brief, then
  hand the worktree/validation/review/merge to **orchestrator full-mode** — do not
  reimplement it.

**Source of truth is `prove.db`.** Children are scrum tasks (`parent_id` = the tree,
`layer` = the tier); criteria live on the story task; reasoning lands in the run's
`log/`. Nothing here is a throwaway in-context structure.

---

## Mode dispatch

Parse `$ARGUMENTS`. First non-flag token selects the methodology:

| Target | Mode | Path |
|--------|------|------|
| A milestone id, or `VISION.md` / a charter path | **Ladder** (B1) | Phase L1–L4 |
| A story task id (a `layer: story` task) | **Story-close** (B2) | Phase C1–C5 |
| *(none)* | Ask. Offer open milestones (`scrum status`) for the ladder, or `scrum next-ready --status review` stories for close. | — |

Flags:

| Flag | Default | Effect |
|------|---------|--------|
| `--auto-accept-through <layer>` | off | Auto-promote `backlog→ready` (skip the accept gate) for every layer at or above the named tier (`epic`/`story`/`task`). The gate still fires for tiers *below* it. |
| `--milestone <id>` | inferred | Milestone all ladder children attach to (`scrum task create --milestone`). |
| `--max-fanout <n>` | 8 | Cap on parallel planning/verification subagents per batch. |

---

## B1 — The decompose ladder

The ladder walks `epic → story → task`. Charter/`planning/VISION.md` or a milestone is
the **root input**, not a layer you create. Per layer you (1) spawn a planning subagent
with a structured-output schema, (2) write each returned child as a layered scrum task,
(3) gate accept, (4) recurse into the next tier.

### Phase L1: Resolve the root input

- **Milestone root**: read `claude-prove scrum task list --milestone <id>` and
  `claude-prove scrum status` for existing structure. The first layer you produce is
  `epic` (or `story` if the milestone is small — your judgment).
- **Charter/VISION root**: read `planning/VISION.md`. The first layer is `epic`.

Record the resolved root, target milestone, and starting layer before spawning anything.

### Phase L2: Plan one layer (a planning subagent + structured output)

Spawn **one** planning subagent per parent via the Agent tool, requesting the **native
structured-output schema** below — this replaces onleash's `*_list.json`. The schema is
the contract; the subagent returns children, never prose you have to parse.

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
        "required": ["title", "description", "blocked_by"],
        "properties": {
          "title":       { "type": "string" },
          "description": { "type": "string" },
          "blocked_by":  { "type": "array", "items": { "type": "string" },
                           "description": "titles of sibling children that must finish first" }
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

The subagent prompt carries: the parent artifact (title + description, or VISION text),
the target child `layer`, and any relevant decisions (`claude-prove scrum decision list`).

### Phase L3: Write children + accept gate

For each returned child, create a layered scrum task (status defaults to `backlog` ≈
onleash `proposed`):

```bash
claude-prove scrum task create \
  --milestone <m> --parent <parent-id> --layer <epic|story|task> \
  --title "<child.title>" --description "<child.description>"
```

Capture each new id. After all children of a parent exist, record sibling ordering with
`claude-prove scrum task add-dep <child> <blocked-child> --kind blocked_by` for every
`blocked_by` edge the schema returned.

**Accept gate** (onleash `proposed→accepted`):

- If `--auto-accept-through <layer>` covers this tier → auto-promote each child
  `backlog→ready` (`claude-prove scrum task status <id> ready`) and log the decision.
- Else → one `AskUserQuestion` (header `"Accept"`, options `Accept all` / `Revise`).
  On `Accept all`, promote each child to `ready`. On `Revise`, collect free-form
  feedback, re-run Phase L2 for that parent, and re-gate. See
  `references/interaction-patterns.md` (Approval Gate).

Only `ready` children recurse.

### Phase L4: Recurse + forced bubble-up

For each accepted child whose tier is above `task`, recurse into Phase L2 with that child
as the new parent and the next tier down. `epic → story → task` then stops; `task` is the
leaf.

**Forced bubble-up** (audit §2.3) — two paths, both mandatory, never opt-in:

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
   design — that is the deliberate §2.3 cost.

---

## B2 — AC-gated story-close

Close a `layer: story` task by verifying its acceptance criteria, logging the reasoning,
then delegating the heavy lifting to orchestrator full-mode.

### Phase C1: Read criteria from the scrum store

Read acceptance criteria from the **store**, not a compiled plan (the plan only carries
criterion text — the `verifies_by`/`check` shape lives in `prove.db`):

```bash
claude-prove scrum task acceptance list <story-id>
```

This returns each criterion's `id`, `text`, `verifies_by` (`bash`|`assert`|`gate`|`agent`),
`check`, and `status`. Skip `status: superseded` criteria — only `active` ones gate close.

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

```bash
# entry file written by the native Write tool, then ingested:
claude-prove acb log append --run-dir <run-dir> --file <entry.json>
```

A `verification` entry's shape (envelope only — no extra required fields):

```jsonc
{
  "id":       "<uuid>",
  "ts":       "2026-05-31T12:00:00Z",
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

Read the episode structure back with `claude-prove acb log episodes --run-dir <run-dir>`
(or `acb log list` for the flat entry stream) and synthesize a risk-forward brief.

> `TODO(reasoning-brief):` the multipass episode-chunk → fragment → merge **synthesizer
> is a future task** — it is Claude-owned per audit §5.1, not yet a CLI command. For now,
> synthesize the brief inline from the episodes, surfacing every `hack`/`risk`/open
> `assumption`/`bailout` first (the preservation rule), and assemble the PR body via the
> existing `acb` path:

```bash
claude-prove acb assemble --branch <branch> --base main
```

### Phase C5: Review + PR — delegate to orchestrator full-mode

Story-close is ~80% the orchestrator's existing full-mode pipeline. **Do not reimplement**
worktrees, validation, the review loop, or merge — drive
`skills/orchestrator/SKILL.md` "Full Mode" (§2c–2e):

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
        required: ["title", "description", "blocked_by"],
        properties: {
          title:       { type: "string" },
          description: { type: "string" },
          blocked_by:  { type: "array", items: { type: "string" } },
        },
      },
    },
    discovery: { type: "string" },
  },
};

const TIERS = ["epic", "story", "task"]; // root (milestone/VISION) feeds the first tier

async function decompose(parent, tierIndex, { milestone, autoAcceptThrough, maxFanout }) {
  if (tierIndex >= TIERS.length) return;          // leaf reached
  const layer = TIERS[tierIndex];

  // L2: one planning subagent per parent, structured output.
  const { children, discovery } = await phase(`plan-${parent.id}-${layer}`, () =>
    agent({
      subagent_type: "general-purpose",
      schema: childrenSchema,
      prompt: `Decompose parent "${parent.title}" into ${layer} children.\n\n` +
              `Parent description:\n${parent.description}\n\n` +
              `Return a child list; set "discovery" only on an unplanned hard dep.`,
    }),
  );

  // Forced bubble-up (in-run): a discovery re-plans this parent before proceeding.
  if (discovery) {
    parent.description += `\n\nDISCOVERY (re-plan): ${discovery}`;
    return decompose(parent, tierIndex, { milestone, autoAcceptThrough, maxFanout });
  }

  // L3: write each child as a layered scrum task (backlog ≈ proposed).
  const created = [];
  for (const c of children) {
    const out = await sh(
      `claude-prove scrum task create --milestone ${milestone} ` +
      `--parent ${parent.id} --layer ${layer} ` +
      `--title ${q(c.title)} --description ${q(c.description)}`,
    );
    created.push({ ...JSON.parse(out.stdout), blocked_by: c.blocked_by, srcTitle: c.title });
  }
  for (const child of created) {
    for (const depTitle of child.blocked_by) {
      const dep = created.find((x) => x.srcTitle === depTitle);
      if (dep) await sh(`claude-prove scrum task add-dep ${child.id} ${dep.id} --kind blocked_by`);
    }
  }

  // Accept gate (onleash proposed→accepted): auto or AskUserQuestion.
  const tierAutoAccepted =
    autoAcceptThrough && TIERS.indexOf(autoAcceptThrough) <= tierIndex;
  let accepted = created;
  if (!tierAutoAccepted) {
    const verdict = await AskUserQuestion({
      header: "Accept",
      question: `Accept these ${created.length} ${layer} children of "${parent.title}"?`,
      options: [
        { label: "Accept all", description: `Promote all ${layer} children backlog→ready` },
        { label: "Revise", description: "Give feedback; re-plan this parent" },
      ],
    });
    if (verdict === "Revise") {
      return decompose(parent, tierIndex, { milestone, autoAcceptThrough, maxFanout });
    }
  }
  for (const child of accepted) await sh(`claude-prove scrum task status ${child.id} ready`);

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

const order = criteria.find((c) => c)?.eval_order; // policy lives on the task; default fifo
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

// C4: synthesize the brief. TODO(reasoning-brief): multipass synthesizer is a future task;
// for now read the episodes and assemble the PR body via the existing acb path.
await sh(`claude-prove acb log episodes --run-dir ${runDir}`);
await sh(`claude-prove acb assemble --branch ${branch} --base ${base}`);

// C5: review + PR — delegate to orchestrator full-mode (do NOT reimplement).
//   validators → prove:principal-architect review loop → merge → gh pr create
await runOrchestratorFullMode({ storyId, runDir, branch, slug, base });

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
- **Never reimplement orchestrator full-mode.** Worktrees, validators, the
  `principal-architect` loop, and merge are `skills/orchestrator/SKILL.md`'s job. This
  skill owns the ladder, the AC dispatch, and the reasoning log — nothing else.

## References

| File | Purpose |
|------|---------|
| `docs/onleash-port-audit.md` (§2.2, §2.3, §3) | The methodology these scripts encode + the one passive-trigger seam |
| `references/onleash-design-principles.md` | Engine boundary, native primitives, forced bubble-up, append-only |
| `skills/orchestrator/SKILL.md` ("Full Mode") | The worktree/validation/review/merge pipeline story-close delegates to |
| `references/interaction-patterns.md` | AskUserQuestion accept/verify gates |
| `references/validation-config.md` | Validator phases the close gate runs |
