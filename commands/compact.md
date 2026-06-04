---
description: Anchor prove context before a /compact and rehydrate after — survive a context squeeze without losing claude-prove state
argument-hint: "[anchor|rehydrate] [note]"
core: true
summary: Anchor session context into prove primitives pre-compact and rehydrate post-compact
---

# Smart Compaction: $ARGUMENTS

Load and follow the smart-compaction skill (`skills/smart-compaction/SKILL.md`).

Pass `$ARGUMENTS` through verbatim. The skill dispatches on the first token
(`anchor` | `rehydrate`); with no args it auto-detects — an existing
`.prove/compact-anchors.md` means a compaction just happened → `rehydrate`;
otherwise → `anchor`.
