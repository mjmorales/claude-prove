import { join } from 'node:path';
import type { Mode } from './detect-mode';

export interface ResolveBinaryPathOptions {
  /** Explicit binary path. Overrides the compiled-mode default when set. */
  binaryPath?: string;
}

const DEFAULT_COMPILED_REL = join('.local', 'bin', 'claude-prove');
const DEV_ENTRY_REL = 'packages/cli/bin/run.ts';

/**
 * Shell expression for the plugin dir, resolved at fire time (NOT at
 * generation time): the per-machine `$CLAUDE_PROVE_PLUGIN_DIR` override when
 * set -- users put it in the gitignored `.claude/settings.local.json` `env`
 * block -- falling back to the default Claude Code plugin install path.
 * Emitting this expression instead of a resolved absolute path keeps
 * git-tracked artifacts (settings.json hooks, CLAUDE.md, pre-commit configs)
 * byte-identical across contributor machines.
 */
export const PLUGIN_DIR_SHELL_EXPR = '${CLAUDE_PROVE_PLUGIN_DIR:-$HOME/.claude/plugins/prove}';

/**
 * Canonical dev-mode CLI invocation prefix: runs the TypeScript entry point
 * out of the working copy the shell expression resolves to. Quoted so the
 * expansion survives spaces in the path.
 */
export const DEV_INVOCATION_PREFIX = `bun run "${PLUGIN_DIR_SHELL_EXPR}/${DEV_ENTRY_REL}"`;

/**
 * Produce the command-string prefix host artifacts embed to run the prove CLI.
 *
 * Dev mode returns `bun run "${CLAUDE_PROVE_PLUGIN_DIR:-...}/packages/cli/bin/run.ts"`
 * -- a shell-interpolated form expanded when the hook or command fires, never
 * a machine-absolute path. Compiled mode returns `"$HOME/.local/bin/claude-prove"`
 * (literal `$HOME`, also expanded at fire time) unless an explicit
 * `binaryPath` override is provided, which is honored verbatim.
 *
 * The result is a shell command fragment, not an executable path: callers
 * embed it in hook commands and generated docs, they do not exec it directly.
 */
export function resolveBinaryPath(mode: Mode, opts: ResolveBinaryPathOptions = {}): string {
  if (mode === 'dev') {
    return DEV_INVOCATION_PREFIX;
  }
  return opts.binaryPath ?? `"$HOME/${DEFAULT_COMPILED_REL}"`;
}
