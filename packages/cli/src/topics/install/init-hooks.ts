/**
 * `claude-prove install init-hooks` — merge prove-owned hook blocks into settings.json.
 *
 * User-authored blocks (no `_tool` tag) are preserved byte-for-byte. See
 * `@claude-prove/installer/write-settings-hooks` for the canonical block
 * list and merge semantics.
 */

import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  detectMode,
  resolveBinaryPath,
  resolvePluginRoot,
  writeSettingsHooks,
} from '@claude-prove/installer';

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
  mkdirSync(dirname(settingsPath), { recursive: true });
  const wrote = writeSettingsHooks(settingsPath, prefix, { force: opts.force });
  console.log(
    `claude-prove install init-hooks: ${wrote ? 'wrote' : 'up-to-date'} ${settingsPath} (mode=${mode})`,
  );
  return 0;
}
