---
description: Generate a fix prompt from ACB review — targets rejected groups with reviewer comments and file refs for the agent to act on
---

# ACB Fix

Run the following command and use the output as your instructions:

```bash
node "$CLAUDE_PROJECT_DIR/packages/acb-core/dist/cli/index.js" fix
```

If the command succeeds, follow the instructions in the output:
1. Fix only the rejected groups listed
2. Do not modify accepted groups
3. Commit with an intent manifest as usual
4. The ACB will be progressively reassembled on each commit

If the command fails because all groups are accepted, inform the user and suggest `/prove:resolve` instead.
