import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Mode } from './detect-mode';

export interface ResolveBinaryPathOptions {
  /** Plugin root directory. Required in dev mode. */
  pluginRoot?: string;
  /** Explicit binary path. Overrides the compiled-mode default when set. */
  binaryPath?: string;
}

const DEFAULT_COMPILED_REL = join('.local', 'bin', 'prove');
const DEV_ENTRY_REL = join('packages', 'cli', 'bin', 'run.ts');

/**
 * Produce the command string the host should invoke to run the prove CLI.
 *
 * Dev mode returns `bun run <pluginRoot>/packages/cli/bin/run.ts` so the
 * TypeScript entry point is executed directly from the working copy. Compiled
 * mode returns an absolute path to the installed binary, defaulting to
 * `$HOME/.local/bin/prove` when no explicit override is provided.
 *
 * Throws when dev mode is requested without a `pluginRoot` -- callers must
 * resolve that via `resolvePluginRoot` before invoking this function.
 */
export function resolveBinaryPath(mode: Mode, opts: ResolveBinaryPathOptions = {}): string {
  if (mode === 'dev') {
    if (!opts.pluginRoot) {
      throw new Error('resolveBinaryPath: dev mode requires opts.pluginRoot');
    }
    return `bun run ${join(opts.pluginRoot, DEV_ENTRY_REL)}`;
  }
  return opts.binaryPath ?? join(homedir(), DEFAULT_COMPILED_REL);
}
