/**
 * `run-state task review <task_id> --verdict <v> [--notes ...] [--reviewer ...]`
 *
 * Mirrors Python `cmd_task`. Exit 2 on StateError (unknown task,
 * invalid verdict).
 */

import { StateError, taskReview } from '../state';
import { renderStateJson } from './render-fallback';
import { type RunSelection, ResolveError, resolvePaths } from './resolve';

export interface TaskReviewFlags extends RunSelection {
  verdict?: string;
  notes?: string;
  reviewer?: string;
  format?: 'md' | 'json';
}

export function runTaskReview(taskId: string, flags: TaskReviewFlags): number {
  if (!taskId) {
    console.error('error: the following arguments are required: task_id');
    return 1;
  }
  if (!flags.verdict) {
    console.error('error: the following arguments are required: --verdict');
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
  try {
    const state = taskReview(resolved.paths, taskId, {
      verdict: flags.verdict,
      notes: flags.notes ?? '',
      reviewer: flags.reviewer ?? '',
    });
    if ((flags.format ?? 'md') === 'json') {
      console.log(JSON.stringify(state, null, 2));
    } else {
      process.stdout.write(renderStateJson(state));
    }
    return 0;
  } catch (err) {
    if (err instanceof StateError) {
      console.error(`error: ${err.message}`);
      return 2;
    }
    throw err;
  }
}
