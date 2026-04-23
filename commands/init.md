---
description: Detect project tech stack and generate .claude/.prove.json configuration
---

# Initialize .claude/.prove.json

Delegate stack detection and validator emission to `prove install init-config`, then layer interactive UX for scope, validator review, `.gitignore`, references, and CLAUDE.md.

`prove install init-config` is the source of truth for validator detection. It writes `<cwd>/.claude/.prove.json`, preserves user-custom validators, and carries every other top-level key (`scopes`, `reporters`, `claude_md`, `tools`, ...) across re-runs.

## Step 0: Guard

1. Verify `$PLUGIN_DIR` is set. If not, error: "Cannot resolve plugin directory."
2. Verify `$(pwd)` is NOT inside `~/.claude/`. If it is, error: "You are inside the plugin directory. Run this command from your project root."

Stop on any failure.

## Step 1: Scope selection

`AskUserQuestion` (header: "Scope"):
- "Project (Recommended)" — target `$(pwd)/.claude/.prove.json`
- "User Global" — target `$HOME/.claude/.prove.json`

Bind the chosen directory to `$TARGET_CWD`. Default: `$(pwd)`.

## Step 2: Resolve CLI invocation

Dev mode ships CLI sources; compiled mode ships a `prove` binary.

```bash
if [ -d "$PLUGIN_DIR/packages/cli/src" ]; then
  PROVE_CLI=(bun run "$PLUGIN_DIR/packages/cli/bin/run.ts")
else
  PROVE_CLI=(prove)
fi
```

Use `"${PROVE_CLI[@]}"` for every downstream call.

## Step 3: Detect + write validators

```bash
"${PROVE_CLI[@]}" install init-config --cwd "$TARGET_CWD"
```

Behavior:
- Fresh (`$TARGET_CWD/.claude/.prove.json` absent): writes schema-versioned config with auto-detected validators.
- Existing: no-op unless `--force` is passed. With `--force`, auto-detected validators are refreshed and user-custom validators + other sections are preserved.

If the file already existed, `AskUserQuestion` (header: "Merge"):
- "Re-detect" — rerun with `--force`
- "Keep Current" — skip re-detection

On "Re-detect":
```bash
"${PROVE_CLI[@]}" install init-config --cwd "$TARGET_CWD" --force
```

## Step 4: Show sections

After the CLI returns, summarize `$TARGET_CWD/.claude/.prove.json`:

```
$TARGET_CWD/.claude/.prove.json:
  - validators: N entries (auto-detected + user-custom)
  - scopes: N entries (preserved)
  - reporters: N entries (preserved)
  - claude_md.references: N entries (preserved)
```

## Step 5: Validator review

Show the `validators` array that was written. `AskUserQuestion` (header: "Validators"):
- "Approve" — keep as-is
- "Edit" — open `$TARGET_CWD/.claude/.prove.json` for manual edits

On "Edit": instruct the user to modify the `validators` array and save. No further automated action.

## Step 6: Update .gitignore

```bash
cd "$TARGET_CWD"
grep -qxF '.prove/' .gitignore 2>/dev/null || echo '.prove/' >> .gitignore
```

## Step 7: External references for CLAUDE.md

Collect candidates from two sources.

#### Source 1: Bundled references

Scan `$PLUGIN_DIR/references/` for `.md` files. Use `$PLUGIN_DIR` as the path variable so references resolve regardless of install location.

#### Source 2: User's global CLAUDE.md

Read `~/.claude/CLAUDE.md` (skip if missing). Parse lines starting with `@` — extract the file path. Derive labels from filenames: strip extension, replace hyphens/underscores with spaces, title-case.

**Deduplication**: if a global reference matches a bundled filename, prefer the bundled version (`$PLUGIN_DIR` path is portable).

#### Present candidates

```
Bundled references (ship with plugin):
  1. $PLUGIN_DIR/references/llm-coding-standards.md — LLM Coding Standards

Global references (from ~/.claude/CLAUDE.md):
  (none after deduplication)

Already configured: (none)
```

`AskUserQuestion` (header: "References"):
- "Include All (Recommended)" — add all candidates to `claude_md.references`
- "Select" — user picks which to include
- "Add Custom" — user types additional paths, then confirm
- "Skip" — no changes

Write to `$TARGET_CWD/.claude/.prove.json` under `claude_md.references`. Use `$PLUGIN_DIR` prefix for bundled, literal paths for user-specified:

```json
{
  "claude_md": {
    "references": [
      {"path": "$PLUGIN_DIR/references/llm-coding-standards.md", "label": "LLM Coding Standards"}
    ]
  }
}
```

Merge into existing config — preserve all other sections.

## Step 8: Generate CLAUDE.md

If `$TARGET_CWD/CLAUDE.md` exists, `AskUserQuestion` (header: "CLAUDE.md"):
- "Regenerate"
- "Keep Existing"

Skip generation on "Keep Existing".

```bash
bun run "$PLUGIN_DIR/packages/cli/bin/run.ts" claude-md generate --project-root "$TARGET_CWD" --plugin-dir "$PLUGIN_DIR"
```

Show summary of generated sections.

## Step 9: Install community skills

```bash
bash "$PLUGIN_DIR/scripts/install-skills.sh" --list
```

`AskUserQuestion` (header: "Skills"):
- "Install"
- "Skip"

On "Install":
```bash
bash "$PLUGIN_DIR/scripts/install-skills.sh"
```

## Step 10: Summary

Report what was created or updated. Suggest next steps:
- Review and customize validators in `$TARGET_CWD/.claude/.prove.json`
- Commit `.claude/.prove.json` and `.gitignore`
- Run `/prove:plan-task` or `/prove:autopilot`
