/**
 * `run-state step <start|complete|fail|halt> <step_id>` — step lifecycle mutations.
 *
 * Mirrors Python `cmd_step`. On StateError, exits 2 with the error message
 * on stderr (matches Python hook-blocking semantics).
 */

import {
  type StateData,
  StateError,
  stepComplete,
  stepFail,
  stepHalt,
  stepStart,
} from '../state';
import { printMutationResult } from './print-result';
import { type RunSelection, ResolveError, resolvePaths } from './resolve';

export type StepAction = 'start' | 'complete' | 'fail' | 'halt';

export interface StepFlags extends RunSelection {
  commit?: string;
  reason?: string;
  format?: 'md' | 'json';
}

export function runStep(action: StepAction, stepId: string, flags: StepFlags): number {
  if (!stepId) {
    console.error('error: the following arguments are required: step_id');
    return 1;
  }
  let resolved;
  try {
    resolved = resolvePaths(flags);
  } catch (err) {
    if (err instanceof ResolveError) {
      console.error(`error: ${err.message}`);
      return err.exitCode;
    }
    throw err;
  }

  let state: StateData;
  try {
    switch (action) {
      case 'start':
        state = stepStart(resolved.paths, stepId);
        break;
      case 'complete':
        state = stepComplete(resolved.paths, stepId, { commitSha: flags.commit ?? '' });
        break;
      case 'fail':
        state = stepFail(resolved.paths, stepId, { reason: flags.reason ?? '' });
        break;
      case 'halt':
        state = stepHalt(resolved.paths, stepId, { reason: flags.reason ?? '' });
        break;
    }
  } catch (err) {
    if (err instanceof StateError) {
      console.error(`error: ${err.message}`);
      return 2;
    }
    throw err;
  }

  printMutationResult(state, resolved.paths, flags.format ?? 'md');
  return 0;
}
