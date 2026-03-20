# Code Quality: The Steward System

The steward system performs deep code quality audits that go beyond what linters catch. Where a linter checks syntax and style rules, the steward examines abstractions, design patterns, readability, naming, error handling, and performance — and then fixes what it finds.

The system is particularly useful after parallel agent workflows, where autonomous agents working independently tend to accumulate common quality problems: copy-paste drift, inconsistent error handling, naming collisions, orphaned helpers, and missing integration glue.

There are three commands. They share the same underlying agent but differ in scope, automation level, and when you'd reach for them.

## Three Levels

### `/prove:steward` -- Full Codebase Audit

Reads every source file in the codebase (or a scoped directory), produces a structured findings document, presents the plan for human approval, then spawns parallel subagents to implement fixes.

**Use when:**

- A major feature landed and you want a clean quality pass before moving on
- Several agent-driven tasks have accumulated and you want to consolidate quality
- You want an explicit audit trail — what was found, what was fixed

**Arguments:** `[directory or module]` to scope to a subtree, or none for the full codebase.

### `/prove:auto-steward` -- Iterative Audit-Fix Loop

Runs the same audit-fix cycle as `/prove:steward`, but keeps going. After the first pass (which requires human approval), it re-audits only the files it just modified, fixes anything new, and repeats until the audit returns clean or the iteration cap is hit. Subsequent passes are autonomous — no human gate.

**Use when:**

- You want hands-off cleanup — approve the direction once, let it run
- You expect fixing one set of issues to surface secondary issues in the same files
- You want a convergence guarantee: it stops when the re-audit finds nothing

**Arguments:**

- `--full` — audit the full codebase on pass 1 (default: changed files only)
- `--max-passes N` — set iteration cap (default: 3)
- `[directory or module]` — scope to a subtree

### `/prove:steward-review` -- Current Branch Review

Audits only the source files changed on the current branch relative to `main` (or a specified base). Same quality standards as a full audit, but the blast radius is limited to what you've already touched.

**Use when:**

- You're actively working on a branch and want quality feedback before merging
- You want to check whether new code follows existing patterns
- You want a quick loop: write, review, fix, merge

**Arguments:** `[base-branch]` — defaults to `main`.

## The Code Steward Agent

All three commands delegate the actual review work to the `code-steward` agent, which runs on Opus. The agent is a principal-engineer persona focused entirely on making code more readable, well-structured, and maintainable — it does not add features or change behavior.

**What the agent looks for:**

| Category | Examples |
| --- | --- |
| Abstraction quality | Duplicated logic that should be extracted; God objects; abstractions at the wrong level |
| Design patterns | Patterns applied inconsistently or incorrectly; anti-patterns from parallel agent work |
| Naming and readability | Vague names like `process_data`; booleans not phrased as questions; magic numbers |
| Code hygiene | Dead code; unused imports; stale TODO/FIXME markers; commented-out blocks |
| Error handling | Swallowed exceptions; non-actionable error messages; inconsistent error strategy |
| Performance | N+1 queries; unnecessary allocations; wrong data structures for the access pattern |
| Module boundaries | Files with multiple responsibilities; circular dependencies; leaky abstractions |
| Agent-generated anti-patterns | Copy-paste drift; naming collisions; stale scaffolding; orphaned helpers |

**What the agent does not do:** modify test files, add features, change behavior, or impose personal style preferences. It follows the project's established conventions.

**Tests are out of scope** for all three commands. Source changes land first — then tests can be updated as a follow-up. Tests broken by a refactor are listed in a test remediation table in the findings document.

## Workflow

### 1. Audit phase

The agent reads every source file in scope, line by line. It produces findings but does not fix anything yet. This separation matters — fixing while auditing risks missing structural issues that only become visible once the whole picture is in view.

### 2. Findings document

Structured findings are written to `.prove/steward/findings.md`:

- **Critical Issues** — bugs, security problems, severe maintainability debt (numbered, with `file:line` references)
- **Structural Refactors** — module reorganization, abstraction extraction, dependency cleanup
- **Naming and Readability** — renames, clarifications, comment improvements
- **Code Hygiene** — dead code, import cleanup, formatting
- **Performance** — optimization opportunities
- **Recommendations** — systemic improvements (linting rules, shared utilities, architectural guidelines)

A companion `fix-plan.md` groups findings into independent, parallelizable work packages — each one a coherent set of changes a single subagent can make without conflicting with other agents.

### 3. Human review (first pass only)

The findings summary and fix plan are presented with three options: approve all, cherry-pick packages, or abort and keep findings for reference.

### 4. Parallel fix agents

After approval, one `code-steward` subagent spawns per work package, running independent packages in parallel. Each agent gets its specific findings, the files to touch, and explicit instructions to make clean breaks — renaming, restructuring, and deleting are all expected.

### 5. Verification

After all fix agents complete, validators from `.prove.json` run (lint first, then tests). Test failures caused by source refactors are expected and captured in a test remediation table rather than treated as blocking failures. A final report lands at `.prove/reports/steward/report.md`.

## When to Use What

| Situation | Command |
| --- | --- |
| After a major feature branch lands | `/prove:steward` |
| Periodic codebase health pass | `/prove:steward` |
| Want hands-off cleanup with convergence guarantee | `/prove:auto-steward` |
| Several agent tasks have accumulated | `/prove:auto-steward` |
| Mid-development quality check on current branch | `/prove:steward-review` |
| Before opening a PR | `/prove:steward-review` |
| Quick check that new code follows existing patterns | `/prove:steward-review` |

**Scoping tip:** All three commands accept a directory argument. `/prove:steward skills/` audits only the `skills/` subtree — useful for large codebases where you want to focus on a specific area.
