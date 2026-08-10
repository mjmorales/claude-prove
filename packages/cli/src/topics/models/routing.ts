/**
 * `claude-prove models routing` — print the resolved planning-phase routing
 * mode as a single word on stdout: `native` or `prove`.
 *
 * This is the one-word contract skills with a planning phase branch on
 * (`/prove:plan` Mode: Task, orchestrator full-auto requirements gathering —
 * the decompose ladder deliberately does not branch: a subagent cannot
 * enter a top-level session mode).
 * Resolution is mechanical: an explicit `models.planning` of `prove` or
 * `native` wins; `auto` — and an absent field — resolves to `native` when
 * the declared `main` is an opusplan alias (the alias whose Opus upgrade
 * fires only inside Claude Code plan mode) and `prove` otherwise; an absent
 * `models` block resolves to `prove`. Read-only.
 */

import type { ModelsBlock } from '@claude-prove/installer';
import { readProveJson, resolveModelsContext } from './config';

export type PlanningRoute = 'prove' | 'native';

export function resolvePlanningRoute(models: ModelsBlock): PlanningRoute {
  if (models.planning === 'prove' || models.planning === 'native') {
    return models.planning;
  }
  return models.main && /^opusplan/.test(models.main) ? 'native' : 'prove';
}

export interface RoutingOptions {
  cwd?: string;
}

export function runRouting(opts: RoutingOptions): number {
  const ctx = resolveModelsContext(opts);
  const { models } = readProveJson(ctx.proveJsonPath);
  console.log(resolvePlanningRoute(models));
  return 0;
}
