import { execSync } from "node:child_process";
import { existsSync, mkdirSync, copyFileSync, chmodSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";

const HOOKS = ["pre-commit", "post-commit"];

function getPackageHooksDir(): string {
  // Resolve relative to this file: cli/install.js → cli/ → dist/ → acb-core/ → hooks/
  return resolve(__dirname, "..", "..", "hooks");
}

function getGitRoot(): string | null {
  try {
    return execSync("git rev-parse --show-toplevel", {
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
  } catch {
    return null;
  }
}

export function runInstall(args: string[]): number {
  const mode = args.includes("--link") ? "link" : "copy";
  const force = args.includes("--force");

  const gitRoot = getGitRoot();
  if (!gitRoot) {
    console.error("Error: not inside a git repository.");
    return 2;
  }

  const sourceDir = getPackageHooksDir();
  if (!existsSync(sourceDir)) {
    console.error(`Error: hooks directory not found at ${sourceDir}`);
    console.error("This may indicate a broken acb-core installation.");
    return 2;
  }

  // Verify source hooks exist
  for (const hook of HOOKS) {
    if (!existsSync(join(sourceDir, hook))) {
      console.error(`Error: ${hook} not found in ${sourceDir}`);
      return 2;
    }
  }

  if (mode === "link") {
    // Set core.hooksPath to point directly at the package hooks directory
    try {
      execSync(`git config core.hooksPath "${sourceDir}"`, {
        cwd: gitRoot,
        stdio: "pipe",
      });
      console.log(`Linked git hooks → ${sourceDir}`);
      console.log("Git will use ACB hooks directly from the package.");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error setting core.hooksPath: ${msg}`);
      return 2;
    }
  } else {
    // Copy hooks into .git/hooks/
    const targetDir = join(gitRoot, ".git", "hooks");

    for (const hook of HOOKS) {
      const src = join(sourceDir, hook);
      const dst = join(targetDir, hook);

      if (existsSync(dst) && !force) {
        console.error(`Skipped ${hook}: already exists at ${dst}`);
        console.error(`  Use --force to overwrite, or --link to use core.hooksPath instead.`);
        continue;
      }

      copyFileSync(src, dst);
      chmodSync(dst, 0o755);
      console.log(`Installed ${hook} → ${dst}`);
    }
  }

  // Create .acb/intents/ directory
  const intentsDir = join(gitRoot, ".acb", "intents");
  if (!existsSync(intentsDir)) {
    mkdirSync(intentsDir, { recursive: true });
    console.log(`Created ${intentsDir}`);
  }

  // Ensure .acb/intents/ is gitignored (ephemeral working artifacts)
  const gitignorePath = join(gitRoot, ".acb", ".gitignore");
  const gitignoreContent = "# Intent manifests are ephemeral — the assembled ACB is the artifact\nintents/\n";
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, gitignoreContent, "utf-8");
    console.log(`Created ${gitignorePath} (intents/ gitignored)`);
  } else {
    const existing = readFileSync(gitignorePath, "utf-8");
    if (!existing.includes("intents/")) {
      writeFileSync(gitignorePath, existing.trimEnd() + "\nintents/\n", "utf-8");
      console.log(`Updated ${gitignorePath} (added intents/)`);
    }
  }

  // Scaffold framework-specific glue
  const framework = getFrameworkArg(args);
  if (framework === "claudecode") {
    scaffoldClaudeCodeCommands(gitRoot);
  }

  console.log("");
  console.log("ACB intent hooks installed. Agents must now write");
  console.log(".acb/intents/staged.json before each commit.");
  console.log("Progressive ACB output: .acb/review.acb.json");
  console.log("");
  console.log("Humans can bypass with: git commit --no-verify");
  if (!framework) {
    console.log("");
    console.log("Tip: run with --framework claudecode to scaffold slash commands.");
  }

  return 0;
}

function getFrameworkArg(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--framework" && args[i + 1]) {
      return args[i + 1];
    }
  }
  return undefined;
}

const CLAUDE_COMMANDS: Record<string, string> = {
  "acb-resolve.md": `---
description: Generate approval summary after ACB review
---

# ACB Resolve

Run the following command and present the output to the user:

\`\`\`bash
npx acb-review resolve
\`\`\`

If the command fails because no review file exists, inform the user they need to complete the review in the ACB VS Code extension first.
`,
  "acb-fix.md": `---
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

If the command exits with code 1 (all groups accepted), inform the user and suggest \`/acb-resolve\` instead.
`,
  "acb-discuss.md": `---
description: Start a discussion about ACB review groups needing clarification
---

# ACB Discuss

Run the following command and use the output as context for discussion with the user:

\`\`\`bash
npx acb-review discuss
\`\`\`

If the command succeeds, engage in discussion about the groups and questions listed. Help the user understand the agent's reasoning and explore alternatives.

If the command exits with code 1 (nothing to discuss), inform the user.
`,
};

function scaffoldClaudeCodeCommands(gitRoot: string): void {
  const commandsDir = join(gitRoot, ".claude", "commands");
  if (!existsSync(commandsDir)) {
    mkdirSync(commandsDir, { recursive: true });
  }

  let created = 0;
  for (const [filename, content] of Object.entries(CLAUDE_COMMANDS)) {
    const filePath = join(commandsDir, filename);
    if (existsSync(filePath)) {
      console.log(`Skipped ${filename}: already exists`);
      continue;
    }
    writeFileSync(filePath, content, "utf-8");
    created++;
  }

  if (created > 0) {
    console.log(`Created ${created} Claude Code slash commands in .claude/commands/`);
    console.log("  /acb-resolve  — approval summary");
    console.log("  /acb-fix      — fix rejected groups");
    console.log("  /acb-discuss  — discuss flagged groups");
  }
}

export function runUninstall(_args: string[]): number {
  const gitRoot = getGitRoot();
  if (!gitRoot) {
    console.error("Error: not inside a git repository.");
    return 2;
  }

  // Check if using core.hooksPath
  try {
    const hooksPath = execSync("git config core.hooksPath", {
      encoding: "utf-8",
      stdio: "pipe",
      cwd: gitRoot,
    }).trim();
    execSync("git config --unset core.hooksPath", {
      cwd: gitRoot,
      stdio: "pipe",
    });
    console.log(`Removed core.hooksPath (was: ${hooksPath})`);
  } catch {
    // No core.hooksPath — check .git/hooks/ for our hooks
    const hooksDir = join(gitRoot, ".git", "hooks");
    for (const hook of HOOKS) {
      const dst = join(hooksDir, hook);
      if (existsSync(dst)) {
        const content = readFileSync(dst, "utf-8");
        if (content.includes("ACB") && content.includes("intent")) {
          unlinkSync(dst);
          console.log(`Removed ${dst}`);
        } else {
          console.log(`Skipped ${hook}: not an ACB hook`);
        }
      }
    }
  }

  console.log("ACB hooks uninstalled.");
  return 0;
}
