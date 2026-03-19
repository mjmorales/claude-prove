/**
 * Pre-commit check: validates that a staged intent manifest exists and is structurally valid.
 * Called by the pre-commit git hook. Exit 0 = pass, exit 1 = reject commit.
 */

import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { parseIntentManifest } from "../parser.js";

const STAGED_MANIFEST = ".acb/intents/staged.json";

const MANIFEST_TEMPLATE = `
Before committing, write an intent manifest to declare what
these changes do and why.

Write to: .acb/intents/staged.json

Required structure:
{
  "acb_manifest_version": "0.1",
  "commit_sha": "pending",
  "timestamp": "<ISO 8601 now>",
  "intent_groups": [
    {
      "id": "<slug>",
      "title": "<what this change does>",
      "classification": "explicit | inferred | speculative",
      "ambiguity_tags": [],
      "task_grounding": "<why, traced to the task>",
      "file_refs": [
        { "path": "<file>", "ranges": ["<N-M>"], "view_hint": "changed_region" }
      ]
    }
  ]
}

Optional fields: annotations, negative_space, open_questions

After writing the manifest, retry the commit.
To bypass (human/manual commits): git commit --no-verify
`;

export function runCheckManifest(_args: string[]): number {
  // Skip if ACB manifests are explicitly disabled
  if (process.env.ACB_SKIP_MANIFEST === "1") {
    return 0;
  }

  // Skip for merge commits
  if (existsSync(".git/MERGE_HEAD")) {
    return 0;
  }

  // Skip if amending (post-commit hook sets this)
  if (process.env.ACB_AMENDING === "1") {
    return 0;
  }

  // Check if there are any staged changes
  let stagedFiles: string;
  try {
    stagedFiles = execSync("git diff --cached --name-only", {
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
  } catch {
    return 0;
  }

  if (!stagedFiles) {
    return 0;
  }

  // Skip if the only staged file is the manifest itself
  if (stagedFiles === STAGED_MANIFEST) {
    return 0;
  }

  // Check for the staged manifest
  if (!existsSync(STAGED_MANIFEST)) {
    console.error("");
    console.error("ACB Intent Manifest Required");
    console.error("============================");
    console.error(MANIFEST_TEMPLATE);
    return 1;
  }

  // Parse and validate
  let content: string;
  try {
    content = readFileSync(STAGED_MANIFEST, "utf-8");
  } catch {
    console.error(`Error: could not read ${STAGED_MANIFEST}`);
    return 1;
  }

  const result = parseIntentManifest(content);
  if (!result.ok) {
    console.error("ACB manifest validation failed:");
    for (const err of result.errors) {
      console.error(`  ${err.path}: ${err.message}`);
    }
    console.error("");
    console.error(`Fix the manifest at ${STAGED_MANIFEST} and retry the commit.`);
    return 1;
  }

  // Check intent_groups is non-empty
  if (result.data.intent_groups.length === 0) {
    console.error("ACB manifest validation failed: intent_groups must not be empty.");
    console.error(`Fix the manifest at ${STAGED_MANIFEST} and retry the commit.`);
    return 1;
  }

  return 0;
}
