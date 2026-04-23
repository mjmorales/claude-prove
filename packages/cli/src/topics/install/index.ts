/**
 * Register the `install` topic on the cac instance.
 *
 * Phase 10 splits the installer into independent subcommands, one per
 * responsibility. This file only registers the subcommands this task owns
 * (`install doctor`). Sibling tasks (4, 6) register `init*` and `upgrade`
 * on their own branches; the merge resolves into a single register list.
 */

import type { CAC } from 'cac';
import { registerDoctor } from './doctor';

export function register(cli: CAC): void {
  registerDoctor(cli);
}
