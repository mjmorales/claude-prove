---
name: intake
description: >
  Gather charter, team, or decomposition-kickoff answers through a self-contained
  HTML intake form instead of a conversational interview, then drive the same
  writer the conversation would. Triggers on "intake form", "fill out a form",
  "charter form", "team form", "decompose form", "HTML form", "render an intake
  form", "form instead of questions". You are the driver: render the form with
  `claude-prove intake render`, hand the operator the file to fill and copy, read
  the pasted-back payload, validate it with `claude-prove intake validate`, and
  map the validated answers onto the existing writer (bootstrap for charter,
  `scrum team` for team, the decompose ladder for decompose). The form and the
  interview are two front-ends to ONE writer — never a second writer.
---

# Intake Skill

You turn a conversational interview into a fillable HTML form and back. The form
gathers exactly the answers the interview would; once validated, you drive the
**same** writer the conversation drives. There is one writer per artifact — the
form is a second front-end to it, never a parallel path.

**Core invariant.** The form never writes anything. It only collects answers. The
authoritative gate is `claude-prove intake validate`, and the only thing that
mutates state is the existing writer you call in Phase 4. A payload that fails
validation never reaches a writer.

**Security floor.** Intake forms refuse `secret` and `file` field types — a token
or a local path would travel in plaintext through the copy-to-clipboard step. The
CLI rejects such a spec at render time; never work around it by collecting
secrets as free `text`. Collect a credential through the operator's normal
out-of-band path instead.

---

## Phase 1: Resolve the target form

Pick the built-in form from the request:

| Form | Gathers | Writer (Phase 4) |
|------|---------|------------------|
| `charter` | vision, mission, outcome bet | bootstrap scaffold + author the charter body |
| `team` | slug, type, charter line, lifetime, scope globs, roster | `scrum team create` + `scope-set` + `rotate` |
| `decompose` | parent, target layer, milestone, planning context | the decompose ladder |

If the request is ambiguous between forms, ask with `AskUserQuestion` (header
`Form`, one option per built-in). List the built-ins any time with
`claude-prove intake list`. For a one-off shape no built-in covers, author a
custom `intake/v1` spec file and pass it with `--file` instead of `--form` — the
same validation and security floor apply.

---

## Phase 2: Render and hand off

Render the form to a self-contained HTML file (inline CSS + JS, no network):

```bash
claude-prove intake render --form <name> --out <path>.html
```

Give the operator the path and tell them to: open it, fill the fields, click
**Copy payload**, and paste the copied JSON back into the chat. The page builds
the payload as they go and copies it to the clipboard (with a select-and-copy
fallback when the clipboard API is blocked, which is common for a local file).

This is an `AskUserQuestion`-free, open-ended step. Never guess answers or
pre-fill on the operator's behalf; instead, wait for the operator to paste the
payload they copied from the form.

---

## Phase 3: Validate the pasted payload

Write the pasted JSON to a file and validate it against the same form:

```bash
claude-prove intake validate --form <name> --payload <path>.json
```

- **PASS (exit 0)** → proceed to Phase 4.
- **FAIL (exit 1)** → relay each `answers.<field>` error verbatim, ask the
  operator to fix those fields in the form and re-copy, then re-validate. Do not
  hand-edit the payload to force a pass; the operator owns the answers.

Validation confirms the envelope (`schema_version`, matching `form`), every
required field, each value's type, and choice membership. Treat its verdict as
the gate: drive a writer only from a payload that passed (exit 0), and on FAIL
loop back to the operator per the rule above rather than proceeding.

---

## Phase 4: Drive the one writer

Map the validated `answers` onto the existing writer. Field ids match the
writer's argument names where practical, so the mapping is mechanical.

### charter

The charter body is authored, not flag-passed. Scaffold the skeleton first
(dry-run to surface pre-flight failures, then for real), then write the answers
into the created skeleton:

```bash
claude-prove install bootstrap-identity --cwd <root> --with-charter --dry-run --json
claude-prove install bootstrap-identity --cwd <root> --with-charter --json
```

Replace the skeleton's body prompts with `answers.vision`, `answers.mission`,
and `answers.outcome_bet`. Leave the frontmatter the CLI stamped untouched, and
never overwrite a charter the CLI reports as already existing (`skipped`).

### team

Create the row, set scope, then rotate each filled role. Drop `terminates_on`
unless `lifetime` is `terminates_on_milestone` (a `persistent` team forbids it):

```bash
claude-prove scrum team create --slug <slug> --team-type <team_type> \
  [--charter "<charter>"] [--lifetime <lifetime>] [--terminates-on <terminates_on>]
claude-prove scrum team scope-set <slug> [--read "<scope_read>"] [--write "<scope_write>"]
```

For each of `tech_lead` / `engineer` / `implementer` the operator filled, rotate
the role to that contributor id:

```bash
claude-prove scrum team rotate <slug> --role <role> --contributor <id>
```

Skip an empty role rather than rotating it to a blank holder. Never retry a
write-scope overlap rejection blindly; instead, surface it to the operator and
let them resolve the overlap before re-running scope-set.

### decompose

The form gathers only the kickoff; the children come from the planner, not the
form. Hand the validated inputs to the decompose ladder: decompose `answers.parent`
into `answers.layer` children under `answers.milestone`, folding
`answers.context` into the planner prompt. Run the ladder's normal accept gate —
the form does not bypass it.

---

## Report the outcome

State what was written (charter body, team slug + roster, or the decomposition
that ran) and where. If Phase 3 never passed, report that nothing was written and
which fields still need fixing.
