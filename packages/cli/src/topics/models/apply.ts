/**
 * `claude-prove models apply` — materialize the declared `models` block into
 * `.claude/settings.local.json`.
 *
 * The committed block in `.claude/.prove.json` is a recommendation; this verb
 * is the explicit per-machine opt-in that turns it into live Claude Code
 * settings (`model`, `advisorModel`, `fallbackModel`,
 * `env.CLAUDE_CODE_EFFORT_LEVEL`). Add/update only — keys the block does not
 * declare are never touched, and the target is always the auto-gitignored
 * local settings layer.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  diffModelSettings,
  hasModelDeclarations,
  writeModelSettings,
} from '@claude-prove/installer';
import { advisoryWarnings, readProveJson, resolveModelsContext } from './config';

export interface ApplyOptions {
  cwd?: string;
  settings?: string;
  dryRun?: boolean;
}

export function runApply(opts: ApplyOptions): number {
  const ctx = resolveModelsContext(opts);
  const { models } = readProveJson(ctx.proveJsonPath);

  if (!hasModelDeclarations(models)) {
    console.error(
      `claude-prove models apply: no models block declared in ${ctx.proveJsonPath} — declare one with \`claude-prove models set\` first`,
    );
    return 1;
  }

  for (const warning of advisoryWarnings(models)) {
    console.error(`claude-prove models apply: warning: ${warning}`);
  }

  if (opts.dryRun) {
    const drifted = diffModelSettings(ctx.settingsPath, models);
    if (drifted.length === 0) {
      console.log(`claude-prove models apply: up-to-date ${ctx.settingsPath} (dry-run)`);
    } else {
      console.log(
        `claude-prove models apply: would write ${drifted.join(', ')} to ${ctx.settingsPath} (dry-run)`,
      );
    }
    return 0;
  }

  mkdirSync(dirname(ctx.settingsPath), { recursive: true });
  const result = writeModelSettings(ctx.settingsPath, models);

  if (!result.wrote) {
    console.log(`claude-prove models apply: up-to-date ${ctx.settingsPath}`);
    return 0;
  }
  console.log(
    `claude-prove models apply: wrote ${result.applied.join(', ')} to ${ctx.settingsPath}`,
  );
  if (result.inSync.length > 0) {
    console.log(`claude-prove models apply: already in sync: ${result.inSync.join(', ')}`);
  }
  console.log('note: restart the Claude Code session so the new model settings take effect.');
  return 0;
}
