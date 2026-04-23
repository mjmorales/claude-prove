import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs";

const execFileP = promisify(execFile);

/**
 * Resolve the git repo root for this server instance.
 *
 * Resolution order:
 *   1. `REPO_ROOT` env var (used by Docker / CI).
 *   2. `git rev-parse --show-toplevel` from `process.cwd()`.
 *   3. `process.cwd()` itself if it's not a git repo (lets the UI open even
 *      without a repo — shows an empty runs list).
 *
 * Intentionally does NOT resolve relative to the compiled script location,
 * because under `npx`/Docker that path is a package cache, not the user's repo.
 */
export async function resolveRepoRoot(): Promise<string> {
  if (process.env.REPO_ROOT) return path.resolve(process.env.REPO_ROOT);
  const cwd = process.cwd();
  try {
    const { stdout } = await execFileP("git", ["rev-parse", "--show-toplevel"], { cwd });
    return stdout.trim();
  } catch {
    return fs.realpathSync(cwd);
  }
}
