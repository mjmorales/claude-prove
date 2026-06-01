# Content-Migration Instruction Template

Each content-reshaping hop in the run-migration registry points its
`instructions` field at one markdown file in this directory. The plan emitted by
`run-state migrate-runs` hands that path to the driver, who reads it to learn how
to reshape an artifact's content for one version step. The deterministic
`schema migrate` chain has already (or will) move the columns; an instruction
file covers only the content a model must rewrite beyond those moves.

Name each file for the hop it serves: `v<from>-to-v<to>.md` (for example
`v3-to-v4.md`). Keep it self-contained and timeless — it must stand alone with
no external reference. Use this skeleton:

---

# Content migration: v\<from\> -> v\<to\>

## Scope

Which artifact kinds this hop reshapes (prd / plan / state / reasoning-log), and
which fields within them carry content the model must rewrite.

## What the deterministic chain already did

The structural moves `schema migrate` applies for this version step, so the
driver fills reshaped content into the new shape rather than around the old one.

## Reshaping contract

For each content field: the new shape it must satisfy, stated as a precise rule
or with a before/after example. Cover the ambiguous cases — a field that splits
into two, a body that must be re-summarized against a tighter limit, a finding
that must be reclassified by reading it.

## Preservation invariants

What must survive verbatim or be carried faithfully into the new shape: every
hack, risk, bailout, open assumption, and decision alternative. Reshaping changes
a finding's shape, never its existence.

## Verification

How to confirm the reshape is complete — re-running `run-state migrate-runs` for
the run reports the artifact no longer behind, and any field-level check the
driver should apply before writing.
