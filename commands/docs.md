---
description: Unified docs — human/agent/both documentation and CLAUDE.md generation
argument-hint: "<human|agent|both|claude-md> [args]"
---

# docs: $ARGUMENTS

Load and follow the `docs` skill (`skills/docs/SKILL.md` from the workflow plugin). Dispatches by first token of `$ARGUMENTS`:

- `human [subject]` — human-readable docs (READMEs, guides, API references)
- `agent [subject]` — LLM-optimized agent/API/module docs
- `both [subject]` (default when no subcommand) — auto-docs: analyze scope, run both audiences
- `claude-md generate` — full CLAUDE.md regeneration via `claude-prove claude-md` CLI

For single-directive growth of CLAUDE.md outside the prove-managed block, use `/prove:remember <directive>`.

Pass the full `$ARGUMENTS` through to the skill.
