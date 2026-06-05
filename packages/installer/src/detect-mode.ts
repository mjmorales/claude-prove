import { statSync } from 'node:fs';
import { join } from 'node:path';

export type Mode = 'dev' | 'compiled';

/**
 * Classify a module URL / entry path as belonging to a Bun compiled binary.
 *
 * Bun standalone executables serve their bundled modules from a virtual
 * filesystem: `/$bunfs/...` on POSIX, `B:/~BUN/...` on Windows. A module
 * whose `import.meta.url` (or a process whose `argv[1]`) carries either
 * marker is running from inside a compiled binary, not from sources.
 */
export function isCompiledEntrypoint(pathOrUrl: string): boolean {
  return pathOrUrl.includes('$bunfs') || pathOrUrl.includes('~BUN');
}

/**
 * Report whether the CURRENT PROCESS is a compiled claude-prove binary.
 *
 * This is provenance detection — how this process was launched — and is
 * deliberately independent of `resolvePluginRoot()`: a dev machine sets
 * `CLAUDE_PROVE_PLUGIN_DIR` to its checkout, which would make any
 * plugin-root-based classification report 'dev' even for the installed
 * binary at ~/.local/bin. Commands that act on the running artifact itself
 * (e.g. `install upgrade`) must use this, not `detectMode`.
 */
export function runningFromCompiledBinary(): boolean {
  return isCompiledEntrypoint(import.meta.url) || isCompiledEntrypoint(process.argv[1] ?? '');
}

/**
 * Classify the plugin installation as dev (a RUNNABLE in-repo TypeScript
 * checkout) or compiled (shipped binary / any install the bun wrapper cannot
 * actually run).
 *
 * Dev mode requires both signals:
 *   1. `<pluginRoot>/packages/cli/src/` exists — sources are present.
 *   2. `<pluginRoot>/node_modules/@claude-prove/shared` resolves — the
 *      workspace install has run, so `bun run packages/cli/bin/run.ts` can
 *      resolve its workspace deps.
 *
 * Sources alone are NOT a dev checkout: a marketplace clone ships the full
 * repo without `bun install`, and a `bun run` invocation against it dies with
 * a module-resolution error on every hook fire. Such trees classify as
 * compiled so codegen emits the bare `claude-prove` binary invocation.
 *
 * Throws when `pluginRoot` is empty so callers cannot accidentally classify
 * process.cwd() or the filesystem root.
 */
export function detectMode(pluginRoot: string): Mode {
  if (!pluginRoot) {
    throw new Error('detectMode: pluginRoot must be a non-empty path');
  }
  const cliSrc = join(pluginRoot, 'packages', 'cli', 'src');
  try {
    if (!statSync(cliSrc).isDirectory()) return 'compiled';
  } catch {
    return 'compiled';
  }
  // Workspace-install marker; statSync follows the symlink bun creates for
  // workspace packages, so a dangling link also classifies as compiled.
  const workspaceDep = join(pluginRoot, 'node_modules', '@claude-prove', 'shared');
  try {
    return statSync(workspaceDep).isDirectory() ? 'dev' : 'compiled';
  } catch {
    return 'compiled';
  }
}
