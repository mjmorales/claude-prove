# ACB + Claude Code Setup

Set up the ACB review workflow in any Claude Code project. No PROVE framework required.

## Prerequisites

- Node.js 18+
- Claude Code CLI
- VS Code or Cursor with the ACB extension installed

## 1. Install the CLI

```bash
npm install @acb/core
```

This gives you the `acb-review` binary.

## 2. Install git hooks

```bash
npx acb-review install
```

This installs:
- **pre-commit hook** — rejects commits without an intent manifest at `.acb/intents/staged.json`
- **post-commit hook** — finalizes the manifest and progressively assembles `.acb/review.acb.json`
- Creates `.acb/intents/` (gitignored) and `.acb/.gitignore`

Humans can always bypass with `git commit --no-verify`.

## 3. Create slash commands

Create these files in your project's `.claude/commands/` directory. These teach Claude Code about the ACB post-review workflow.

### `.claude/commands/acb-resolve.md`

```markdown
---
description: Generate approval summary after ACB review
---

# ACB Resolve

Run the following command and present the output to the user:

\`\`\`bash
npx acb-review resolve
\`\`\`

If the command fails because no review file exists, inform the user they need to complete the review in the ACB VS Code extension first.
```

### `.claude/commands/acb-fix.md`

```markdown
---
description: Generate a fix prompt from rejected ACB review groups
---

# ACB Fix

Run the following command and use the output as your instructions:

\`\`\`bash
npx acb-review fix
\`\`\`

If the command succeeds, follow the instructions in the output:
1. Fix only the rejected groups listed
2. Do not modify accepted groups
3. Commit with an intent manifest as usual
4. The ACB will be progressively reassembled on each commit

If the command exits with code 1 (all groups accepted), inform the user and suggest `/acb-resolve` instead.
```

### `.claude/commands/acb-discuss.md`

```markdown
---
description: Start a discussion about ACB review groups needing clarification
---

# ACB Discuss

Run the following command and use the output as context for discussion with the user:

\`\`\`bash
npx acb-review discuss
\`\`\`

If the command succeeds, engage in discussion about the groups and questions listed. Help the user understand the agent's reasoning and explore alternatives.

If the command exits with code 1 (nothing to discuss), inform the user.
```

## 4. The workflow

Once set up, the review cycle is:

```
Agent commits code
  → pre-commit: rejects without .acb/intents/staged.json
  → agent writes intent manifest (classification, grounding, annotations)
  → commit succeeds
  → post-commit: assembles .acb/review.acb.json

Human opens .acb/review.acb.json in VS Code/Cursor
  → reviews intent groups
  → accepts, rejects, or flags for discussion
  → saves verdicts to .acb/review.acb-review.json

Human runs follow-up:
  /acb-resolve  → all accepted, ready to merge
  /acb-fix      → agent fixes rejected groups
  /acb-discuss  → interactive discussion about flagged groups
```

## CLI Reference

| Command | Purpose |
|---------|---------|
| `acb-review install [--link] [--force]` | Install git hooks |
| `acb-review uninstall` | Remove git hooks |
| `acb-review assemble` | Manually reassemble ACB from manifests |
| `acb-review validate <file>` | Validate an ACB or review file |
| `acb-review resolve` | Post-review: approval summary |
| `acb-review fix` | Post-review: fix prompt for rejected groups |
| `acb-review discuss` | Post-review: discussion prompt |

All post-review commands default to `.acb/review.acb.json`. Override with `--acb <path>`.
