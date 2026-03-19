/**
 * Post-commit: finalizes the staged manifest and progressively assembles the ACB.
 * Called by the post-commit git hook.
 *
 * 1. Renames staged.json → <sha>.json with actual commit SHA
 * 2. Runs progressive assembly → .acb/review.acb.json
 */

import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { runAssemble } from "./assemble.js";

const MANIFEST_DIR = ".acb/intents";
const STAGED_MANIFEST = join(MANIFEST_DIR, "staged.json");
const ACB_OUTPUT = ".acb/review.acb.json";

export function runPostCommit(_args: string[]): number {
  // Skip if no staged manifest
  if (!existsSync(STAGED_MANIFEST)) {
    return 0;
  }

  // Skip if already amending (prevent recursion)
  if (process.env.ACB_AMENDING === "1") {
    return 0;
  }

  // Get the commit SHA
  let fullSha: string;
  let shortSha: string;
  try {
    fullSha = execSync("git rev-parse HEAD", { encoding: "utf-8", stdio: "pipe" }).trim();
    shortSha = execSync("git rev-parse --short HEAD", { encoding: "utf-8", stdio: "pipe" }).trim();
  } catch {
    console.error("Warning: could not resolve HEAD SHA. Manifest not finalized.");
    return 0;
  }

  const finalManifest = join(MANIFEST_DIR, `${shortSha}.json`);

  // Update commit_sha in the manifest
  try {
    const content = readFileSync(STAGED_MANIFEST, "utf-8");
    const doc = JSON.parse(content);
    doc.commit_sha = fullSha;
    writeFileSync(finalManifest, JSON.stringify(doc, null, 2) + "\n", "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Warning: could not finalize manifest: ${msg}`);
    // Still try to rename even if JSON update fails
    try {
      renameSync(STAGED_MANIFEST, finalManifest);
    } catch {
      // Give up
    }
    return 0;
  }

  // Remove staged.json (we wrote to the final path)
  try {
    if (existsSync(STAGED_MANIFEST)) {
      unlinkSync(STAGED_MANIFEST);
    }
  } catch {
    // Not critical
  }

  // Progressive assembly — rebuild the ACB from all manifests
  try {
    runAssemble(["--output", ACB_OUTPUT]);
  } catch {
    // Assembly failure is non-fatal in post-commit
    console.error("Warning: progressive ACB assembly failed. Run `acb-review assemble` manually.");
  }

  return 0;
}
