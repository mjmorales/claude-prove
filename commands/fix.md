---
description: Fix rejected ACB review groups — targets rejected groups with reviewer comments and file refs
---

# ACB Fix

```bash
node "$CLAUDE_PROJECT_DIR/packages/acb-core/dist/cli/index.js" fix
```

**On success**: Follow the output as instructions. Fix ONLY rejected groups — do not modify accepted groups. Commit with an intent manifest as usual (ACB reassembles progressively on each commit).

**On failure**: Inform the user all groups are accepted and suggest `/prove:resolve`.
