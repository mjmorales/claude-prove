# Interaction Patterns

Canonical reference for user input collection. All discrete choices **must** use `AskUserQuestion`. Open-ended questions remain free-form.

## Rules

1. **Binary choices** (yes/no, approve/reject, proceed/cancel) → `AskUserQuestion` with 2 options
2. **Multiple-choice** (2-4 discrete options) → `AskUserQuestion` with 2-4 options
3. **Approval gates** (PRD, plan, permissions, cleanup) → `AskUserQuestion` with Approve + alternative
4. **Open-ended clarification** → free-form text, no `AskUserQuestion`
5. **Delegation** → `AskUserQuestion` with "Research & proceed" option

The built-in "Other" option is added automatically -- never add a manual escape-hatch.

## When to Use AskUserQuestion

| Situation | Use? | Example |
|-----------|------|---------|
| Confirm before proceeding | Yes, 2 options | "Approve / Request Changes" |
| Choose between approaches | Yes, 2-4 options | "Option A / Option B / Option C" |
| Resume vs fresh start | Yes, 2 options | "Resume / Start Fresh" |
| Deadlock resolution | Yes, 3 options | "Force Approve / Fix Manually / Abort" |
| Requirements gathering | No | Free-form discussion |
| Edge case exploration | No | Free-form discussion |
| Delegate research + decision | Yes | "Option A / Option B / Research & proceed" |
| Design tradeoff discussion | No | Free-form, then AskUserQuestion to finalize |

## Patterns

### Approval Gate

```
AskUserQuestion:
  question: "<What is being approved and where to review it>"
  header: "Approval"  # or context-specific: "PRD", "Plan", "Permissions"
  options:
    - label: "Approve"
      description: "<What happens if approved>"
    - label: "Request Changes"
      description: "I have feedback before proceeding"
```

### Binary Confirmation

```
AskUserQuestion:
  question: "<What will happen and why confirmation is needed>"
  header: "<Context>"  # e.g., "Overwrite", "Cleanup", "Ready"
  options:
    - label: "<Positive action>"
      description: "<What happens>"
    - label: "<Alternative>"
      description: "<What happens instead>"
```

### Multiple-Choice Decision

```
AskUserQuestion:
  question: "<Describe the decision and context>"
  header: "<Context>"  # e.g., "Approach", "Branch", "Resolution"
  options:
    - label: "<Option 1> (Recommended)"  # add suffix if clear best choice
      description: "<Tradeoffs>"
    - label: "<Option 2>"
      description: "<Tradeoffs>"
    - label: "<Option 3>"  # optional
      description: "<Tradeoffs>"
```

### Dynamic Options (Brainstorm)

```
AskUserQuestion:
  question: "Which approach do you prefer?"
  header: "Approach"
  options:
    - label: "<Generated option name>"
      description: "<Brief tradeoff summary>"
    # ... up to 4 options
```

### Delegation

```
AskUserQuestion:
  question: "<Describe the decision and context>"
  header: "<Context>"
  options:
    - label: "<Option 1>"
      description: "<Tradeoffs>"
    - label: "<Option 2>"
      description: "<Tradeoffs>"
    - label: "Research & proceed"
      description: "I'll investigate, choose the best option, and proceed autonomously"
```

**"Research & proceed" constraints:** Only when <=3 substantive options (4-option cap includes built-in "Other"). Never on approval gates -- those are human-in-the-loop.

**Delegation protocol** (blast-radius aware):

- **Low-stakes** (style, utility, config, naming): Research -> choose -> act -> report "I went with X because Y"
- **High-stakes** (architecture, data models, public APIs): Research -> 2-3 sentence summary + recommendation -> proceed

## Writing Good Options

- **Labels**: 1-5 words, action-oriented ("Approve", "Start Fresh", "Fix Manually")
- **Descriptions**: one sentence on what happens or the tradeoff
- **Recommended**: `(Recommended)` suffix on label, make it first option
- **Headers**: max 12 chars ("Approval", "Branch", "Approach")
- **2-4 options only**: narrow through discussion first if more exist

## Exclusions

Do not use `AskUserQuestion` for: requirements gathering, edge case exploration, nuanced tradeoff discussion (free-form first, then finalize), agent-to-agent communication, iterative refinement.
