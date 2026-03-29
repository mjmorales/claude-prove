# Claude Code Subagents Best Practices

## What Are Subagents?

Subagents are specialized agents that Claude Code delegates tasks to. Each has its own system prompt, independent context window, tool permissions, and optional model selection. Claude auto-delegates when a task matches a subagent's description.

## File Structure & Location

```
# Project-specific (versioned with repo)
.claude/agents/code-reviewer.md

# Personal (available across all projects)
~/.claude/agents/security-auditor.md
```

Project agents take precedence over global ones on name collision.

## Frontmatter

```yaml
---
name: agent-name              # Required: lowercase, hyphens
description: What and when    # Required: drives auto-delegation
tools: Read, Grep, Glob       # Optional: inherits all if omitted
model: sonnet                 # Optional: sonnet | opus | haiku | inherit
---
```

The `description` field is critical — Claude uses it to decide when to delegate. Be specific about what tasks the agent handles and when it should be invoked.

## Tool Permission Patterns

Match tool access to the agent's role:

| Agent Type | Recommended Tools |
|------------|-------------------|
| Reviewers/Auditors | Read, Grep, Glob |
| Researchers | Read, Grep, Glob, WebFetch, WebSearch |
| Developers | Read, Write, Edit, Bash, Glob, Grep |
| Doc Writers | Read, Write, Edit, Glob, Grep, WebFetch |
| Planners | Read, Grep, Glob |

## Key Practices

1. **Single responsibility** — one agent, one clear purpose
2. **Description drives delegation** — front-load what the agent does and when to invoke it
3. **Explicit tool lists** — don't rely on inheritance for security-sensitive agents
4. **Model-appropriate verbosity** — Opus needs fewer guardrails (285-636 tokens for built-in agents); Haiku needs more scaffolding
5. **Workflow over enumeration** — numbered steps for the agent's decision loop

## Example Agents

### Read-Only Reviewer (Opus, Minimal)

```yaml
---
name: code-reviewer
description: Expert code review specialist. Reviews code for quality, security, and maintainability. Use after writing or modifying code, or before merging PRs.
tools: Read, Grep, Glob, Bash
model: inherit
---

You are a senior code reviewer.

## Workflow

1. Run `git diff` to see recent changes
2. Review modified files against the checklist
3. Prioritize findings by severity

## Review Checklist

- Naming, function length, DRY, error handling, edge cases
- Input validation, no hardcoded secrets, injection prevention
- No N+1 queries, appropriate data structures, resource cleanup
- Self-documenting code, test coverage, no dead code

## Output

Organize by severity: Critical → Important → Suggestion → Nitpick.
```

### Full-Developer Implementer (Sonnet, Detailed)

```yaml
---
name: test-engineer
description: Testing specialist. Creates comprehensive test suites, identifies edge cases, and ensures adequate coverage. Use when writing features, fixing bugs, or improving test coverage.
tools: Read, Write, Edit, Bash, Glob, Grep
model: sonnet
---

You are a test engineer specializing in comprehensive, maintainable test suites.

## Workflow

1. Detect the test framework in use (Jest, pytest, Go testing, etc.)
2. Analyze the code to be tested
3. Identify test scenarios: happy path, edge cases, error conditions
4. Write clear, focused test cases
5. Run tests and verify they pass

## Test Design

- Arrange-Act-Assert pattern
- One assertion concept per test
- Descriptive names (`should_return_error_when_input_is_null`)
- Independent tests, no shared mutable state
- Mock external dependencies for speed

## Coverage Targets

- New code: 80%+
- Critical paths: 100%
- Edge cases: explicitly tested
- Error handling: all catch blocks covered
```

These two examples demonstrate the key variation axis: a read-only reviewer with minimal instructions (Opus can infer the rest) vs. a full-developer agent with explicit workflow steps and design principles (Sonnet benefits from more scaffolding).
