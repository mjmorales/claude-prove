/**
 * `run-state init --branch B --slug S --plan FILE [--prd FILE] [--overwrite]`
 *
 * Validate plan (+ optional prd), write prd.json/plan.json/state.json under
 * the resolved run directory.
 */

import { readFileSync } from 'node:fs';
import { type PlanData, type PrdData, StateError, initRun } from '../state';
import { validateData } from '../validate';
import { defaultRunsRoot } from './resolve';

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

  let planRaw: unknown;
  try {
    planRaw = JSON.parse(readFileSync(flags.plan, 'utf8'));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`error: ${msg}`);
    return 1;
  }

  // validateData is the runtime type guard — it checks shape against PLAN_SCHEMA
  // before we cast to PlanData. Without this the JSON.parse result (unknown)
  // would reach initRun unchecked and surface as cryptic mid-write errors.
  const planFindings = validateData(planRaw, 'plan');
  if (!planFindings.ok) {
    for (const e of planFindings.errors) console.error(e);
    return 2;
  }
  const plan = planRaw as PlanData;

  let prd: PrdData | undefined;
  if (flags.prd) {
    let prdRaw: unknown;
    try {
      prdRaw = JSON.parse(readFileSync(flags.prd, 'utf8'));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`error: ${msg}`);
      return 1;
    }
    const prdFindings = validateData(prdRaw, 'prd');
    if (!prdFindings.ok) {
      for (const e of prdFindings.errors) console.error(e);
      return 2;
    }
    prd = prdRaw as PrdData;
  }

  const runsRoot = flags.runsRoot ?? defaultRunsRoot();
  try {
    const paths = initRun(runsRoot, flags.branch, flags.slug, plan, {
      prd,
      overwrite: flags.overwrite,
    });
    console.log(`initialized: ${paths.root}`);
    return 0;
  } catch (err) {
    if (err instanceof StateError) {
      console.error(`error: ${err.message}`);
      return 2;
    }
    // initRun does raw fs ops (mkdirSync, lock touch, atomic writes) that
    // raise plain Node Errors (EACCES, ENOSPC, read-only mount), not
    // StateError. Catch them as I/O failures and exit 1 (the documented I/O
    // code) instead of crashing the CLI with a raw stack trace.
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`error: failed to initialize run: ${msg}`);
    return 1;
  }
}
