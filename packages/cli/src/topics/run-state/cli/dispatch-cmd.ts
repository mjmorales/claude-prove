/**
 * `run-state dispatch <record|has> <key> [<event>]` — reporter dedup ledger.
 *
 * Mirrors Python `cmd_dispatch`:
 *   - `record`: writes `"recorded"` + exit 0 on success, `"duplicate"` +
 *     exit 3 when the key already landed.
 *   - `has`: writes `"yes"` + exit 0 when present, `"no"` + exit 3 when
 *     absent (exit 3 lets bash callers branch with `if prove ... ; then`).
 */

import { dispatchHas, dispatchRecord } from '../state';
import { ResolveError, type RunSelection, resolvePaths } from './resolve';

export type DispatchAction = 'record' | 'has';

export interface DispatchFlags extends RunSelection {}

export function runDispatch(
  action: DispatchAction,
  key: string,
  event: string | undefined,
  flags: DispatchFlags,
): number {
  if (!key) {
    console.error('error: the following arguments are required: key');
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
  if (action === 'record') {
    if (!event) {
      console.error('error: the following arguments are required: event');
      return 1;
    }
    const recorded = dispatchRecord(resolved.paths, key, event);
    console.log(recorded ? 'recorded' : 'duplicate');
    return recorded ? 0 : 3;
  }
  // 'has'
  const present = dispatchHas(resolved.paths, key);
  console.log(present ? 'yes' : 'no');
  return present ? 0 : 3;
}
