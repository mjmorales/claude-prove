# Handoff Protocol

Defines how agents pass context between execution steps during orchestrated runs.

## Overview

The handoff system provides a task-scoped context directory (`.task-context/<task-slug>/`)
where agents read prior context and write discoveries for downstream steps.

## Default: Simple Handoff Log

Every agent appends to a single chronological log:

```
.task-context/<task-slug>/handoff-log.md
```

### Format

```markdown
# Handoff Log: <Task Name>

## Step 1: <description>
**Agent**: <agent-id>
**Completed**: <ISO timestamp>

### What was done
<brief summary of implementation>

### What the next step needs to know
<critical context, gotchas, API contracts established>

### Files touched
- `path/to/file.gd` — created, implements X
- `path/to/other.gd` — modified, added Y method

---

## Step 2: <description>
...
```

### Rules
- Agents MUST read the full handoff log before starting their step
- Agents MUST append their entry before completing
- Entries are append-only — never modify prior entries
- Keep entries concise — focus on what downstream agents need, not what you did

## Opt-in: Structured Context Files

For complex tasks, agents can write structured context files alongside the log:

```
.task-context/<task-slug>/
├── handoff-log.md              # always present (simple log)
├── api-contracts.md            # opt-in: interfaces established
├── discoveries.md              # opt-in: unexpected findings
├── decisions.md                # opt-in: task-local decisions (not project-level)
└── gotchas.md                  # opt-in: pitfalls for downstream steps
```

### When to use structured files
- **api-contracts.md**: When a step creates interfaces that later steps must implement against
- **discoveries.md**: When exploration reveals something that changes the approach
- **decisions.md**: When a step makes a choice that isn't in the original plan
- **gotchas.md**: When something is counter-intuitive and will trip up the next agent

### Rules for structured files
- Each file has a clear, append-friendly format (see templates below)
- Agents read ALL context files before starting, not just the log
- Creating a structured file is optional — the log alone is sufficient for simple tasks
- The orchestrator includes structured file paths in the agent prompt when they exist

## Lifecycle

1. **Orchestrator creates** `.task-context/<task-slug>/handoff-log.md` during initialization
2. **Each step agent reads** all files in `.task-context/<task-slug>/`
3. **Each step agent appends** to handoff-log.md and optionally creates/updates structured files
4. **Cleanup skill removes** `.task-context/<task-slug>/` during task cleanup (after archiving)

## Templates

### api-contracts.md
```markdown
# API Contracts

## <Interface/Class Name>
**Established by**: Step N
**Used by**: Steps M, O

\`\`\`
<signature or interface definition>
\`\`\`

**Notes**: <usage expectations, constraints>
```

### discoveries.md
```markdown
# Discoveries

## <Discovery Title>
**Found during**: Step N
**Impact**: <what this changes about the approach>
**Action**: <what downstream steps should do differently>
```

### decisions.md
```markdown
# Task-Local Decisions

## <Decision Title>
**Made during**: Step N
**Choice**: <what was decided>
**Why**: <reasoning>
**Alternatives considered**: <what was rejected>
```

### gotchas.md
```markdown
# Gotchas

## <Gotcha Title>
**Found during**: Step N
**The trap**: <what seems like the right approach but isn't>
**Instead**: <what to do instead>
```
