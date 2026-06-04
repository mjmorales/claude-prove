/**
 * `claude-prove install local-env` — point this machine at its plugin checkout.
 *
 * Writes `env.CLAUDE_PROVE_PLUGIN_DIR` into `.claude/settings.local.json`
 * (Claude Code's auto-gitignored local settings layer, whose `env` block is
 * injected into every hook command and Bash invocation). This is the
 * per-machine half of the portable invocation contract: tracked artifacts
 * embed `${CLAUDE_PROVE_PLUGIN_DIR:-...}`; this verb supplies the value.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  ensureProjectLink,
  ensureStableRoot,
  resolvePluginRoot,
  writeLocalEnv,
} from '@claude-prove/installer';

export interface LocalEnvOptions {
  /** Plugin checkout directory. Defaults to the resolved plugin root. */
  pluginDir?: string;
  /** Explicit settings.local.json path (default: <cwd>/.claude/settings.local.json). */
  settings?: string;
}

/** Relative path of the dev-mode CLI entry point inside a checkout. */
const DEV_ENTRY_REL = join('packages', 'cli', 'bin', 'run.ts');

export function runLocalEnv(opts: LocalEnvOptions): number {
  const pluginDir = resolve(opts.pluginDir ?? resolvePluginRoot());

  // A plugin dir that cannot serve the dev entry point would make every
  // generated hook fail at fire time — reject it here with the actionable
  // hint instead.
  if (!existsSync(join(pluginDir, DEV_ENTRY_REL))) {
    console.error(
      `claude-prove install local-env: ${pluginDir} does not contain ${DEV_ENTRY_REL} — pass the claude-prove checkout via --plugin-dir`,
    );
    return 1;
  }

  const settingsPath = opts.settings
    ? resolve(opts.settings)
    : join(process.cwd(), '.claude', 'settings.local.json');
  mkdirSync(dirname(settingsPath), { recursive: true });

  const wrote = writeLocalEnv(settingsPath, pluginDir);
  console.log(
    `claude-prove install local-env: ${wrote ? 'wrote' : 'up-to-date'} ${settingsPath} (CLAUDE_PROVE_PLUGIN_DIR=${pluginDir})`,
  );

  // The symlink chain is the @-reference half of the per-machine contract:
  // generated CLAUDE.md imports resolve through
  // .claude/prove-plugin -> ~/.claude-prove/latest -> plugin dir.
  const link = ensureStableRoot(pluginDir);
  console.log(`claude-prove install local-env: ${link} -> ${pluginDir}`);
  const projectRoot = opts.settings ? dirname(dirname(settingsPath)) : process.cwd();
  const projectLink = ensureProjectLink(projectRoot);
  console.log(`claude-prove install local-env: ${projectLink} -> ${link}`);

  if (wrote) {
    console.log('note: restart the Claude Code session so the env block is injected into hooks.');
  }
  return 0;
}
