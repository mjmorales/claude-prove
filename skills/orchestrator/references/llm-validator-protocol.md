# LLM Validator Protocol

Execution contract for prompt validators (`phase: "llm"` in `.claude/.prove.json`). Command validators run inline; LLM validators require subagent dispatch because implementation agents cannot spawn `validation-agent` — the orchestrator owns LLM validation.

## When It Runs

After all command validators in earlier phases (`build`, `lint`, `test`, `custom`) pass. Orchestrator runs LLM validators last in the validation gate.

## Per-Validator Steps

1. Read the prompt file referenced by the validator's `prompt` field.
2. Generate the diff for the scope under review. Resolve commit SHAs from `state.json` (not `HEAD`) — retry/WIP commits can shift `HEAD`:
   - **Simple mode** (per-step): `git diff <prev_step_commit>..<current_step_commit>`, where `<current_step_commit>` is the SHA recorded by `scripts/prove-run step-complete`. First step → diff against the branch base.
   - **Full mode** (per-task): `git diff <base-branch>...HEAD` inside the task worktree (all task commits are ahead of base).
3. Launch the validator (pseudo-code — adapt to the Agent tool's single-prompt-string contract):
   ```
   Agent(
     subagent_type: "validation-agent",
     prompt: <concatenation of:
       "## Validation Prompt\n" + {prompt markdown content} + "\n\n"
       "## Changes to Validate\n```diff\n" + {diff} + "\n```\n\n"
       "## Instructions\nEvaluate against the prompt criteria. Return PASS/FAIL with findings."
     >
   )
   ```
   Model binding lives on the `validation-agent` definition — do not override here, to avoid drift.
4. Record the outcome:
   ```bash
   scripts/prove-run validator <step_id> llm pass   # or fail
   ```

## Failure Handling

One auto-fix attempt, then halt:

1. **Simple mode**: orchestrator applies the fix inline (implementation is orchestrator-local), then re-runs validators.
2. **Full mode**: the implementation subagent has already exited (`commit, exit` contract). Orchestrator launches a fix subagent in the same task worktree with the validator findings, waits for commit, then re-runs validators.
3. Still failing → `scripts/prove-run step-halt <step_id> --reason "llm validation failed"`, commit WIP, halt execution.

## Constraints

- Subagents MUST NOT spawn `validation-agent` themselves — only the orchestrator (canonical statement; do not duplicate elsewhere).
- LLM validators are never auto-detected; they only run when declared in `.claude/.prove.json`.
- The `validation-agent` returns structured PASS/FAIL plus findings referencing files + line numbers (shape documented in `references/validation-config.md`).
