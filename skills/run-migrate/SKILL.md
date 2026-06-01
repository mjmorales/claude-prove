---
name: run-migrate
description: >
  Apply model-driven CONTENT reshaping to stored run artifacts that sit behind
  the current schema, on explicit operator invocation only. Triggers on
  "migrate runs", "migrate run artifacts", "run content migration", "reshape run
  artifacts", "bring runs to current schema". You are the driver: the
  `run-state migrate-runs` CLI mechanically detects which artifacts are behind
  and emits a plan naming each one plus its migration-instruction file; you read
  the instructions and reshape the prose/findings, gated by the operator. The
  deterministic `schema migrate` handles structural column moves; this skill
  covers only the content reshaping beyond them. Never run as a background or
  resident loop — only when the operator asks.
---

# Run Content Migration Skill

You are the **driver**. Two facts govern this skill — read them before any command:

- **You run only when the operator asks.** This is an on-demand migration, never a background or resident loop. Each invocation is one explicit operator request; you plan, you propose, you apply behind an operator gate, then you stop.
- **You reshape content; the deterministic chain reshapes structure.** `schema migrate` already moves columns mechanically (version bumps, a string promoted to a structured field, a renamed key). This skill covers only what a model must do: rewriting stored prose or structured findings (a reasoning-log entry body, a synthesis outcome, a free-form risk note) to fit a new shape that no fixed rule can produce. The two compose — structural first, content second.

The `run-state migrate-runs` CLI owns the mechanical half — detect which artifacts are behind, emit the plan and its instruction files. You own the judgment half — read the prose, reshape it faithfully.

A run dir is `.prove/runs/<branch>/<slug>`; its JSON artifacts are `prd.json`, `plan.json`, `state.json`, and its reasoning log lives at `<run-dir>/log/<agent>/<id>.json`.

---

## Phase 1: Get the migration plan (mechanical)

```bash
claude-prove run-state migrate-runs > plan.json
```

This scans every run under the runs root and emits JSON: each behind-version artifact, its `fromVersion` -> `toVersion`, and the `hops` that reshape it. Narrow to one run with `--branch <b> --slug <s>`.

Read the counts on stderr and the `hops` arrays:

- **`hops` empty** for an artifact — the lag is purely structural. This skill does nothing here. Run the deterministic chain instead and stop:

  ```bash
  claude-prove schema migrate --file <artifact>
  ```

- **`hops` non-empty** — content reshaping is required. Each hop names an `instructions` file (a markdown path) and a `summary`. Proceed to Phase 2 for those artifacts.

If `artifactsNeedingContent` is 0, there is no content work — report that and stop.

---

## Phase 2: Reshape the content (judgment, operator-gated)

For each artifact with non-empty `hops`, process hops in order (lowest version first):

1. **Read the hop's instruction file** named in `hop.instructions`. It states exactly how to reshape this artifact kind's content for that version step — which fields to rewrite, the new contract they must satisfy, and what to preserve verbatim.
2. **Read the artifact** (`prd.json`/`plan.json`/`state.json`, or each `log/<agent>/<id>.json` entry for a reasoning-log).
3. **Run the deterministic structural step first** if the hop also moves columns — `schema migrate` brings the shape current; you then fill the reshaped content into the new shape. Structure before content, always.
4. **Reshape the prose/findings** per the instructions. Preserve every attention-bearing item — a hack, risk, bailout, open assumption, decision alternative is never dropped or weakened, only re-expressed in the new shape.
5. **Gate before writing.** Show the operator a before/after diff of each artifact and get explicit approval. Use `AskUserQuestion` (Approve / Revise) — this is a human-in-the-loop write to durable run state.
6. **Write** the reshaped artifact with the native Write tool (one JSON file per reasoning-log entry, the canonical layout). Then re-run `run-state migrate-runs` for that run to confirm the artifact is no longer reported behind.

---

## Phase 3: Confirm and report

```bash
claude-prove run-state migrate-runs
```

When the plan reports `artifactsBehind: 0`, the runs are current. Report to the operator: which runs and artifacts you reshaped, which were structural-only (handled by `schema migrate`), and any item you flagged while reshaping.

---

## Guards

- **On-demand only.** Never schedule this, never loop it, never run it unprompted. One operator request = one migration pass.
- **Structure before content.** A content hop that also moves columns runs `schema migrate` first; you reshape into the new shape, never around the old one.
- **Operator gates every write.** Reshaped run state is durable and auditable — propose the diff, get approval, then write. Never auto-apply.
- **Preserve, never drop.** Reshaping changes the shape of a finding, never its existence. If content cannot be faithfully carried into the new shape, stop and surface it rather than dropping it.
- **No instruction file, no content work.** If a behind-version artifact has empty `hops`, it needs no reshaping — defer it entirely to `schema migrate`.

## References

| File | Purpose |
|------|---------|
| `references/design-principles.md` | Engine boundary — mechanical CLI vs model judgment; on-demand, no resident process |
| `references/interaction-patterns.md` | The Approve / Revise operator gate before any write |
| `skills/run-migrate/assets/` | Per-hop content-migration instruction files referenced by the plan |
