/**
 * `claude-prove install init` — bootstrap both settings.json and .prove.json.
 *
 * Resolves plugin root + mode once, then delegates to writeSettingsHooks
 * (for Claude hook wiring) and bootstrapProveJson (for the validators
 * config). Both are idempotent: the run is a no-op when both files are
 * already in sync, unless `--force` is passed.
 */

import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  bootstrapProveJson,
  detectMode,
  resolveBinaryPath,
  resolvePluginRoot,
  writeSettingsHooks,
} from '@claude-prove/installer';

export interface InitOptions {
  project?: string;
  settings?: string;
  force: boolean;
}

export function runInit(opts: InitOptions): number {
  const projectRoot = resolve(opts.project ?? process.cwd());
  const settingsPath = opts.settings
    ? resolve(opts.settings)
    : join(projectRoot, '.claude', 'settings.json');

  const pluginRoot = resolvePluginRoot();
  const mode = detectMode(pluginRoot);
  const prefix = resolveBinaryPath(mode, { pluginRoot });

  // writeSettingsHooks writes a sibling `.tmp` before renaming, so the
  // parent must exist. bootstrapProveJson creates `.claude/` itself.
  mkdirSync(dirname(settingsPath), { recursive: true });
  const hooksWrote = writeSettingsHooks(settingsPath, prefix, { force: opts.force });
  bootstrapProveJson(projectRoot, { force: opts.force });

  const configPath = join(projectRoot, '.claude', '.prove.json');
  console.log(
    `claude-prove install init: ${hooksWrote ? 'wrote' : 'up-to-date'} ${settingsPath}; bootstrapped ${configPath} (mode=${mode})`,
  );
  return 0;
}
