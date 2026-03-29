# Handoff Protocol

Task-scoped context at `.prove/context/<task-slug>/` for passing context between execution steps.

## Rules

1. Agents MUST read all context files before starting their step
2. Agents MUST append to `handoff-log.md` before completing
3. Entries are append-only -- never modify prior entries
4. Focus on what downstream agents need, not what you did

## Lifecycle

1. Orchestrator creates `handoff-log.md` during initialization
2. Each step agent reads all files in `.prove/context/<task-slug>/`
3. Each step agent appends to `handoff-log.md`, optionally creates structured files
4. Cleanup skill removes the directory after archiving

## Handoff Log Format

```markdown
# Handoff Log: <Task Name>

## Step 1: <description>
**Agent**: <agent-id>
**Completed**: <ISO timestamp>

### What was done
<brief summary>

### What the next step needs to know
<critical context, gotchas, API contracts>

### Files touched
- `path/to/file` — created, implements X
- `path/to/other` — modified, added Y method

---
```

## Structured Context Files (opt-in)

For complex tasks, create alongside the log. The orchestrator includes their paths in agent prompts when they exist.

| File | When to create |
|------|---------------|
| `api-contracts.md` | Step creates interfaces later steps implement against |
| `discoveries.md` | Exploration reveals something that changes the approach |
| `decisions.md` | Step makes a choice not in the original plan |
| `gotchas.md` | Something counter-intuitive will trip up the next agent |

### Templates

**api-contracts.md**
```markdown
## <Interface/Class Name>
**Established by**: Step N  **Used by**: Steps M, O
\`\`\`
<signature or interface definition>
\`\`\`
**Notes**: <usage expectations, constraints>
```

**discoveries.md**
```markdown
## <Discovery Title>
**Found during**: Step N
**Impact**: <what this changes>
**Action**: <what downstream steps should do differently>
```

**decisions.md**
```markdown
## <Decision Title>
**Made during**: Step N
**Choice**: <what was decided>
**Why**: <reasoning>
**Alternatives considered**: <what was rejected>
```

**gotchas.md**
```markdown
## <Gotcha Title>
**Found during**: Step N
**The trap**: <what seems right but isn't>
**Instead**: <what to do>
```
