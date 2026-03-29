# Plugin Updates

Migration guide for features that require user action after updating the plugin. Run `/prove:update` to apply these automatically, or follow the manual steps below.

For the full commit-level changelog, see [CHANGELOG.md](CHANGELOG.md).

---

## v0.18.0 — External References & Dynamic Commands

### External References for CLAUDE.md

Projects can now include external files (coding standards, security policies, etc.) in their generated CLAUDE.md via `@` inclusions. References are configured per-repo in `.prove.json` and rendered inside the managed block.

**What ships with the plugin**: `references/llm-coding-standards.md` — LLM-optimized coding standards applied across all projects.

**Migration** (existing projects):

```bash
# Option 1: Automatic — run /prove:update, Step 5 will detect and offer bundled references

# Option 2: Manual — add to .prove.json:
```

```json
{
  "claude_md": {
    "references": [
      {"path": "$PLUGIN_DIR/references/llm-coding-standards.md", "label": "LLM Coding Standards"}
    ]
  }
}
```

Then regenerate: `/prove:docs:claude-md`

`$PLUGIN_DIR` is resolved at generation time to the actual plugin install path.

**New projects**: `/prove:init` Step 7 offers bundled references automatically.

### Dynamic Prove Commands

The `## Prove Commands` section in generated CLAUDE.md is no longer hardcoded. Commands with `core: true` in their frontmatter are auto-detected and rendered.

**Migration**: No action needed. Run `/prove:docs:claude-md` to regenerate — new commands appear automatically.

**Adding your own**: Any command file in `commands/` with `core: true` and `summary:` in its frontmatter will appear in generated CLAUDE.md files:

```yaml
---
description: What this command does
core: true
summary: Short text for CLAUDE.md listing
---
```

### Default Subcommand for claude-md CLI

`python3 skills/claude-md/__main__.py` now defaults to `generate` when no subcommand is given.

**Migration**: No action needed. Existing explicit `generate` calls still work.
