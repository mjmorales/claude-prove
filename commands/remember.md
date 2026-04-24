---
description: Append or update a directive in CLAUDE.md outside the prove-managed section
argument-hint: "<directive text>"
---

# Remember: $ARGUMENTS

Grow project or user-global CLAUDE.md with a user-authored directive. Never write `$ARGUMENTS` verbatim — route through optimize (Step 4) and certify (Step 5) before writing. Never write inside the prove-managed block. Never auto-commit.

## Step 1: Clarify thin input

If `$ARGUMENTS` is empty, under ~20 chars, or missing a clear subject/verb/scope, ask one focused free-form question to extract the directive's intent and scope. Do not proceed with a vague draft. Do not delegate thin input to the optimizer.

If `$ARGUMENTS` is substantive, skip to Step 2.

## Step 2: Resolve target

`AskUserQuestion` (header: "Scope"):

- **Project** — `<cwd>/CLAUDE.md`
- **User Global** — `$HOME/.claude/CLAUDE.md`

For **User Global**, resolve symlinks first:

```bash
readlink -f "$HOME/.claude/CLAUDE.md"
```

Write to the resolved path. Never overwrite the symlink with a regular file — that decouples the active claude-env. If the file does not exist yet and `~/.claude/` resolves into `~/.claude-envs/<env>/`, create it at the resolved pool location.

Record the resolved absolute path as `TARGET`.

## Step 3: Choose action

If `TARGET` does not exist, skip this step — the directive becomes the file's first content (treat as Append, no marker check).

Otherwise, `AskUserQuestion` (header: "Action"):

- **Append** — new section at EOF, strictly after `<!-- prove:managed:end -->` if present
- **Update Section** — replace an existing named section

On **Update Section**: ask free-form for the section heading, then read `TARGET` and locate it. If the heading is ambiguous or absent, fall back to Append and tell the user why.

## Step 4: Optimize via llm-prompt-engineer

Invoke the `llm-prompt-engineer` agent via the Task tool with:

> Rewrite the following directive for inclusion in a CLAUDE.md file. CLAUDE.md is consumed as a persistent system directive by Claude on every turn. Apply primacy positioning, operational phrasing (what to do, not how to think), paired constraints (every "never X" gets an "instead, do Y"), and structural anchoring (heading + tight bullets). Preserve all semantic requirements. Output only the rewritten directive markdown — no commentary, no fences.
>
> Directive:
> $ARGUMENTS

Capture output as `DRAFT`.

## Step 5: Certify via craft

Run `/prove:prompting craft` with `DRAFT` as input. Capture output as `CERTIFIED`.

If craft flags issues: apply them once and re-run. If it still fails, surface findings and stop — do not write.

## Step 6: Review gate

Show the user:

- `TARGET` (resolved absolute path)
- Action (Append, or Update Section + heading)
- `CERTIFIED` in a fenced markdown block

`AskUserQuestion` (header: "Review"):

- **Insert** — write to disk
- **Revise** — return to Step 4 with user feedback

## Step 7: Write

- **Append**: locate `<!-- prove:managed:end -->` in `TARGET` if present; insertion point is strictly after that marker. Otherwise EOF. Write `\n\n` + `CERTIFIED` and ensure a single trailing newline.
- **New file**: write `CERTIFIED` as sole content with a single trailing newline.
- **Update Section**: replace from the matched heading through (but excluding) the next heading of equal or higher level with `CERTIFIED`. Preserve surrounding content byte-for-byte.

Use Edit or Write on `TARGET`. Never write inside the managed block. Never commit — report the absolute path and byte delta, then stop.
