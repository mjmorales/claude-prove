---
name: prompting-token-count
description: Estimate token counts for prompt files. Wraps the `prove prompting token-count` subcommand for measuring agents, skills, commands, references, or any text file. Use when the user wants to check prompt size, compare token budgets, or measure files before/after optimization.
---

# Token Count

Estimate token counts for files using a regex-based heuristic tokenizer. Works on any text file — not limited to prove prompts.

## Usage

Run from the user's project root. Pass glob patterns or file paths as positional arguments.

```bash
prove prompting token-count <patterns...> [flags]
```

## Arguments

Positional arguments are glob patterns or literal file paths. Multiple patterns can be combined.

| Flag | Effect |
|------|--------|
| `--sort tokens` | Sort by token count descending (default) |
| `--sort name` | Sort alphabetically by path |
| `--sort lines` | Sort by line count descending |
| `--json` | Machine-readable JSON output |
| `--no-strip` | Include YAML frontmatter in count (stripped by default) |

## Examples

```bash
# All markdown files
prove prompting token-count '**/*.md'

# Single file
prove prompting token-count agents/llm-prompt-engineer.md

# Multiple patterns
prove prompting token-count 'agents/**/*.md' 'skills/**/SKILL.md'

# JSON output for scripting
prove prompting token-count '**/*.md' --json
```

## Interpreting Results

- **Tokens**: Heuristic estimate, typically within 10-15% of Claude's actual BPE tokenizer. Slightly overcounts.
- **Lines/Chars**: After frontmatter stripping (unless `--no-strip`).
- **Frontmatter stripping**: YAML frontmatter between `---` markers is excluded by default since Claude Code doesn't send it as prompt content.

## When to Use

- Before and after prompt optimization — measure the delta
- Auditing prompt budgets across a project
- Comparing agent definitions to find outliers
- Checking if a reference file is too large for context
