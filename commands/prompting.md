---
description: Prompt engineering toolkit — craft prompts, manage the research cache, or count tokens.
argument-hint: "<craft|cache|token-count> [args]"
---

# Prompting: $ARGUMENTS

Load and follow the prompting skill (`skills/prompting/SKILL.md` from the workflow plugin). Parse `$ARGUMENTS` — first token is the subcommand (`craft`, `cache`, or `token-count`); forward the remainder as subcommand arguments.
