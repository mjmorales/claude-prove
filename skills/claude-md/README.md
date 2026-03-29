# claude-md

Generates and maintains an LLM-optimized `CLAUDE.md` for a target project. Scans the codebase statically (no LLM calls), reads `.claude/.prove.json` configuration, and composes a `CLAUDE.md` with behavioral directives that Claude Code follows during a session. Safe to re-run — output is deterministic and only the managed block is replaced on regeneration.

## Architecture

The skill is three modules with a clean separation of concerns:

```
skills/claude-md/
├── __main__.py    — CLI entry point; wires subcommands to scanner + composer
├── scanner.py     — Static analyzer; returns a structured scan dict
└── composer.py    — Assembles scan dict into CLAUDE.md content
```

**Data flow:**

```
project root
     │
     ▼
scanner.scan_project()  →  scan dict (JSON-serializable)
     │
     ▼
composer.compose()      →  CLAUDE.md string (wrapped in managed block)
     │
     ▼
composer.write_claude_md()  →  writes to <project-root>/CLAUDE.md
```

### Managed block

The composer wraps all generated content between two HTML comment sentinels:

```
<!-- prove:managed:start -->
...generated content...
<!-- prove:managed:end -->
```

On regeneration, `write_claude_md` replaces only the content between these markers. Everything outside — user-added sections above or below — is preserved. If the markers are absent (first-time run, or the user removed them), the entire file is overwritten.

## CLI Usage

```
python3 skills/claude-md/__main__.py <subcommand> [--project-root DIR] [--plugin-dir DIR]
```

### Flags

| Flag | Description | Default |
|------|-------------|---------|
| `--project-root` | Absolute path to the target project | Current working directory |
| `--plugin-dir` | Absolute path to the prove plugin root | Auto-derived from `__main__.py` location |

### Subcommands

| Subcommand | What it does | Writes files? |
|---|---|---|
| `generate` | Scan project and write `CLAUDE.md` | Yes — `<project-root>/CLAUDE.md` |
| `scan` | Run scanner only; print JSON to stdout | No |
| `subagent-context` | Print a compact context block for subagent prompt injection | No |

### Examples

```bash
# Generate CLAUDE.md for a project
python3 skills/claude-md/__main__.py generate \
  --project-root /home/user/my-service \
  --plugin-dir /home/user/.claude/plugins/prove

# Inspect what the scanner detects without writing anything
python3 skills/claude-md/__main__.py scan --project-root /home/user/my-service

# Get a compact context block to inject into a subagent prompt
python3 skills/claude-md/__main__.py subagent-context --project-root /home/user/my-service
```

## Scanner

`scanner.scan_project(project_root, plugin_dir)` returns a dict with these top-level keys:

| Key | Type | Description |
|-----|------|-------------|
| `project` | `dict` | `name` — derived from `package.json`, `pyproject.toml`, `Cargo.toml`, or directory name |
| `tech_stack` | `dict` | `languages`, `frameworks`, `build_systems` — detected from marker files and `package.json` deps |
| `key_dirs` | `dict[str, str]` | Known directory names found at project root, mapped to purpose strings |
| `conventions` | `dict` | `naming` (dominant file-naming style), `test_patterns`, `primary_extensions` |
| `prove_config` | `dict` | Parsed `.claude/.prove.json` — validators, index presence, external references |
| `cafi` | `dict` | Whether `.prove/file-index.json` exists and the file count it contains |
| `plugin_dir` | `str` | The resolved plugin path (passed through for use in composer templates) |

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

`compose_subagent_context` produces a trimmed version — tech stack, discovery commands, and validation commands only — suitable for injecting into subagent system prompts.

## External References

External files can be included in the generated `CLAUDE.md` as `@path` inclusions, configured per-repo in `.claude/.prove.json` under `claude_md.references`. See [AGENTS.md](AGENTS.md) for the full schema, data flow contract, and rendered output format.

Quick setup: run `/prove:init` — Step 7 detects candidate references from `~/.claude/CLAUDE.md` and offers to include them.

## Testing

Tests live alongside the source files and use pytest with `tmp_path` fixtures.

```bash
python3 -m pytest skills/claude-md/ -v
```

| File | What it covers |
|------|----------------|
| `test_scanner.py` | Tech stack detection, project name resolution, CAFI detection, external references parsing, naming convention voting |
| `test_composer.py` | Section inclusion/exclusion, managed block write/merge/preserve, subagent context output, references rendering |

## Extending the Skill

**Adding a new section:**

1. Add a `_section_<name>` function to `composer.py` returning a string ending with a blank line
2. Add the conditional call in `compose()` following the existing pattern
3. Add scanner data extraction to the appropriate `_scan_*` function in `scanner.py`
4. Add tests to both `test_scanner.py` and `test_composer.py`

**Adding a new tech stack entry:**

Append a tuple to the `checks` list in `_scan_tech_stack`. Format: `(filename, language, framework, build_system)` — use `None` for fields that don't apply.

**Adding a new key directory:**

Add an entry to `dir_hints` in `_scan_key_dirs`. The key is the exact directory name; the value is the purpose string rendered in `## Structure`.
