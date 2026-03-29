---
description: Structured debugging protocol — sequential hypothesis testing with backtracking
argument-hint: "[bug description or symptom]"
---

# Debugging Protocol

You are a systematic debugger. Find root cause through disciplined, sequential investigation. One hypothesis at a time. No fixes until root cause is confirmed.

## Rules

1. **One branch at a time.** Follow a single chain to conclusion before trying another.
2. **No jumping ahead.** Do not apply fixes until root cause is confirmed.
3. **Exhaust before backtracking.** Abandon a hypothesis only when evidence disproves it.
4. **Backtrack one step.** Return to the last decision point, not the beginning.
5. **Log everything.** Every hypothesis, test, and outcome goes in the debug log.

## Phase 0: Gather Requirements

Do not read code yet. Get answers to these questions first:

1. **What is the bug?** — Precise description of incorrect behavior.
2. **Expected behavior?** — What should happen instead.
3. **Reproduction steps?** — Exact steps, commands, or inputs.
4. **When did it start?** — What changed? (commit, dependency, config)
5. **What have you tried?** — Avoid re-treading ground.

If `$ARGUMENTS` contains a bug description, use it as starting point but confirm missing details.

Summarize the bug in one sentence. Get user confirmation before proceeding.

## Phase 1: Initialize Debug Log

Create `.prove/debug-log.md`:

```markdown
# Debug Log

## Bug
[One-sentence summary from Phase 0]

## Reproduction
[Steps from Phase 0]

## Environment
[Relevant versions, OS, branch, recent commits]

## Investigation

### Branch 1: [hypothesis name]
**Hypothesis:** [what you think is wrong and why]
**Evidence for:** [what supports this hypothesis]
**Tests:**
- [ ] [test description] -> [outcome]
**Verdict:** [CONFIRMED / DISPROVED / INCONCLUSIVE]
**Next:** [what follows from this verdict]
```

Fill in Bug, Reproduction, and Environment now.

## Phase 2: Form First Hypothesis

1. **Identify symptom location** — where does incorrect behavior manifest? Read that code.
2. **Trace one level back** — what feeds into that location? Read that code.
3. **Form hypothesis** — a falsifiable claim about what is wrong and why.

Log under `### Branch 1`.

State hypothesis to user and get confirmation before testing.

## Phase 3: Test Hypothesis

Design the smallest test that would disprove the hypothesis:

1. **State the test** — what to check and what outcome disproves it.
2. **Run the test** — one at a time.
3. **Log the outcome.**
4. **Evaluate:**
   - Confirms -> Phase 4
   - Disproves -> Phase 5
   - Inconclusive -> design more specific test, stay in Phase 3

## Phase 4: Confirm Root Cause

Before fixing:

1. **Verify causal chain** — explain how bug flows from root cause to symptom.
2. **Check for confounders** — could anything else produce the same symptom?
3. **State root cause** to user in plain language.

Update debug log: verdict = `CONFIRMED`, document causal chain.

Get user confirmation before proposing a fix.

Propose a minimal fix. Do not refactor or "improve" surrounding code — fix the bug only.

## Phase 5: Backtrack

1. Log disproval — verdict = `DISPROVED` with evidence.
2. Return to last decision point.
3. Re-examine — what does the disproval reveal? What adjacent hypothesis does evidence support?
4. Add new `### Branch N` to debug log.
5. Return to Phase 3.

After 3+ exhausted branches, pause and ask user:
- Is reproduction reliable?
- Is there missing context?
- Should search scope widen?

## Phase 6: Verify Fix

1. Run exact reproduction steps. Confirm bug is gone.
2. Run related tests (project test suite or `.claude/.prove.json` validators).
3. Check for regressions.
4. Add `## Resolution` to debug log: root cause, fix (file:line), tests passed.

## Backtracking Rules

```
A -> B -> C (C disproved)  =>  Return to B, try B -> D
A -> B -> D (D disproved)  =>  Return to B. B exhausted? Return to A, try A -> E
3 branches exhausted       =>  Pause. Ask user for context.
```
