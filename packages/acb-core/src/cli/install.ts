import { execSync } from "node:child_process";
import { existsSync, mkdirSync, copyFileSync, chmodSync, readFileSync, unlinkSync } from "node:fs";
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

  console.log("");
  console.log("ACB intent hooks installed. Agents must now write");
  console.log(".acb/intents/staged.json before each commit.");
  console.log("");
  console.log("Humans can bypass with: git commit --no-verify");

  return 0;
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
