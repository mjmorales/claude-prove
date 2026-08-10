/**
 * `claude-prove models status` — report the declared `models` block, its
 * materialization state in `.claude/settings.local.json`, and the advisory
 * pairing diagnostics. Read-only.
 */

import { diffModelSettings, hasModelDeclarations } from '@claude-prove/installer';
import { advisoryWarnings, readProveJson, resolveModelsContext } from './config';
import { resolvePlanningRoute } from './routing';

export interface StatusOptions {
  cwd?: string;
  settings?: string;
}

export function runStatus(opts: StatusOptions): number {
  const ctx = resolveModelsContext(opts);
  const { models } = readProveJson(ctx.proveJsonPath);

  if (!hasModelDeclarations(models)) {
    console.log(
      `claude-prove models status: no models block declared in ${ctx.proveJsonPath} (declare one with \`claude-prove models set\`)`,
    );
    return 0;
  }

  if (models.main) console.log(`  main:     ${models.main}`);
  if (models.advisor) console.log(`  advisor:  ${models.advisor}`);
  if (models.fallback && models.fallback.length > 0) {
    console.log(`  fallback: ${models.fallback.join(' -> ')}`);
  }
  if (models.effort) console.log(`  effort:   ${models.effort}`);
  console.log(
    `  planning: ${models.planning ?? 'auto'} (resolves ${resolvePlanningRoute(models)})`,
  );

  const drifted = diffModelSettings(ctx.settingsPath, models);
  if (drifted.length === 0) {
    console.log(`claude-prove models status: materialized — ${ctx.settingsPath} is in sync`);
  } else {
    console.log(
      `claude-prove models status: NOT materialized — ${drifted.join(', ')} missing or stale in ${ctx.settingsPath} (run \`claude-prove models apply\`)`,
    );
  }

  for (const warning of advisoryWarnings(models)) {
    console.log(`claude-prove models status: warning: ${warning}`);
  }
  return 0;
}
