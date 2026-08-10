---
description: Recommend, declare, and materialize the project's Claude Code model configuration (opusplan, advisor pairing, fallback, effort)
argument-hint: "[status|apply|preset <name>]"
core: true
summary: Recommend and declare the project's model config — opusplan, advisor pairing, fallback, effort
---

# Models: $ARGUMENTS

Load and follow the model-config skill at `skills/model-config/SKILL.md`.

Argument fast-paths (skip the recommendation phases when the operator already named the action):

- `status` → run `claude-prove models status` and report it; done.
- `apply` → run `claude-prove models status` first. With a block declared, go straight to the skill's materialization gate (`models apply` behind AskUserQuestion). With none declared, say so and fall through to the full skill flow instead of running `models apply`.
- `preset <name>` → go straight to the declaration gate for that preset (`models set --preset <name>` behind AskUserQuestion), then the materialization gate.
- a bare preset name (`balanced`|`deep`|`economy`|`unattended`) → same as `preset <name>`. An unrecognized name exits 1 listing the valid set; relay that and run `claude-prove models presets`.
- any other text → treat it as the workload answer and run the full skill flow, skipping the skill's workload question.
- (no argument) → the full skill flow: read state, gather workload, dispatch the `model-config-advisor` agent, gate, execute.
