import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_MARKER = join('.claude-plugin', 'plugin.json');
const FALLBACK_REL = join('.claude', 'plugins', 'prove');

/**
 * Per-machine plugin-dir override. Users set this in the gitignored
 * `.claude/settings.local.json` `env` block (Claude Code injects `env` into
 * hook commands and Bash invocations), so git-tracked artifacts never need
 * a machine-absolute checkout path. `install local-env` writes the entry.
 */
export const PLUGIN_DIR_ENV_VAR = 'CLAUDE_PROVE_PLUGIN_DIR';

/**
 * Resolve the active plugin root directory.
 *
 * Discovery order:
 *   1. $CLAUDE_PROVE_PLUGIN_DIR if set and non-empty -- the prove-specific
 *      per-machine override; beats the generic var because Claude Code sets
 *      $CLAUDE_PLUGIN_ROOT itself in plugin-sourced hook contexts.
 *   2. $CLAUDE_PLUGIN_ROOT if set and non-empty (absolute path honored as-is).
 *   3. Walk upward from `startDir` looking for `.claude-plugin/plugin.json`.
 *   4. Fallback to `$HOME/.claude/plugins/prove` -- this path is returned
 *      even when it does not exist so callers can report a meaningful error.
 *
 * `startDir` defaults to the directory containing this module so discovery
 * works both from compiled bundles and from `bun run <pluginRoot>/...`.
 *
 * Never throws. Always returns an absolute path string.
 */
export function resolvePluginRoot(startDir?: string): string {
  const fromProveEnv = process.env[PLUGIN_DIR_ENV_VAR];
  if (fromProveEnv && fromProveEnv.length > 0) {
    return resolve(fromProveEnv);
  }

  const fromEnv = process.env.CLAUDE_PLUGIN_ROOT;
  if (fromEnv && fromEnv.length > 0) {
    return resolve(fromEnv);
  }

  const walkFrom = startDir ?? moduleDir();
  const found = walkUpForPluginJson(walkFrom);
  if (found) return found;

  return join(homedir(), FALLBACK_REL);
}

function moduleDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

function walkUpForPluginJson(start: string): string | undefined {
  let cur = resolve(start);
  while (true) {
    if (existsSync(join(cur, PLUGIN_MARKER))) return cur;
    const parent = dirname(cur);
    if (parent === cur) return undefined;
    cur = parent;
  }
}
