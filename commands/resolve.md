---
description: Generate approval summary after ACB review — shows accepted groups, annotation responses, and merge readiness
---

# ACB Resolve

Run the following command and present the output to the user:

```bash
node "$CLAUDE_PROJECT_DIR/packages/acb-core/dist/cli/index.js" resolve
```

If the command fails because no review file exists, inform the user they need to complete the review in the ACB VS Code extension first.
