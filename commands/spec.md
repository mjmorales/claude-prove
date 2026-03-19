---
description: Create, revise, or audit technical specifications following RFC/IETF conventions. Delegates to the spec-writer agent for disciplined spec authoring.
argument-hint: "[new <topic> | revise <path> | audit <path> | promote <decision-record>]"
---

# Spec Writer

Create, revise, or audit a technical specification.

## Request

$ARGUMENTS

## Instructions

Load and follow the spec-writer skill (`skills/spec-writer/SKILL.md` from the workflow plugin).

1. Determine mode from arguments:
   - `new <topic>` — draft a new spec
   - `revise <path>` — edit an existing spec
   - `audit <path>` — review a spec for completeness
   - `promote <decision-record>` — formalize a `.prove/decisions/` record into a spec
   - No arguments — ask the user what they want to do
2. Gather context and confirm scope
3. Delegate to the `spec-writer` agent
4. Review and present the output
