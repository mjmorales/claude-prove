# Session Management

Claude Code sessions have a finite context window. As a session grows longer — through conversation history, tool calls, and file reads — the model's effective attention degrades and eventually the session must end. Prove provides three commands to manage this boundary cleanly:

- `/prove:handoff` — Capture context before ending a session
- `/prove:pickup` — Resume from a handoff in a fresh session
- `/prove:comprehend` — Build comprehension of agent-generated code

## Handoff

**Command:** `/prove:handoff [optional note]`

Creates `.prove/handoff.md` — a focused, self-contained prompt that a fresh session can load directly to resume your work without rediscovery or context loss.

### What the handoff captures

| Section | Content |
| --- | --- |
| Pickup note | 3-5 sentence summary: what to do next, current blockers, key decisions made |
| Git state | Current branch, uncommitted changes, recent commits |
| Prove artifacts | Links to TASK_PLAN.md, decision records, and other `.prove/` files |
| Files to Read First | 3-7 priority-ordered files the next agent should read, each with a one-line reason |
| Instructions | Exact steps to resume, including validation commands |
| Resume command | The exact `claude` invocation to start the next session |

The pickup note is the only LLM-generated part. Everything else is assembled deterministically from git state and existing artifacts.

### Agent recommendation

After gathering context, `/prove:handoff` reads your `agents/` directory and recommends the right agent for the next session:

- If an existing agent matches the remaining work, it recommends `claude --agent agents/<name>.md --prompt-file .prove/handoff.md`
- If the work is specialized but no agent fits, it suggests creating one with `/prove:create-agent` first
- If general-purpose is sufficient, it recommends `claude --prompt-file .prove/handoff.md`

### Usage

```bash
/prove:handoff
/prove:handoff finishing the auth middleware -- tests failing in src/auth/middleware.test.ts
```

The optional note is incorporated into the pickup note. You don't need to provide one — the command gathers context from the conversation and artifacts automatically.

## Pickup

**Command:** `/prove:pickup`

Resumes work from a handoff in a fresh session. Run this as the first command in a new Claude Code session.

```bash
/prove:pickup
```

1. Reads `.prove/handoff.md`
2. Reads every file listed in "Files to Read First"
3. Reads referenced prove artifacts (task plan, decision records, etc.)
4. Tells you what it picked up and what it's about to work on
5. Deletes `.prove/handoff.md`
6. Starts working

You can also bypass `/prove:pickup` and pass the handoff file directly:

```bash
claude --prompt-file .prove/handoff.md
claude --agent agents/api-builder.md --prompt-file .prove/handoff.md
```

## When to Handoff

- **Context limits approaching** — session slowing down, responses becoming less precise, or Claude losing track of earlier decisions
- **Phase transitions** — planning is done and you're moving to implementation, or implementation is done and you're moving to review
- **Clean restart** — accumulated confusion from a long session
- **Switching focus areas** — moving from one subsystem to another where different files are relevant
- **End of day** — preserving state so work can resume later without reconstructing context

## Comprehend

**Command:** `/prove:comprehend [commit SHA, range, or file path]`

Builds deep comprehension of code you didn't write through a Socratic quiz. Designed for use after an orchestrator or agent run — when files have changed but you want to be able to debug, extend, and explain the result.

### How it works

**Scope the diff.** By default, uses the most recent change (unstaged diff, or last commit if the tree is clean). You can target a specific commit, range, or file:

```bash
/prove:comprehend
/prove:comprehend HEAD~3..HEAD
/prove:comprehend abc1234
/prove:comprehend src/auth/middleware.ts
```

**Generate questions.** Reads the diff and surrounding context, then generates 3-5 questions across these categories:

| Category | What it tests |
| --- | --- |
| Causality | What breaks if this is removed or changed |
| Design rationale | Why this approach over alternatives |
| Data flow | Where values originate and what consumes them |
| Edge cases | Behavior at boundaries and failure conditions |
| Integration | How this change affects existing callers |

Every question references a specific file, function, or code pattern from the diff — no syntax trivia, no questions answerable by reading a single line.

**Interactive quiz.** Questions are presented one at a time with two answer options plus "I'm not sure". After each answer, you get a brief explanation regardless of whether you were right.

**Summary.** After all questions: score, comprehension rating (Strong / Solid / Moderate / Needs Review), gap analysis with which files to re-read, and a one-sentence takeaway.

**Log (optional).** If `.prove/` exists, you can save the session to `.prove/learning/` for future reference.

## Workflow Example

A typical multi-session workflow:

```markdown
Session 1: Plan
   /prove:task-planner add rate limiting to the API gateway
   (long conversation about architecture decisions)
   /prove:handoff rate limiting plan finalized, ready to implement

Session 2: Execute
   /prove:pickup
   /prove:prep-permissions
   /prove:orchestrator
   /prove:handoff implementation complete, tests passing

Session 3: Review and Learn
   /prove:pickup
   /prove:comprehend HEAD~5..HEAD
   /prove:steward-review
   /prove:review
   /prove:cleanup rate-limiting
```

Each session starts clean with full context from the handoff, avoiding the problem of stale or overloaded context windows.
