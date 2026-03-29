---
name: comprehend
description: >
  Post-diff Socratic quiz that builds deep comprehension of agent-generated code.
  Analyzes recent changes, generates causal/design questions, quizzes the developer
  interactively, and logs comprehension gaps.
argument-hint: "[commit SHA, range, or file path]"
---

# Comprehend: $ARGUMENTS

Generate 3-5 questions about a recent diff, quiz the developer interactively, and log comprehension gaps. Tone is collaborative, not evaluative. Max 5 questions (target 2-5 minutes).

## Phase 1: Gather Diff

1. **Scope**: Use `$ARGUMENTS` if provided (SHA, range, or path). Otherwise detect:
   - Unstaged/staged changes: `git diff`
   - Clean tree: `git diff HEAD~1`
   - Initial commit: `git show HEAD`
2. **Validate**: `git diff --stat` on chosen scope. Empty diff -- inform and stop.
3. **Large diffs** (>500 lines): Focus on structurally significant files (new files, new functions, modified control flow). If >5 files, use AskUserQuestion to let user pick focus files.
4. Show file list and line count. Proceed without confirmation unless scope seems wrong.

## Phase 2: Generate Questions

1. Read the full diff and each changed file for surrounding context.
2. Generate **5 questions** (drop to 3 if <3 functions or ~50 lines). Each targets one category:

   | Category | Example |
   |----------|---------|
   | **Causality** | "What happens if this error handler is removed?" |
   | **Design rationale** | "Why was a Map used here instead of a plain object?" |
   | **Data flow** | "Where does this config value originate and what consumes it?" |
   | **Edge cases** | "What happens when this list is empty?" |
   | **Integration** | "How does this change affect existing callers?" |

3. **Quality requirements**:
   - Reference a specific line, function, or pattern from the diff
   - Require understanding relationships between multiple parts (not single-line reads, not syntax trivia)
   - Prefer questions where a wrong answer would cause a real bug
   - Vary categories across questions

4. **Answer options per question**: One correct answer, one plausible-but-wrong answer, "I'm not sure" (last). Randomize correct/wrong position.

## Phase 3: Interactive Quiz

For each question:

1. **Present** via AskUserQuestion: header `"Q{n}/{total}"`, question prefixed with `[Category]`, three options.

2. **Respond**:
   - Correct: Brief acknowledgment + one sentence explaining *why*, referencing specific code.
   - Wrong/unsure: 2-4 sentence explanation with file/line references. Describe what bug the wrong answer would cause if relevant.

3. Track: category, question, answer, correct/incorrect.

## Phase 4: Session Summary

1. `Score: X/{total}`
2. **Rating**:
   - All correct: **Strong** -- you own this code
   - 1 wrong: **Solid** -- minor gap, noted below
   - 2 wrong: **Moderate** -- review gaps before extending this code
   - 3+ wrong: **Needs Review** -- read through changed files before proceeding
3. **Gaps** (missed questions only): category, one-line gap description, file/function to re-read
4. **Key takeaway**: one sentence on the most important thing about this diff.

## Phase 5: Log

Skip if `.prove/` directory does not exist.

AskUserQuestion (header "Log"):
- "Save to .prove/learning/" -- log for future reference
- "Skip"

If saving, write to `.prove/learning/YYYY-MM-DD-<topic-slug>.md`:

```markdown
# Comprehension Log: <topic>
**Date**: YYYY-MM-DD
**Scope**: <diff description>
**Score**: X/{total}
**Rating**: Strong | Solid | Moderate | Needs Review

## Questions
### Q1: [Category] <question>
- **Answer**: <user's answer>
- **Correct**: Yes | No
- **Explanation**: <if wrong>

## Gaps
- <category>: <gap> -- re-read `<file>:<function>`

## Takeaway
<one sentence>
```

Inform user where the log was saved.

## Committing

This skill does not modify project code. Delegate learning log commits to the `commit` skill.
