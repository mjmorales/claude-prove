import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import { parseIntentManifest } from "../parser.js";
import { assemble } from "../assembler.js";
import type { IntentManifest } from "../types.js";

export function runAssemble(args: string[]): number {
  let base: string | undefined;
  let head: string | undefined;
  let manifestDir: string | undefined;
  let outputPath: string | undefined;
  let taskFile: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--base") {
      base = args[++i];
    } else if (arg === "--head") {
      head = args[++i];
    } else if (arg === "--manifests") {
      manifestDir = args[++i];
    } else if (arg === "--output") {
      outputPath = args[++i];
    } else if (arg === "--task") {
      taskFile = args[++i];
    }
  }

  if (!base) {
    base = "main";
    // Try to resolve, fall back to master
    try {
      execSync(`git rev-parse --verify ${base}`, { encoding: "utf-8", stdio: "pipe" });
    } catch {
      base = "master";
    }
  }

  if (!head) {
    head = "HEAD";
  }

  // Resolve refs to SHAs
  let baseSha: string;
  let headSha: string;
  try {
    baseSha = execSync(`git rev-parse ${base}`, { encoding: "utf-8", stdio: "pipe" }).trim();
    headSha = execSync(`git rev-parse ${head}`, { encoding: "utf-8", stdio: "pipe" }).trim();
  } catch {
    console.error(`Error: could not resolve git refs "${base}" and/or "${head}"`);
    return 2;
  }

  // Default manifest directory
  if (!manifestDir) {
    manifestDir = ".acb/intents";
  }

  const resolvedDir = resolve(manifestDir);

  // Read all manifest files
  let files: string[];
  try {
    files = readdirSync(resolvedDir).filter((f) => f.endsWith(".json"));
  } catch {
    console.error(`No manifest directory found at ${resolvedDir}`);
    console.error("Hint: agents write intent manifests to .acb/intents/ when committing.");
    return 2;
  }

  if (files.length === 0) {
    console.error(`No intent manifest files found in ${resolvedDir}`);
    return 2;
  }

  // Parse all manifests
  const manifests: IntentManifest[] = [];
  let parseErrors = false;

  for (const file of files) {
    const filePath = join(resolvedDir, file);
    const content = readFileSync(filePath, "utf-8");
    const result = parseIntentManifest(content);

    if (!result.ok) {
      console.error(`Parse errors in ${file}:`);
      for (const err of result.errors) {
        console.error(`  ${err.path}: ${err.message}`);
      }
      parseErrors = true;
      continue;
    }

    manifests.push(result.data);
  }

  if (parseErrors && manifests.length === 0) {
    console.error("All manifest files had parse errors. Cannot assemble.");
    return 1;
  }

  // Build task statement from file or commits
  let taskStatement: { turns: { turn_id: string; role: "user"; content: string }[] } | undefined;

  if (taskFile) {
    try {
      const taskContent = readFileSync(taskFile, "utf-8");
      taskStatement = {
        turns: [
          {
            turn_id: "turn-1",
            role: "user",
            content: taskContent,
          },
        ],
      };
    } catch {
      console.error(`Warning: could not read task file "${taskFile}"`);
    }
  }

  if (!taskStatement) {
    // Build from commit messages
    try {
      const log = execSync(`git log --format="%s" ${base}..${head}`, {
        encoding: "utf-8",
        stdio: "pipe",
      }).trim();
      if (log) {
        const branchName = execSync("git rev-parse --abbrev-ref HEAD", {
          encoding: "utf-8",
          stdio: "pipe",
        }).trim();
        taskStatement = {
          turns: [
            {
              turn_id: "turn-1",
              role: "user",
              content: `Branch: ${branchName}\n\nCommits:\n${log}`,
            },
          ],
        };
      }
    } catch {
      // Fall through to assembler default
    }
  }

  // Assemble
  const { document, warnings } = assemble(manifests, {
    base_ref: baseSha,
    head_ref: headSha,
    task_statement: taskStatement,
    agent_id: "acb-assembler",
  });

  // Print warnings
  for (const w of warnings) {
    console.error(`Warning: ${w.message}`);
  }

  if (parseErrors) {
    console.error("Warning: some manifest files had parse errors and were skipped.");
  }

  // Output
  const output = JSON.stringify(document, null, 2);

  if (outputPath) {
    try {
      writeFileSync(outputPath, output + "\n", "utf-8");
      console.log(`ACB document assembled from ${manifests.length} manifest(s) → ${outputPath}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error writing file: ${msg}`);
      return 2;
    }
  } else {
    console.log(output);
  }

  return 0;
}
