---
name: reasoning-brief
description: >
  Synthesize the 7-section risk-forward Review Brief from a run's reasoning log
  (onleash 09 §10.5-10.6, audit §5.1). Triggers on "reasoning brief", "review
  brief", "synthesize the brief", "generate the brief", "brief the run", "brief
  for review", "story brief". You are the driver: the `acb brief` CLI renders a
  mechanical preservation-safe backbone and proves preservation; you synthesize
  the narrative prose (summary + changes), single-pass or multipass over episode
  chunks, then gate it through Stage-1 (mechanical, blocking) and Stage-2 (prose
  judge, advisory).
---

# Reasoning Brief Skill

You are the **driver**. Two invariants govern every phase — read them before any command:

- **Preservation is mechanical and blocking** (audit §5.1). The brief must never drop a hack, risk, bailout, open assumption, or decision alternative. `acb brief validate` proves this; ship nothing until it passes (Stage-1).
- **You write prose, not structure.** Rewrite only §1 Summary and §4 Changes from the episodes. Leave the typed sections (§2/§3/§5/§6/§7) exactly as the CLI rendered them — editing them risks dropping a preserved item.

The split is the engine boundary (`references/onleash-design-principles.md` §1): the `acb brief` CLI owns the mechanical half (render typed sections, partition episodes, prove preservation); you own the judgment half (the §1/§4 narrative).

The run dir is `.prove/runs/<branch>/<slug>`; its reasoning log lives at `<run-dir>/log/<agent>/<id>.json`.

---

## Phase 1: Render the mechanical backbone

```bash
claude-prove acb brief render --run-dir <run-dir> > brief.md
```

This is a complete, preservation-safe 7-section brief. Its §1/§4 are seeded from `synthesis` entries — placeholder prose you will replace. Everything else is final.

---

## Phase 2: Synthesize the narrative (§1 Summary, §4 Changes)

Read the episodes — each opens on a `decision` and closes at the next `decision`/`synthesis`:

```bash
claude-prove acb log episodes --run-dir <run-dir>
```

**Single-pass** (small log — one chunk): write §1 and §4 directly from the episodes. §1 Summary = the outcome in 2-4 sentences; §4 Changes = what was done, episode by episode.

**Multipass** (large log — synthesis would exceed your context): partition first, then synthesize a fragment per chunk and merge.

```bash
claude-prove acb brief chunk --run-dir <run-dir> --token-budget 6000
```

This returns `{ chunks: string[][] }` — each inner array is the decision-ids of one chunk's episodes. The partition covers every episode in order, so no episode is dropped. Synthesize a fragment per chunk (a subagent per chunk via the Agent tool, or sequentially), then merge the fragments into the final §1/§4.

Rewrite §1 and §4 in `brief.md` with your synthesized prose; leave every other section untouched.

---

## Phase 3: Stage-1 preservation gate (mechanical, blocking)

```bash
claude-prove acb brief validate --run-dir <run-dir> --file brief.md
```

Exit 0 = every attention-bearing item survived. **Exit 1 = you dropped something** — the JSON `missing` list names each one. Re-add the missing items to the relevant section and re-validate. Do not proceed until this passes.

---

## Phase 4: Stage-2 prose judge (advisory, non-blocking)

Spawn the `brief-judge` agent (Agent tool) on `brief.md` to assess accuracy, risk-forwardness, and coherence. The verdict is advisory — it never halts:

- **STRONG / ADEQUATE** — ship the brief.
- **WEAK** — append the judge's findings as a `risk` reasoning-log entry (`acb log append`), then ship. Revising is your call; the recorded `risk` is itself preservation, so the next reader sees the brief was flagged.

---

## Phase 5: Use the brief

The validated `brief.md` is the run's Review Brief — the PR body for story-close (paired with `acb assemble` for the commit-level intent) or the input to a review. The brief is the durable artifact; regenerate it from the log with `acb brief render` any time.

---

## Guards

- **Edits stay in §1/§4.** §2/§3/§5/§6/§7 are the CLI's mechanically-preserved output. Need more context? Add it to §1/§4 prose, never by rewriting a typed list.
- **Multipass only over the threshold.** A small log is one chunk — synthesize inline rather than fanning out subagents for a handful of episodes.
- **Stage-1 is the floor; Stage-2 is advice.** A Stage-1 failure is unshippable; a WEAK Stage-2 verdict ships once the finding is recorded.

## References

| File | Purpose |
|------|---------|
| `references/onleash-design-principles.md` | Engine boundary (§1) — mechanical CLI vs prose judgment |
| `agents/brief-judge.md` | The Stage-2 advisory prose judge |
| `skills/decompose/SKILL.md` | Story-close (Phase C4) drives this skill to brief a story |
