---
description: Unified docs — human/agent/both documentation and CLAUDE.md management
argument-hint: "<human|agent|both|claude-md> [args]"
---

# docs: $ARGUMENTS

Load and follow the `docs` skill (`skills/docs/SKILL.md` from the workflow plugin). Dispatches by first token of `$ARGUMENTS`:

- `human [subject]` — human-readable docs (READMEs, guides, API references)
- `agent [subject]` — LLM-optimized agent/API/module docs
- `both [subject]` (default when no subcommand) — auto-docs: analyze scope, run both audiences
- `claude-md generate` — full CLAUDE.md regeneration via `prove claude-md` CLI
- `claude-md update <directive>` — append/update single directive with optimization + craft certification

Pass the full `$ARGUMENTS` through to the skill.
