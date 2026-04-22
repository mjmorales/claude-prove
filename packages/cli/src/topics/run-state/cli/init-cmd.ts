/**
 * `run-state init --branch B --slug S --plan FILE [--prd FILE] [--overwrite]`
 *
 * Mirrors Python `cmd_init`: validate plan (+ optional prd), write
 * prd.json/plan.json/state.json under the resolved run directory.
 */

import { readFileSync } from 'node:fs';
import { RunPaths } from '../paths';
import { initRun, type PlanData, type PrdData, StateError } from '../state';
import { validateData } from '../validate';
import { defaultRunsRoot, ResolveError } from './resolve';

export interface InitFlags {
  branch?: string;
  slug?: string;
  runsRoot?: string;
  plan?: string;
  prd?: string;
  overwrite?: boolean;
}

export function runInit(flags: InitFlags): number {
  if (!flags.plan) {
    console.error('error: the following arguments are required: --plan');
    return 1;
  }
  if (!flags.branch) {
    console.error('error: the following arguments are required: --branch');
    return 1;
  }
  if (!flags.slug) {
    console.error('error: the following arguments are required: --slug');
    return 1;
  }

  let plan: PlanData;
  try {
    plan = JSON.parse(readFileSync(flags.plan, 'utf8')) as PlanData;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`error: ${msg}`);
    return 1;
  }

  const planFindings = validateData(plan, 'plan');
  if (!planFindings.ok) {
    for (const e of planFindings.errors) console.error(e);
    return 2;
  }

  let prd: PrdData | undefined;
  if (flags.prd) {
    try {
      prd = JSON.parse(readFileSync(flags.prd, 'utf8')) as PrdData;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`error: ${msg}`);
      return 1;
    }
    const prdFindings = validateData(prd, 'prd');
    if (!prdFindings.ok) {
      for (const e of prdFindings.errors) console.error(e);
      return 2;
    }
  }

  const runsRoot = flags.runsRoot ?? defaultRunsRoot();
  try {
    const paths = RunPaths.forRun(runsRoot, flags.branch, flags.slug);
    initRun(runsRoot, flags.branch, flags.slug, plan, { prd, overwrite: flags.overwrite });
    console.log(`initialized: ${paths.root}`);
    return 0;
  } catch (err) {
    if (err instanceof StateError || err instanceof ResolveError) {
      console.error(`error: ${err.message}`);
      return 2;
    }
    throw err;
  }
}
