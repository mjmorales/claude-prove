---
description: Detect project tech stack, generate .claude/.prove.json, and bootstrap project-identity artifacts (charter, team, contributor)
---

# Initialize a prove project

Two halves run here:

1. **Stack config** — delegate detection and validator emission to `claude-prove install init-config`, then layer interactive UX for scope, validator review, `.gitignore`, references, and CLAUDE.md.
2. **Project-identity bootstrap** — drive a conversational interview (or honor selection flags) and author `charter.md`, `team.md`, and a contributor record, then bring the identity chain live: register the contributor in the scrum registry (minting its CT-UUID) and offer operator-of-record + default-contributor wiring. The CLI runs the mechanical pre-flight checks and scaffolds skip-if-exists skeletons; you author the prose content into them.

`claude-prove install init-config` is the source of truth for validator detection. It writes `<cwd>/.claude/.prove.json`, preserves user-custom validators, and carries every other top-level key (`scopes`, `reporters`, `claude_md`, `tools`, ...) across re-runs.

## Invocation modes

Read the slash-command arguments to pick the identity-bootstrap scope. Flags map to the artifact set:

- `--with-charter` → charter only (combinable with `--with-team`)
- `--with-team` → team only (combinable with `--with-charter`)
- `--full` → charter + team + contributor
- `--form` → full set, but batch every interview question into one form (collect all answers up front), then author all artifacts in one pass
- (no flag) → ask the operator which artifacts to bootstrap, then proceed

**Division of labor:** the CLI does the mechanical work — pre-flight checks and skip-if-exists scaffolding; you do the interview and write the prose. Author only into skeletons the CLI just created; never overwrite a `skipped` (already-existing) artifact, and never re-run or reimplement the pre-flight/scaffolding yourself — call the CLI for it.

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

Bootstrap `charter.md`, `team.md`, and a contributor record. Scope comes from the flags mapped under [Invocation modes](#invocation-modes).

### Choose scope

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

For every artifact the CLI reports as `created`, run a short interview and write the answers into the skeleton body. Ask one question per exchange (in `--form` mode, batch all questions into one form, then author every artifact in a single pass):

- **charter.md** — vision (future state), mission (what it does, for whom, why), outcome bet (the measurable result). Replace each `<!-- ... -->` prompt with the answer.
- **team.md** — each team member's name, role, and responsibilities; fill the roster table.
- **contributor** (`contributors/$CONTRIBUTOR_ID.md`) — the operator's name, handle, role, and current focus.

Leave the frontmatter `provenance` and `schema_version` values untouched — the CLI stamps them. Author into `created` skeletons only; skip every `skipped` artifact.

### Register the contributor (mint the CT-UUID)

The scaffolded contributor file exists on disk but has no registry row until it is registered. Skipping registration leaves the whole identity chain dead: `operator set` is unsatisfiable, `contributor resolve` matches nothing, and every scrum write stamps NULL provenance — permanently, since provenance is append-only. Run this whenever a contributor artifact is in scope (`created` OR `skipped`):

1. Check for an existing row first — re-running init must not duplicate:

   ```bash
   "${PROVE_CLI[@]}" scrum contributor list
   ```

   If a row with slug `$CONTRIBUTOR_ID` exists, bind its `id` to `$CT_UUID` and skip to the wiring step.

2. Derive the resolution keys: display name from `git config user.name`, email from `git config user.email`, GitHub handle from `gh api user --jq .login` when `gh` is authenticated (omit `--github` otherwise).

3. Register:

   ```bash
   "${PROVE_CLI[@]}" scrum contributor register --slug "$CONTRIBUTOR_ID" \
     --display-name "<name>" --email "<email>" --github "<handle>"
   ```

   `register` merges its registry frontmatter into the existing `contributors/$CONTRIBUTOR_ID.md`, preserving the authored body. Bind the `id` from the JSON output to `$CT_UUID`.

### Wire the operator-of-record and default contributor

`AskUserQuestion` (header: "Wiring"):
- "Wire both (Recommended)" — set the operator-of-record AND the per-machine default contributor
- "Operator only" — set the operator-of-record, skip the default mapping
- "Skip" — leave both unwired

On "Wire both" or "Operator only":

```bash
"${PROVE_CLI[@]}" scrum operator set --contributor "$CT_UUID"
```

Opens the holder interval in the position history and syncs `charter.md`'s `operator_of_record` frontmatter (tolerates a missing charter).

On "Wire both", additionally:

```bash
"${PROVE_CLI[@]}" scrum contributor default set --id "$CT_UUID"
```

Maps this project root to the contributor in the per-user config, so cold `claude-prove scrum` writes on this machine stamp `created_by` / `last_modified_by` with `$CT_UUID` instead of NULL.

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

Report what was created or updated, including any identity artifacts (`charter.md`, `team.md`, `contributors/<id>.md`) and which were scaffolded vs skipped, plus the identity-chain state: the registered CT-UUID, whether the operator-of-record was set, and whether the default-contributor mapping was written. Suggest next steps:
- Review and customize validators in `$TARGET_CWD/.claude/.prove.json`
- Review the authored charter / team / contributor content
- Commit `.claude/.prove.json`, `.gitignore`, and any new identity artifacts
- Run `/prove:plan --task` or `/prove:orchestrator --autopilot`
