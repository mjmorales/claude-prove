/**
 * Git helpers shared across prove packages (ACB, run-state, pcd, scrum).
 *
 * Ported from `tools/acb/_git.py`. Centralizes resolution of the current
 * branch, HEAD SHA, the current worktree root, and the main worktree root.
 * ACB writes to the main worktree's `.prove/acb.db` so that all manifests
 * for a session are visible from the repository root, regardless of which
 * worktree produced the commit.
 *
 * Every helper accepts an optional `cwd`. Subprocess failures (non-zero
 * exit, git not installed, ENOENT) return `null` — these helpers never
 * throw. Empty git output is also coerced to `null`.
 */

/** Internal: run `git <args>` and return trimmed stdout, or `null` on failure. */
function runGit(args: string[], cwd?: string): string | null {
  let proc: ReturnType<typeof Bun.spawnSync>;
  try {
    proc = Bun.spawnSync({
      cmd: ['git', ...args],
      cwd,
      stdout: 'pipe',
      stderr: 'ignore',
    });
  } catch {
    return null;
  }
  if (proc.exitCode !== 0) return null;
  const out = proc.stdout?.toString().trim() ?? '';
  return out.length > 0 ? out : null;
}

/**
 * Return the current branch name, or `null` if detached/unknown.
 *
 * Runs `git rev-parse --abbrev-ref HEAD`. A literal `HEAD` output
 * (detached-HEAD sentinel) is treated as `null`.
 */
export function currentBranch(cwd?: string): string | null {
  const out = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  if (out === null || out === 'HEAD') return null;
  return out;
}

/** Return HEAD as a full SHA, or `null` if not resolvable. */
export function headSha(cwd?: string): string | null {
  return runGit(['rev-parse', 'HEAD'], cwd);
}

/** Return the current worktree root (may be the main worktree or a linked one). */
export function worktreeRoot(cwd?: string): string | null {
  return runGit(['rev-parse', '--show-toplevel'], cwd);
}

/**
 * Return the main worktree root, even when invoked from a linked worktree.
 *
 * Uses `git rev-parse --path-format=absolute --git-common-dir` which returns
 * the shared `.git` directory of the repository (the main repo's `.git`,
 * not the linked worktree's `.git` file). The parent of that path is the
 * main worktree root for non-bare repos. Returns `null` for bare repos
 * (when the result does not end in `.git`) or on any git failure.
 */
export function mainWorktreeRoot(cwd?: string): string | null {
  const common = runGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
  if (!common) return null;
  // Strip trailing separator(s) before inspecting the basename.
  const trimmed = common.replace(/[/\\]+$/, '');
  const lastSep = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  const basename = lastSep === -1 ? trimmed : trimmed.slice(lastSep + 1);
  if (basename !== '.git') return null;
  const parent = lastSep === -1 ? '' : trimmed.slice(0, lastSep);
  return parent.length > 0 ? parent : null;
}
