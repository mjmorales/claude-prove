/**
 * `run-state validator set <step_id> <phase> <status>` — validator summary set.
 *
 * Mirrors Python `cmd_validator`. Invalid phase/status are flagged by
 * `validatorSet` itself with StateError (exit 2).
 */

import { StateError, validatorSet } from '../state';
import { printMutationResult } from './print-result';
import { ResolveError, type RunSelection, resolvePaths } from './resolve';

export interface ValidatorFlags extends RunSelection {
  format?: 'md' | 'json';
}

export function runValidatorSet(
  stepId: string,
  phase: string,
  status: string,
  flags: ValidatorFlags,
): number {
  if (!stepId || !phase || !status) {
    console.error('error: the following arguments are required: step_id, phase, status');
    return 1;
  }
  let resolved: ReturnType<typeof resolvePaths>;
  try {
    resolved = resolvePaths(flags);
  } catch (err) {
    if (err instanceof ResolveError) {
      console.error(`error: ${err.message}`);
      return err.exitCode;
    }
    throw err;
  }
  try {
    const state = validatorSet(resolved.paths, stepId, phase, status);
    printMutationResult(state, resolved.paths, flags.format ?? 'md');
    return 0;
  } catch (err) {
    if (err instanceof StateError) {
      console.error(`error: ${err.message}`);
      return 2;
    }
    throw err;
  }
}
