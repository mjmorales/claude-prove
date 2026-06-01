---
description: Detect project tech stack, generate .claude/.prove.json, and bootstrap project-identity artifacts (charter, team, contributor)
---

# Initialize a prove project

Two halves run here:

1. **Stack config** — delegate detection and validator emission to `claude-prove install init-config`, then layer interactive UX for scope, validator review, `.gitignore`, references, and CLAUDE.md.
2. **Project-identity bootstrap** — drive a conversational interview (or honor selection flags) and author `charter.md`, `team.md`, and a contributor record. The CLI runs the mechanical pre-flight checks and scaffolds skip-if-exists skeletons; you author the prose content into them.

`claude-prove install init-config` is the source of truth for validator detection. It writes `<cwd>/.claude/.prove.json`, preserves user-custom validators, and carries every other top-level key (`scopes`, `reporters`, `claude_md`, `tools`, ...) across re-runs.

## Invocation modes

Read the slash-command arguments to pick the identity-bootstrap scope. When no flag is given, ask the operator which artifacts to bootstrap.

- `--with-charter` → charter only
- `--with-team` → team only
- `--full` → charter + team + contributor
- `--form` → present the interview questions as one batched form (collect every answer up front), then author all artifacts in one pass
- (no flag) → ask the operator, then proceed

The engine owns the mechanical work (pre-flight checks, skip-if-exists scaffolding); you own the interview and the authored content. Never overwrite an existing charter, team, or contributor — the CLI scaffolds only what is missing, and you author only into freshly-created skeletons.

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

Use `claude-prove` directly (assumed on `PATH`). Dev-mode users alias or symlink `claude-prove` to their working-tree entry point.

```bash
PROVE_CLI=(claude-prove)
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

## Step 3.5: Project-identity bootstrap

Bootstrap `charter.md`, `team.md`, and a contributor record. The CLI gates on pre-flight checks and scaffolds only missing artifacts; you run the interview and author the content.

### Choose scope

Map the slash-command flags to the artifact set:
- `--full` → charter + team + contributor
- `--with-charter` / `--with-team` → that artifact (combinable)
- `--form` → batched-form interview (collect all answers up front), full artifact set

If no flag was passed, `AskUserQuestion` (header: "Identity"):
- "Full (Recommended)" — charter, team, and a contributor record
- "Charter only" — project vision/mission/outcome bet
- "Skip" — leave identity artifacts unmanaged

On "Skip", proceed to Step 4.

### Resolve the contributor id

A contributor record needs a slug. Derive a default from `git config user.name` (lowercase, spaces → hyphens); confirm or let the operator override with free-form input. Bind to `$CONTRIBUTOR_ID`.

### Pre-flight + scaffold (dry-run first)

Run the mechanical checks and see what is missing without writing:

```bash
"${PROVE_CLI[@]}" install bootstrap-identity --cwd "$TARGET_CWD" \
  <selection-flags> --contributor "$CONTRIBUTOR_ID" --dry-run --json
```

The result reports `preflightFailures` (each with a concrete `fix`) and the `artifacts` that would be `created` vs `skipped`. If `ok` is `false`, relay every failure and its fix to the operator, then stop — do not bootstrap until the tree is a clean checkout on an integration branch inside a git repo with the CLI on PATH.

When `ok` is `true`, run the same command without `--dry-run` to scaffold the skeletons:

```bash
"${PROVE_CLI[@]}" install bootstrap-identity --cwd "$TARGET_CWD" \
  <selection-flags> --contributor "$CONTRIBUTOR_ID" --json
```

Each scaffolded file carries a YAML frontmatter `schema_version` + `provenance` block (`created_by`, `created_at`, `last_modified_by`, `last_modified_at`) above a skeleton body with `<!-- ... -->` prompts. `skipped` artifacts already exist — leave them untouched.

### Interview + author

For every artifact the CLI reports as `created`, run a short interview and write the answers into the skeleton body, leaving the frontmatter block intact.

- **charter.md** — ask for the project's vision (future state), mission (what it does, for whom, why), and outcome bet (the measurable result). One question per exchange; replace each `<!-- ... -->` prompt with the operator's answer.
- **team.md** — ask for each team member's name, role, and responsibilities; fill the roster table.
- **contributor** (`contributors/$CONTRIBUTOR_ID.md`) — ask for the operator's name, handle, role, and current focus.

In `--form` mode, batch every question into one prompt, collect all answers, then author all artifacts in a single pass.

Do not edit the frontmatter `provenance` or `schema_version` values — they are engine-stamped. Do not author into a `skipped` artifact.

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

**Exclude built-in defaults**: skip `claude-prove-reference.md` — the composer injects it automatically when prove is configured. Offering it here would create duplicate `### claude-prove CLI Reference` entries (dedup removes the user-configured copy, but surfacing it confuses the user).

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
claude-prove claude-md generate --project-root "$TARGET_CWD" --plugin-dir "$PLUGIN_DIR"
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

Report what was created or updated, including any identity artifacts (`charter.md`, `team.md`, `contributors/<id>.md`) and which were scaffolded vs skipped. Suggest next steps:
- Review and customize validators in `$TARGET_CWD/.claude/.prove.json`
- Review the authored charter / team / contributor content
- Commit `.claude/.prove.json`, `.gitignore`, and any new identity artifacts
- Run `/prove:plan --task` or `/prove:orchestrator --autopilot`
