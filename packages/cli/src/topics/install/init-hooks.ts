/**
 * `claude-prove install init-hooks` — merge prove-owned hook blocks into settings.json.
 *
 * User-authored blocks (no `_tool` tag) are preserved byte-for-byte. See
 * `@claude-prove/installer/write-settings-hooks` for the canonical block
 * list and merge semantics.
 */

import { mkdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  detectMode,
  resolveBinaryPath,
  resolvePluginRoot,
  writeSettingsHooks,
} from '@claude-prove/installer';
import { disabledToolsFromConfig } from './disabled-tools';

export interface InitHooksOptions {
  settings?: string;
  force: boolean;
}

export function runInitHooks(opts: InitHooksOptions): number {
  const settingsPath = opts.settings
    ? resolve(opts.settings)
    : join(process.cwd(), '.claude', 'settings.json');

  const pluginRoot = resolvePluginRoot();
  const mode = detectMode(pluginRoot);
  const prefix = resolveBinaryPath(mode, { pluginRoot });

  // Ensure the settings directory exists before writeSettingsHooks stages
  // its sibling `.tmp`.
  const settingsDir = dirname(settingsPath);
  mkdirSync(settingsDir, { recursive: true });
  // Derive the project root only when settingsPath is actually nested under
  // `.claude/` — an unusual --settings path should read the cwd config rather
  // than a phantom sibling directory that has no .prove.json.
  const projectRoot = basename(settingsDir) === '.claude' ? dirname(settingsDir) : process.cwd();
  const disabledTools = disabledToolsFromConfig(projectRoot);
  const wrote = writeSettingsHooks(settingsPath, prefix, { force: opts.force, disabledTools });
  console.log(
    `claude-prove install init-hooks: ${wrote ? 'wrote' : 'up-to-date'} ${settingsPath} (mode=${mode})`,
  );
  return 0;
}
