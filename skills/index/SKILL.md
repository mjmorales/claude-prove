---
name: index
description: >
  Build or update the content-addressable file index (CAFI) that gives agents
  routing-hint descriptions for codebase navigation. Triggers on "index the
  repo", "update the file index", "rebuild the index", "cafi", "file index".
  You are the driver: the `cafi plan` CLI emits the mechanical delta (walk,
  triage, hash, diff, batch), you generate the routing-hint descriptions —
  inline for small deltas, Agent-tool fan-out for medium, a Workflow-tool
  fan-out for large builds — and land them through the validated `cafi save`
  gate.
---

# File Index Skill

You are the **driver**. The engine boundary splits an index build in two:

- **The CLI owns the mechanical halves.** `cafi plan` walks, triages, hashes, diffs, and batches; `cafi save` validates (hash must match disk) and merges under a cache lock. Neither calls a model.
- **You own the judgment half.** Reading files and writing routing-hint descriptions happens in this session or in subagents you dispatch — the CLI never spawns one.

Two invariants:

- **A stale entry keeps its old description and hash until `save` lands the replacement.** `lookup` and the Glob/Grep gate stay useful mid-build; `status` stays truthful. Never hand-edit `.prove/file-index.json` to "fix" this.
- **Save is the only gate.** Every description enters through `cafi save`, which rejects per-file (`hash-drift`, `deleted`, `invalid-description`, `invalid-path`) instead of failing the batch. Rejections are re-work, not errors.

Run commands from the user's project root; pass `--project-root` explicitly in any dispatched subagent's prompt — you do not control a subagent's cwd.

---

## Phase 1: Plan the delta

```bash
claude-prove cafi plan [--force] [--batch-size N]
```

Emits `{ total, new, stale, deleted, unchanged, batches: [{ id, files: [{ path, hash, reason }] }] }`.

- `total == new + stale + unchanged` counts walked files; `batches` holds only the `new + stale` files needing descriptions.
- No batches and no `deleted` → report "index up to date" and stop.
- `--force` re-describes every walked file (use only when the user asks for a full rebuild).

## Phase 2: Describe — route by delta size

Count files across all batches, then pick ONE route:

| Files to describe | Route |
|---|---|
| ≤ 10 | Inline: you read and describe each file, one `save` |
| 11 – 50 | Agent-tool fan-out: one subagent per batch, each self-saves |
| > 50 | Workflow-tool fan-out over batches — gate with AskUserQuestion first |

### Description format (every route)

One paragraph, max 3 sentences, ≤ 600 chars:

> Read this file when [specific task/scenario]. Contains [what the file contains]. Key exports: [main functions/classes/constants].

- Be specific about WHEN: "when adding a new validator", not "when working with validators".
- Reading the first ~200 lines of a file is enough for a routing hint — do not read huge files whole.
- Never include the file path inside the description text.

### Save payload (every route)

```bash
claude-prove cafi save --file <payload.json>   # or pipe via stdin
```

```json
{ "files": { "<path>": { "hash": "<hash from the plan>", "description": "..." } },
  "deleted": ["<paths from plan.deleted>"] }
```

The `hash` must be copied verbatim from the plan entry — `save` recomputes from disk and rejects `hash-drift` if the file changed since. Output is `{ saved, pruned, rejected: [{ path, reason }] }`; exit 1 only on a malformed payload.

### Inline route (≤ 10)

Read each planned file, write its description, save once with the full payload including `deleted`.

### Agent fan-out route (11–50)

Dispatch one subagent per batch with the Agent tool (single message, parallel tool calls). Each subagent needs **Read, Write, and Bash** access to self-save; if you cannot grant those, fall back to the inline route and save the batches yourself. Each subagent prompt must include: the batch's `(path, hash)` list, the description format block above, the save command, and the project root. Instruct it to read its files, write the payload to a batch-unique temp file (`mktemp`), run `claude-prove cafi save --file <tmp> --project-root <root>`, and return the save result JSON — `cafi save` exits 0 even with per-file rejections, so the agent must surface a non-empty `rejected` list rather than report success. You save `deleted` yourself in a final `{ "files": {}, "deleted": [...] }` call.

Concurrent saves are safe — `save` serializes on a lockfile.

### Workflow route (> 50)

First print the projected scale (N batches, ~N agents) and confirm:

```
AskUserQuestion:
  question: "Describe <N> files in <B> batches via a workflow fan-out?"
  header: "Index build"
  options:
    - label: "Run it"
      description: "Dispatch <B> batch agents in parallel; partial progress persists per batch"
    - label: "Plan only"
      description: "Stop here; the plan output stands"
```

Then invoke the **Workflow tool** (its script API provides `meta`/`pipeline`/`agent`/`args`), passing the plan's batches as `args` (`{ projectRoot, batches }`):

```js
export const meta = {
  name: 'cafi-describe',
  description: 'Describe planned file batches and save routing hints',
  phases: [{ title: 'Describe' }],
}
const results = await pipeline(args.batches, (b) =>
  agent(
    `You are writing routing-hint descriptions for the CAFI file index of ${args.projectRoot}.
For each file below, read its first ~200 lines and write one description in exactly this format:
"Read this file when [specific task/scenario]. Contains [what]. Key exports: [names]."
Max 3 sentences, <=600 chars, no file paths inside the text, be specific about WHEN.

Files (path | hash):
${b.files.map((f) => `${f.path} | ${f.hash}`).join('\n')}

Then write {"files": {"<path>": {"hash": "<hash verbatim from the list>", "description": "..."}}}
to a unique temp file (mktemp) and run: claude-prove cafi save --file <tmp> --project-root ${args.projectRoot}
cafi save exits 0 even when files are rejected — return the JSON it prints, including any non-empty "rejected" list.`,
    { label: `batch:${b.id}`, phase: 'Describe' },
  ),
)
return results
```

Each batch agent self-saves, so an aborted run keeps every completed batch. After the workflow returns, save `deleted` yourself as in the agent route, and collect any `rejected` entries from the per-batch results for Phase 3.

## Phase 3: Verify and re-loop once

```bash
claude-prove cafi status
```

- `new == 0 && stale == 0` → done. Report totals and any `pruned` count.
- Leftovers (save rejections or files edited mid-build) → re-run `cafi plan` and describe the remaining delta **inline, once**. Still failing after that → list the paths and reasons to the operator; do not loop further.

---

## Query subcommands (no describe loop)

| Command | Purpose |
|---|---|
| `claude-prove cafi status` | new/stale/deleted/unchanged counts |
| `claude-prove cafi lookup <keyword>` | keyword search over paths + descriptions |
| `claude-prove cafi context` | full index as markdown |
| `claude-prove cafi get <path>` | one file's description |
| `claude-prove cafi clear` | delete the index cache |

## Guards

- **Never write `.prove/file-index.json` directly** — every mutation goes through `cafi save` (descriptions, pruning) or `cafi plan` (stat backfill).
- **Never re-describe unchanged files** outside `--force` — the plan's batches are the complete work list.
- **Don't escalate routes**: a 6-file delta needs no subagents; a 200-file rebuild does not belong in your context window.
