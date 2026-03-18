---
name: comprehend
description: >
  Post-diff Socratic quiz that builds deep comprehension of agent-generated code.
  Analyzes recent changes, generates causal/design questions, quizzes the developer
  interactively, and logs comprehension gaps. Use when the developer wants to understand
  code they didn't write. Triggers on "comprehend", "quiz me", "understand this code",
  "what did that change do", "explain the diff", "test my understanding".
---

# Comprehend

Build deep comprehension of code you didn't write through targeted Socratic questioning. This skill analyzes a recent diff, generates causal and design-focused questions, quizzes you interactively, explains correct answers, and optionally logs gaps for future review.

## When to Use

After an agent writes a significant chunk of code and you want to make sure you can debug, extend, and explain it — not just read it.

## Workflow

### Phase 1: Gather Diff

Determine the scope of code to quiz on.

1. **Check arguments**: If the user provided a commit SHA, range, or file path via `$ARGUMENTS`, use that as the diff scope.
2. **Default scope**: If no arguments, detect the most recent meaningful change:
   - If there are unstaged/staged changes: use `git diff` (working tree)
   - If the working tree is clean: use `git diff HEAD~1` (last commit)
   - If HEAD has no parent (initial commit): use `git show HEAD`
3. **Validate scope**: Run `git diff --stat` for the chosen scope. If the diff is empty, inform the user and stop.
4. **Large diff handling**: If the diff exceeds ~500 lines, inform the user and focus on the most structurally significant files (new files, files with new functions or modified control flow). Use AskUserQuestion to let the user pick which files to focus on if there are more than 5 changed files.
5. **Confirm scope**: Show the user the file list and line count. Proceed directly — do not ask for confirmation unless the scope seems wrong.

### Phase 2: Analyze & Generate Questions

Read the diff and generate 3-5 targeted questions.

1. **Read the full diff** using `git diff` (or `git show` for commits)
2. **Read surrounding context** for each changed file — at minimum, read the full file to understand where changes fit
3. **Generate exactly 5 questions** (drop to 3 if the diff is small/trivial). Each question MUST target one of these categories:

   | Category | Example |
   |----------|---------|
   | **Causality** | "What happens if this error handler is removed?" |
   | **Design rationale** | "Why was a Map used here instead of a plain object?" |
   | **Data flow** | "Where does this config value originate and what consumes it downstream?" |
   | **Edge cases** | "What happens when this list is empty?" |
   | **Integration** | "How does this change affect the existing callers of this function?" |

4. **Question quality rules**:
   - Every question MUST reference a specific line, function, or code pattern from the diff
   - NEVER ask syntax trivia ("What type does X return?", "What does this import do?")
   - NEVER ask questions answerable by reading a single line — questions should require understanding the relationship between multiple parts
   - Prefer questions where getting it wrong would lead to a real bug or misunderstanding during debugging
   - Vary categories — don't ask 5 causality questions

5. **Generate answer options** for each question:
   - One correct answer (concise, specific)
   - One plausible-but-wrong answer (a common misconception or superficial reading)
   - "I'm not sure" (always the last option)
   - Randomize whether the correct answer is the first or second option

### Phase 3: Interactive Quiz

Present questions one at a time.

For each question (1 through N):

1. **Present the question** using AskUserQuestion:
   - Header: `"Q{n}/{total}"`
   - Question text includes the category tag in brackets, e.g., `"[Causality] What happens if..."`
   - Options: the two answers + "I'm not sure"

2. **After the user answers**:
   - If **correct**: Acknowledge briefly ("Right.") then add one sentence of reinforcement explaining *why* it's correct, referencing the specific code.
   - If **wrong or unsure**: Explain the correct answer in 2-4 sentences. Reference the specific file and line/function. If relevant, describe what bug or misunderstanding the wrong answer would lead to.

3. **Track results** internally: for each question, record: category, question text, user's answer, whether correct.

### Phase 4: Session Summary

After all questions are answered:

1. **Score**: Display `"Score: X/{total}"`
2. **Comprehension rating**:
   - All correct → "**Strong** — you own this code"
   - 1 wrong → "**Solid** — minor gap, noted below"
   - 2 wrong → "**Moderate** — review the gaps before extending this code"
   - 3+ wrong → "**Needs Review** — spend time reading through the changed files before proceeding"
3. **Gap analysis**: For each missed question, show:
   - The category (e.g., "Data flow")
   - One-line description of the gap (e.g., "Unclear on how config propagates to middleware")
   - The file/function to re-read
4. **Key takeaway**: One sentence summarizing the most important thing to understand about this diff.

### Phase 5: Log (Optional)

1. **Check for `.prove/` directory**. If it doesn't exist, skip this phase entirely.
2. **Ask the user** via AskUserQuestion with header "Log" and options:
   - "Save to .prove/learning/" — log this session for future reference
   - "Skip" — don't log
3. **If saving**, write to `.prove/learning/YYYY-MM-DD-<topic-slug>.md`:

```markdown
# Comprehension Log: <topic>

**Date**: YYYY-MM-DD
**Scope**: <git diff description, e.g., "commit abc1234 — add auth middleware">
**Score**: X/{total}
**Rating**: Strong | Solid | Moderate | Needs Review

## Questions

### Q1: [Category] <question text>
- **Answer**: <user's answer>
- **Correct**: Yes | No
- **Explanation**: <brief explanation if wrong>

### Q2: ...

## Gaps
- <category>: <one-line gap description> → re-read `<file>:<function>`
- ...

## Takeaway
<one sentence>
```

4. Inform the user where the log was saved.

## Rules

- ALWAYS generate questions from the actual diff — never make up hypothetical scenarios unrelated to the code
- ALWAYS reference specific code (file, function, line) in questions and explanations
- NEVER ask more than 5 questions — respect the developer's time (target: 2-5 minutes per session)
- NEVER judge the user for wrong answers — the tone is collaborative, not evaluative
- NEVER skip the explanation step, even for correct answers (reinforcement matters)
- PREFER questions that would catch real bugs over academic understanding
- PREFER questions spanning multiple parts of the diff over single-line questions

## Committing

This skill does not create or modify project code. No commits are generated. If learning logs need to be committed, delegate to the `commit` skill.

**Interaction patterns**: See `references/interaction-patterns.md` for when to use `AskUserQuestion` vs free-form discussion.
