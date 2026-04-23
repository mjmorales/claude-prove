# claude-md

Generates and maintains an LLM-optimized `CLAUDE.md` for a target project. Scans the codebase statically (no LLM calls), reads `.claude/.prove.json` configuration, and composes a `CLAUDE.md` with behavioral directives that Claude Code follows during a session. Safe to re-run — output is deterministic and only the managed block is replaced on regeneration.

## Architecture

The implementation lives in the TypeScript CLI as a topic; this skill dir is just the invocation contract (`SKILL.md`).

```
packages/cli/src/topics/claude-md/
├── scanner.ts               — Static analyzer; returns a structured scan object
├── composer.ts              — Assembles scan object into CLAUDE.md content
├── cli/generate-cmd.ts      — Subcommand handlers (generate / scan / subagent-context)
├── __fixtures__/golden/     — Byte-parity fixtures captured from the Python reference
└── *.test.ts                — Unit + integration parity tests
packages/cli/src/topics/claude-md.ts   — cac topic registration
packages/cli/bin/run.ts                — `prove claude-md ...` dispatches here
```

**Data flow:**

```
project root
     │
     ▼
scanProject()       →  scan object (JSON-serializable, kebab_case fields)
     │
     ▼
compose()           →  CLAUDE.md string (wrapped in managed block)
     │
     ▼
writeClaudeMd()     →  writes to <project-root>/CLAUDE.md
```

### Managed block

The composer wraps all generated content between two HTML comment sentinels:

```
<!-- prove:managed:start -->
...generated content...
<!-- prove:managed:end -->
```

On regeneration, `writeClaudeMd` replaces only the content between these markers. Everything outside — user-added sections above or below — is preserved. If the markers are absent (first-time run, or the user removed them), the entire file is overwritten.

## CLI Usage

```
bun run $PLUGIN/packages/cli/bin/run.ts claude-md <subcommand> [--project-root DIR] [--plugin-dir DIR]
```

### Flags

| Flag | Description | Default |
|------|-------------|---------|
| `--project-root` | Absolute path to the target project | Current working directory |
| `--plugin-dir` | Absolute path to the prove plugin root | Auto-derived from the CLI location |

### Subcommands

| Subcommand | What it does | Writes files? |
|---|---|---|
| `generate` | Scan project and write `CLAUDE.md` | Yes — `<project-root>/CLAUDE.md` |
| `scan` | Run scanner only; print JSON to stdout | No |
| `subagent-context` | Print a compact context block for subagent prompt injection | No |

### Examples

```bash
# Generate CLAUDE.md for a project
bun run $PLUGIN/packages/cli/bin/run.ts claude-md generate \
  --project-root /home/user/my-service \
  --plugin-dir /home/user/.claude/plugins/prove

# Inspect what the scanner detects without writing anything
bun run $PLUGIN/packages/cli/bin/run.ts claude-md scan --project-root /home/user/my-service

# Get a compact context block to inject into a subagent prompt
bun run $PLUGIN/packages/cli/bin/run.ts claude-md subagent-context --project-root /home/user/my-service
```

## Scanner

`scanProject(projectRoot, pluginDir)` returns a `ScanResult` object with these top-level keys (JSON field names in parentheses where different from the TS field):

| Key | Type | Description |
|-----|------|-------------|
| `project` | `object` | `name` — derived from `package.json`, `pyproject.toml`, `Cargo.toml`, or directory name |
| `tech_stack` | `object` | `languages`, `frameworks`, `build_systems` — detected from marker files and `package.json` deps |
| `key_dirs` | `Record<string, string>` | Known directory names found at project root, mapped to purpose strings |
| `conventions` | `object` | `naming` (dominant file-naming style), `test_patterns`, `primary_extensions` |
| `prove_config` | `object` | Parsed `.claude/.prove.json` — validators, index presence, external references |
| `cafi` | `object` | Whether `.prove/file-index.json` exists and the file count it contains |
| `plugin_dir` | `string` | The resolved plugin path (passed through for use in composer templates) |

### Tech stack detection

Detection is file-presence based. Recognized marker files:

| File | Language | Framework | Build system |
|------|----------|-----------|--------------|
| `go.mod` | Go | — | go |
| `Cargo.toml` | Rust | — | cargo |
| `package.json` | JavaScript/TypeScript | — | npm |
| `pyproject.toml` / `setup.py` / `requirements.txt` | Python | — | pip |
| `tsconfig.json` | JavaScript/TypeScript | — | — |
| `project.godot` | GDScript | Godot | — |
| `pom.xml` | Java | — | maven |
| `build.gradle` | Java/Kotlin | — | gradle |

For Node projects, frameworks (`react`, `next`, `vue`, `svelte`, `express`, `fastify`) are detected from `package.json` dependencies.

### Naming convention detection

The scanner walks up to 3 directory levels deep (skipping `node_modules`, `vendor`, `venv`, `__pycache__`, `target`, `build`, `dist`), collects source file names, and votes on the dominant pattern: `snake_case`, `kebab-case`, `camelCase`, or `PascalCase`. Returns `"unknown"` when no source files are found.

## Composer

### Section generation logic

Sections are conditionally included based on the scan dict:

| Section | Generated when |
|---------|----------------|
| Header + identity | Always |
| `## Structure` | `key_dirs` is non-empty |
| `## Conventions` | `conventions.naming` is not `"unknown"` |
| `## Validation` | `prove_config.validators` is non-empty |
| `## Discovery Protocol` | `cafi.available` is true, or `prove_config.has_index` is true |
| `## References` | `prove_config.references` is non-empty |
| `## Prove Commands` | `prove_config.exists` is true (commands auto-detected from `core: true` frontmatter) |

A minimal project with no `.claude/.prove.json` and no CAFI index produces only the header line and tech stack.

### Subagent context

`composeSubagentContext` produces a trimmed version — tech stack, discovery commands, and validation commands only — suitable for injecting into subagent system prompts.

## External References

External files can be included in the generated `CLAUDE.md` as `@path` inclusions, configured per-repo in `.claude/.prove.json` under `claude_md.references`. See [AGENTS.md](AGENTS.md) for the full schema, data flow contract, and rendered output format.

Quick setup: run `/prove:init` — Step 7 detects candidate references from `~/.claude/CLAUDE.md` and offers to include them.

## Testing

Tests live under the TS topic and run via `bun test`.

```bash
bun test packages/cli/src/topics/claude-md/
```

| File | What it covers |
|------|----------------|
| `scanner.test.ts` | Tech stack detection, project name resolution, CAFI detection, external references parsing, naming convention voting |
| `composer.test.ts` | Section inclusion/exclusion, managed block write/merge/preserve, subagent context output, references rendering |
| `integration.test.ts` | Byte-parity against Python-captured goldens for 4 fixture projects (self, go-fixture, node-fixture, python-fixture) plus end-to-end CLI dispatch via `bun run bin/run.ts claude-md ...` |

## Extending the Skill

**Adding a new section:**

1. Add a `render<Name>` function to `composer.ts` returning a string ending with a blank line
2. Add the conditional call in `compose()` following the existing pattern
3. Add scanner data extraction to the appropriate `scan*` function in `scanner.ts`
4. Add tests to both `scanner.test.ts` and `composer.test.ts`
5. Re-capture the golden fixtures under `packages/cli/src/topics/claude-md/__fixtures__/golden/` to reflect the new section

**Adding a new tech stack entry:**

Append an entry to `TECH_CHECKS` in `scanner.ts`. Format: `{ filename, lang, framework, buildSystem }` — use `null` for fields that don't apply.

**Adding a new key directory:**

Add an entry to `DIR_HINTS` in `scanner.ts`. The key is the exact directory name; the value is the purpose string rendered in `## Structure`.
