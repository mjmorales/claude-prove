import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { AcbDocument, IntentGroup } from "../types.js";

interface DiffFileInfo {
  path: string;
  ranges: string[];
}

function getChangedFiles(base: string, head: string): string[] {
  try {
    const output = execSync(`git diff --name-only ${base} ${head}`, {
      encoding: "utf-8",
    });
    return output
      .trim()
      .split("\n")
      .filter((f) => f.length > 0);
  } catch {
    return [];
  }
}

function getFileRanges(base: string, head: string): DiffFileInfo[] {
  const files = getChangedFiles(base, head);
  const result: DiffFileInfo[] = [];

  try {
    const diffOutput = execSync(
      `git diff --unified=0 ${base} ${head}`,
      { encoding: "utf-8" },
    );

    // Parse unified diff to extract line ranges per file
    const fileRanges = new Map<string, string[]>();

    let currentFile: string | undefined;
    for (const line of diffOutput.split("\n")) {
      if (line.startsWith("+++ b/")) {
        currentFile = line.slice(6);
        if (!fileRanges.has(currentFile)) {
          fileRanges.set(currentFile, []);
        }
      } else if (line.startsWith("@@ ") && currentFile) {
        // Parse @@ -old,count +new,count @@
        const match = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
        if (match) {
          const start = parseInt(match[1], 10);
          const count = match[2] !== undefined ? parseInt(match[2], 10) : 1;
          if (count === 0) continue; // Pure deletion, no new lines
          if (count === 1) {
            fileRanges.get(currentFile)!.push(`${start}`);
          } else {
            fileRanges.get(currentFile)!.push(`${start}-${start + count - 1}`);
          }
        }
      }
    }

    for (const file of files) {
      const ranges = fileRanges.get(file);
      result.push({
        path: file,
        ranges: ranges && ranges.length > 0 ? ranges : ["1"],
      });
    }
  } catch {
    // If git diff fails, just use file names with placeholder ranges
    for (const file of files) {
      result.push({ path: file, ranges: ["1"] });
    }
  }

  return result;
}

export function runGenerate(args: string[]): number {
  let base: string | undefined;
  let head: string | undefined;
  let outputPath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--base") {
      base = args[++i];
    } else if (arg === "--head") {
      head = args[++i];
    } else if (arg === "--output") {
      outputPath = args[++i];
    }
  }

  if (!base || !head) {
    console.error("Error: --base and --head are required");
    console.error("Usage: acb generate --base <ref> --head <ref> [--output <path>]");
    return 2;
  }

  const fileInfos = getFileRanges(base, head);

  const intentGroups: IntentGroup[] = fileInfos.map((info, idx) => ({
    id: `group-${idx + 1}`,
    title: `Changes to ${info.path}`,
    classification: "explicit" as const,
    ambiguity_tags: [],
    task_grounding: "TODO: Replace with actual task grounding",
    file_refs: [
      {
        path: info.path,
        ranges: info.ranges,
        view_hint: "changed_region" as const,
      },
    ],
  }));

  // Ensure at least one intent group
  if (intentGroups.length === 0) {
    intentGroups.push({
      id: "group-1",
      title: "No changes detected",
      classification: "explicit",
      ambiguity_tags: [],
      task_grounding: "TODO: Replace with actual task grounding",
      file_refs: [
        {
          path: "unknown",
          ranges: ["1"],
        },
      ],
    });
  }

  const doc: AcbDocument = {
    acb_version: "0.1",
    id: randomUUID(),
    change_set_ref: {
      base_ref: base,
      head_ref: head,
    },
    task_statement: {
      turns: [
        {
          turn_id: "turn-1",
          role: "user",
          content: "TODO: Replace with actual task",
        },
      ],
    },
    intent_groups: intentGroups,
    generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    agent_id: "acb-cli",
  };

  const output = JSON.stringify(doc, null, 2);

  if (outputPath) {
    try {
      writeFileSync(outputPath, output + "\n", "utf-8");
      console.log(`ACB document written to ${outputPath}`);
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
