import { statSync } from 'node:fs';
import { join } from 'node:path';

export type Mode = 'dev' | 'compiled';

/**
 * Classify the plugin installation as dev (in-repo TypeScript sources) or
 * compiled (shipped binary / installed plugin without sources).
 *
 * Dev mode is signalled by the presence of `<pluginRoot>/packages/cli/src/` --
 * that directory only exists in the working copy of the repo. Compiled
 * installs distribute built artifacts and omit it.
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
    const stat = statSync(cliSrc);
    return stat.isDirectory() ? 'dev' : 'compiled';
  } catch {
    return 'compiled';
  }
}
