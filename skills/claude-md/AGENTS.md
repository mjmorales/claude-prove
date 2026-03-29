---
skill: claude-md
module: external-references
updated: 2026-03-24
---

# External References in CLAUDE.md

Declare external files in `.claude/.prove.json` that get injected into the managed CLAUDE.md as `@path` inclusions. Claude Code resolves `@path` at session load time.

## .claude/.prove.json Schema

Add under `claude_md.references` (ordered array):

```json
{
  "claude_md": {
    "references": [
      {"path": "$PLUGIN_DIR/references/llm-coding-standards.md", "label": "LLM Coding Standards"}
    ]
  }
}
```

| Field   | Type   | Required | Description                                              |
|---------|--------|----------|----------------------------------------------------------|
| `path`  | string | yes      | File path for `@` inclusion. Supports `~` and `$PLUGIN_DIR`. |
| `label` | string | yes      | Heading rendered above the `@` line in CLAUDE.md.        |

`$PLUGIN_DIR` is resolved by the composer at generation time to the actual plugin install path.

Omitting `claude_md` is equivalent to `"references": []`.

## Data Flow

```
.claude/.prove.json  ->  scanner._scan_prove_config()  ->  composer._section_references()  ->  CLAUDE.md
                 (drops entries missing "path")     (renders in declaration order)
```

### Scanner output shape (`prove_config` key)

```python
{
    "references": [
        {"path": "$PLUGIN_DIR/references/llm-coding-standards.md", "label": "LLM Coding Standards"},
    ],
}
```

### Rendered output

```markdown
## References

### LLM Coding Standards

@/absolute/path/to/plugin/references/llm-coding-standards.md
```

## Key Behaviors

- `$PLUGIN_DIR` in paths is resolved by the composer to the actual plugin directory at generation time
- Paths are NOT validated at generation time -- missing files are silently skipped by Claude Code at load time
- `~` expansion is handled by Claude Code, not by prove
- Order is preserved from `.claude/.prove.json` declaration order
- References section appears between Discovery Protocol and Prove Commands in the managed block
- Bundled references (in `$PLUGIN_DIR/references/`) ship with the plugin and are preferred over user-global equivalents
