---
description: Generate a discussion prompt from ACB review — surfaces groups needing discussion, reviewer questions, and open questions for interactive dialog
---

# ACB Discuss

Run the following command and use the output as context for discussion with the user:

```bash
node "$CLAUDE_PROJECT_DIR/packages/acb-core/dist/cli/index.js" discuss
```

If the command succeeds, engage in discussion about the groups and questions listed. Help the user understand the agent's reasoning and explore alternatives.

If the command fails because no groups need discussion, inform the user.
