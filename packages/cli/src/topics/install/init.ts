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
  type Mode,
  bootstrapProveJson,
  detectMode,
  ensureProjectLink,
  ensureStableRoot,
  resolveBinaryPath,
  resolvePluginRoot,
  writeSettingsHooks,
} from '@claude-prove/installer';
import { readDevModeSetting } from './dev-mode-setting';
import { disabledToolsFromConfig } from './disabled-tools';

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
  // The project's explicit `dev_mode` is the authority for the hook command
  // prefix; filesystem detection only seeds the choice when the config is
  // silent (fresh project, field absent).
  const devMode = readDevModeSetting(projectRoot);
  const mode: Mode = devMode === undefined ? detectMode(pluginRoot) : devMode ? 'dev' : 'compiled';
  const modeSource = devMode === undefined ? 'detected' : 'dev_mode config';
  const prefix = resolveBinaryPath(mode);

  // writeSettingsHooks writes a sibling `.tmp` before renaming, so the
  // parent must exist. bootstrapProveJson creates `.claude/` itself.
  mkdirSync(dirname(settingsPath), { recursive: true });
  // Honor tool toggles from an existing `.claude/.prove.json` so disabled
  // tools' hook blocks are not installed. On a first-time install the config
  // does not exist yet → every tool is enabled (empty set).
  const disabledTools = disabledToolsFromConfig(projectRoot);
  const hooksWrote = writeSettingsHooks(settingsPath, prefix, {
    force: opts.force,
    disabledTools,
  });
  bootstrapProveJson(projectRoot, { force: opts.force });

  // Refresh the symlink chain the generated @-references resolve through
  // (project link -> stable root -> plugin dir). Secondary writes: a failure
  // degrades to a warning so it never masks the successful settings/config
  // bootstrap above.
  try {
    ensureStableRoot(pluginRoot);
    ensureProjectLink(projectRoot);
  } catch (err) {
    console.warn(
      `claude-prove install init: reference-symlink refresh failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const configPath = join(projectRoot, '.claude', '.prove.json');
  console.log(
    `claude-prove install init: ${hooksWrote ? 'wrote' : 'up-to-date'} ${settingsPath}; bootstrapped ${configPath} (mode=${mode}, ${modeSource})`,
  );
  return 0;
}
