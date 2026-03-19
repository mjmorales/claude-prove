# Interaction Patterns

Canonical reference for how prove skills and commands collect user input. All binary choices, multiple-choice decisions, and approval gates **must** use the `AskUserQuestion` tool. Open-ended clarification questions remain free-form.

## Rules

1. **Binary choices** (yes/no, approve/reject, proceed/cancel) → `AskUserQuestion` with 2 options
2. **Multiple-choice decisions** (2-4 discrete options) → `AskUserQuestion` with 2-4 options
3. **Approval gates** (PRD, plan, permissions, cleanup) → `AskUserQuestion` with Approve + alternative option
4. **Open-ended clarification** (no discrete options) → free-form text, no `AskUserQuestion`
5. **Delegation** (user wants Claude to research and decide) → `AskUserQuestion` with "Research & proceed" option

The built-in "Other" option is automatically added by `AskUserQuestion` — do not add a manual escape-hatch option.

## When to Use AskUserQuestion

| Situation | Use AskUserQuestion? | Example |
|-----------|---------------------|---------|
| Confirm before proceeding | Yes — 2 options | "Approve / Request Changes" |
| Choose between approaches | Yes — 2-4 options | "Option A / Option B / Option C" |
| Resume vs fresh start | Yes — 2 options | "Resume / Start Fresh" |
| Deadlock resolution | Yes — 3 options | "Force Approve / Fix Manually / Abort" |
| "What problem are you solving?" | No — open-ended | Free-form discussion |
| "What should happen when [edge case]?" | No — open-ended | Free-form discussion |
| Delegate research + decision | Yes — include "Research & proceed" | "Option A / Option B / Research & proceed" |
| Design tradeoff discussion | No — nuanced | Free-form, then AskUserQuestion to finalize |

## Patterns

### Approval Gate

Used for PRD approval, plan approval, permission confirmation, cleanup confirmation, decision confirmation.

```
AskUserQuestion:
  question: "<Describe what is being approved and where to review it>"
  header: "Approval"  (or context-specific: "PRD", "Plan", "Permissions")
  options:
    - label: "Approve"
      description: "<What happens if approved>"
    - label: "Request Changes"
      description: "I have feedback before proceeding"
```

### Binary Confirmation

Used for proceed/cancel, overwrite/keep, ready/review.

```
AskUserQuestion:
  question: "<What will happen and why confirmation is needed>"
  header: "<Context>"  (e.g., "Overwrite", "Cleanup", "Ready")
  options:
    - label: "<Positive action>"
      description: "<What happens>"
    - label: "<Alternative>"
      description: "<What happens instead>"
```

### Multiple-Choice Decision

Used for design approach selection, branch resolution, deadlock resolution.

```
AskUserQuestion:
  question: "<Describe the decision and context>"
  header: "<Context>"  (e.g., "Approach", "Branch", "Resolution")
  options:
    - label: "<Option 1> (Recommended)"  # add (Recommended) if there's a clear best choice
      description: "<Tradeoffs>"
    - label: "<Option 2>"
      description: "<Tradeoffs>"
    - label: "<Option 3>"  # optional
      description: "<Tradeoffs>"
```

### Dynamic Options (Brainstorm)

When presenting options generated during discussion (e.g., brainstorm approaches):

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

Used when the user may want Claude to research options, choose the best one, and proceed autonomously instead of picking manually.

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

**When to offer "Research & proceed":** Only when there are ≤3 substantive options (to stay within the 4-option cap, since the built-in "Other" is always added). Do not add it to approval gates — those are intentionally human-in-the-loop.

**Delegation protocol** (blast-radius aware):

- **Low-stakes** (code style, utility choices, config, naming): Research silently → choose → act → report "I went with X because Y"
- **High-stakes** (architecture, data models, public APIs, approval gates): Research → present 2-3 sentence summary + recommendation → proceed without confirmation gate

## Writing Good Options

- **Labels**: 1-5 words, action-oriented ("Approve", "Start Fresh", "Fix Manually")
- **Descriptions**: One sentence explaining what happens or the tradeoff
- **Recommended**: Add `(Recommended)` suffix to the label if there's a clear best choice — make it the first option
- **Headers**: Max 12 characters, context chip ("Approval", "Branch", "Approach")
- **2-4 options only**: If more than 4 options exist, group or narrow first through discussion

## What NOT to Use AskUserQuestion For

- Requirements gathering (open-ended questions about what the user needs)
- Edge case exploration ("What should happen when...?")
- Nuanced tradeoff discussion (use free-form, then AskUserQuestion to finalize)
- Agent-to-agent communication (principal-architect verdicts, validation-agent output)
- Iterative refinement where the user needs to explain context
