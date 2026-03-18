#!/usr/bin/env python3
"""
Initialize planning workspace for a specific task step.
Usage: python3 init_planning_workspace.py <step_number> [task_title]
"""

from __future__ import annotations

import sys
from datetime import datetime
from pathlib import Path


def create_planning_workspace(
    step_number: str, task_title: str = "[Task Title]"
) -> tuple[Path, list[str]]:
    """Create the planning workspace directory and all template files."""

    # Create the directory
    workspace_dir = Path(f".prove/plans/plan_{step_number}")
    workspace_dir.mkdir(parents=True, exist_ok=True)

    # Get current timestamp
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M")

    # Define all template files
    templates = {
        "00_task_overview.md": f"""# Task {step_number}: {task_title}

**Phase**: [Phase name from PLAN.md]
**Size Estimate**: [XS/S/M/L/XL/XXL]
**Status**: Planning
**Dependencies**: [List task dependencies]

## Original Task Description
[Full description from PLAN.md]

## Verification Criteria
[From tcg_implementation_plan.md if available]

## Related Tasks
- [List related/dependent tasks with numbers]
""",

        "01_requirements.md": f"""# Requirements for Task {step_number}

## Functional Requirements
- [ ] [Specific, measurable requirement]
- [ ] [Another requirement]

## Non-Functional Requirements
- [ ] Performance: [specific expectations]
- [ ] Error handling: [approach]
- [ ] Logging: [requirements]
- [ ] Security: [considerations]

## Acceptance Criteria
- [ ] [Testable criterion]
- [ ] [Another criterion]

## Out of Scope
- [Explicitly excluded items]
""",

        "02_design_decisions.md": f"""# Design Decisions for Task {step_number}

## Approach Options

### Option 1: [Name]
**Pros:**
- [Advantage]

**Cons:**
- [Disadvantage]

### Option 2: [Name]
**Pros:**
- [Advantage]

**Cons:**
- [Disadvantage]

## Selected Approach
[Which option and why]

## Technical Choices
- **Technology/Library**: [Choice] because [reason]
- **Pattern**: [Choice] because [reason]

## API/Interface Design
[Define contracts and interfaces]
""",

        "03_open_questions.md": f"""# Open Questions for Task {step_number}

## Technical Questions
1. **Q:** [Question about implementation?]
   **A:** [Answer when resolved]

2. **Q:** [Question about technology choice?]
   **A:** [Pending]

## Design Questions
1. **Q:** [Architecture question?]
   **A:** [Answer]

## Requirements Questions
1. **Q:** [Unclear requirement?]
   **A:** [Clarification]

---
*Mark questions as resolved by adding answers*
""",

        "04_potential_issues.md": f"""# Potential Issues for Task {step_number}

## Technical Risks
- **Risk**: [Description]
  **Mitigation**: [Strategy]

## Edge Cases
- [Edge case scenario]
  - How to handle: [approach]

## Performance Concerns
- [Potential bottleneck]
  - Solution: [approach]

## Integration Points
- [System/component to integrate with]
  - Consideration: [what to watch for]
""",

        "05_implementation_plan.md": f"""# Implementation Plan for Task {step_number}

## Prerequisites
- [ ] [What must be in place first]
- [ ] [Dependencies resolved]

## Implementation Steps
1. **[Step name]**
   - Action: [What to do]
   - Files: [Files to create/modify]
   - Validation: [How to verify]

2. **[Next step]**
   - Action: [What to do]
   - Files: [Files affected]
   - Validation: [How to verify]

## Code Structure
```
[Show file/folder structure]
```

## Key Implementation Notes
- [Important consideration]
- [Technical detail to remember]
""",

        "06_test_strategy.md": f"""# Test Strategy for Task {step_number}

## Unit Tests
- **Test**: [What to test]
  **Expected**: [Expected behavior]

## Integration Tests
- **Scenario**: [Description]
  **Setup**: [Required setup]
  **Expected**: [Expected outcome]

## Edge Case Tests
- **Case**: [Edge case]
  **Expected**: [How it should handle]

## Manual Testing Steps
1. [Step to verify functionality]
2. [Another verification step]

## Test Coverage Goals
- [Coverage target and rationale]
""",

        "progress.md": f"""# Planning Progress for Task {step_number}

**Started**: {timestamp}
**Current Phase**: Requirements Gathering

## Planning Checklist
- [ ] Task overview completed
- [ ] Requirements documented
- [ ] Design decisions made
- [ ] Open questions resolved
- [ ] Potential issues identified
- [ ] Implementation plan drafted
- [ ] Test strategy defined
- [ ] Ready for implementation

## Discussion Log
### {timestamp}
- Planning workspace initialized
"""
    }

    # Create all files
    created_files: list[str] = []
    for filename, content in templates.items():
        file_path = workspace_dir / filename
        file_path.write_text(content)
        created_files.append(str(file_path))

    return workspace_dir, created_files


def main() -> None:
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    step_number = sys.argv[1]
    task_title = " ".join(sys.argv[2:]) if len(sys.argv) > 2 else "[Task Title]"

    try:
        workspace_dir, created_files = create_planning_workspace(step_number, task_title)
        print(f"Created planning workspace: {workspace_dir}/")
        print("\nInitialized files:")
        for file in created_files:
            print(f"  - {file}")
        print(f"\nNext step: Review PLAN.md and update {workspace_dir}/00_task_overview.md with actual task details")
    except Exception as e:
        print(f"Error creating workspace: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
