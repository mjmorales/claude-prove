---
description: Append or update a directive in project or user-global CLAUDE.md after LLM optimization and craft certification
argument-hint: "<directive text to add>"
---

# CLAUDE.md Update: $ARGUMENTS

`$ARGUMENTS` is the raw directive the user wants to add to a CLAUDE.md file. Never write it verbatim — it must pass optimization and certification first.

## Workflow

### 1. Resolve scope

`AskUserQuestion` — header `Scope`:
- **Project** — write to `<cwd>/CLAUDE.md`
- **User Global** — write to `$HOME/.claude/CLAUDE.md`

If **User Global**, resolve symlinks before writing:
- Run `readlink -f "$HOME/.claude/CLAUDE.md"` (or `realpath`). If it resolves into `~/.claude-envs/pool/...`, use the resolved path as the write target. Do not replace the symlink with a regular file — that silently decouples the active claude-env.
- If the path does not exist yet and `~/.claude/` is itself a symlink into `~/.claude-envs/<env>/`, create the file at the resolved pool location (`~/.claude-envs/pool/...`).

### 2. Choose action

`AskUserQuestion` — header `Action`:
- **Append** — add as a new section at end of file
- **Update Section** — replace an existing named section

If **Update Section**, ask the user (free-form) for the section heading to replace. Read the target file, locate the heading, and confirm the match before proceeding. If ambiguous or missing, fall back to Append and tell the user.

If the target file does not exist, skip this question — the directive becomes the file's first content.

### 3. Optimize via subagent

Invoke the `llm-prompt-engineer` agent (Task tool) with this prompt:

> Rewrite the following directive for inclusion in a CLAUDE.md file. CLAUDE.md is consumed as a persistent system directive by Claude on every turn. Apply primacy positioning, operational phrasing (what to do, not how to think), paired constraints (every "never X" gets an "instead, do Y"), and structural anchoring (heading + tight bullets). Preserve all semantic requirements. Output only the rewritten directive markdown — no commentary, no fences.
>
> Directive:
> $ARGUMENTS

Capture the agent's output as `DRAFT`.

### 4. Certify via craft

Run the slash command `/prove:prompting:craft` with `DRAFT` as input. This wraps the `prompting-craft` skill and produces the final certified text. Capture the certified output as `CERTIFIED`.

If craft returns revisions or flags issues, apply them and re-run craft once. If it still fails, surface the findings to the user and stop.

### 5. Review gate

Show the user:
- Target path (resolved, post-symlink)
- Action (Append / Update Section — and which section)
- `CERTIFIED` text in a fenced block

`AskUserQuestion` — header `Review`:
- **Insert** — write to disk
- **Revise** — return to step 3 with user feedback

### 6. Write

- **Append** or **new file**: append `\n\n` + `CERTIFIED` to the target (or create it with `CERTIFIED` as sole content). Ensure a single trailing newline.
- **Update Section**: replace from the matched heading up to (but excluding) the next heading of equal or higher level with `CERTIFIED`. Preserve surrounding content exactly.

Use the Edit or Write tool on the resolved path. Never follow the symlink by rewriting `~/.claude/CLAUDE.md` directly when it resolves elsewhere.

Report the write with absolute path and byte delta.

## Commit

Do not commit automatically. When the user asks to commit, delegate to the `commit` skill (`skills/commit/SKILL.md`).
